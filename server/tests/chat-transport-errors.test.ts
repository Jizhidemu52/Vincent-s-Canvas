import { describe, expect, spyOn, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Database } from "../src/db";
import * as chatBilling from "../src/chat-billing";
import * as providerTransport from "../src/provider-submission-transport";
import { ChatProtocolError, createChatRouter } from "../src/routes/chat";
import { encryptSecret } from "../src/security";

const privateDetail = "https://proxy-user:proxy-password@proxy.invalid bearer private-provider-token";

async function failedChat(error: unknown, afterHeaders = false, modelId = "claude-sonnet-5-5") {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const db = { query: async (sql: string) => {
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "gpt-chat", modelConfigId: "chat-model", enabled: true, creditCostOverride: 4, rmbCostOverride: 0, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs")) return { rows: [{
            id: "chat-model", modelId, enabled: true, providerEnabled: true, capabilities: ["chat"],
            model_id: modelId, protocol: "apimart", base_url: "https://never-called.invalid/v1",
            encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "private-provider-token" }), encryptionKey),
        }] };
        throw new Error(`Unexpected fixture SQL: ${sql}`);
    } } as unknown as Database;
    const settlements: Array<{ reservationId: string | null; success: boolean }> = [];
    const begin = spyOn(chatBilling, "beginChatBilling").mockResolvedValue("held-chat-fixture");
    const finish = spyOn(chatBilling, "finishChatBilling").mockImplementation(async (_db, reservationId, success) => { settlements.push({ reservationId, success }); });
    const log = spyOn(console, "error").mockImplementation(() => {});
    const upstream = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async () => {
        if (!afterHeaders) throw error;
        let started = false;
        return new Response(new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (!started) {
                    started = true;
                    controller.enqueue(new TextEncoder().encode(modelId === "claude-sonnet-5-5"
                        ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial fixture answer"}}\n\n'
                        : '{"output":['));
                    return;
                }
                await new Promise<void>(resolve => setImmediate(resolve));
                controller.error(error);
            },
        }), { headers: { "content-type": modelId === "claude-sonnet-5-5" ? "text/event-stream" : "application/json" } });
    });
    const forwarded: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: "fixture-user", role: "designer", departmentId: null } }); next(); });
    app.use("/chat", createChatRouter(db, { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never));
    // Match the existing index.ts classification without importing its live services.
    app.use(((caught, _request, response, _next) => {
        forwarded.push(caught);
        if (caught instanceof ChatProtocolError) response.status(caught.code === "UPSTREAM_REQUEST_FAILED" ? 502 : 400).json({ error: caught.code, message: caught.message });
        else response.status(500).json({ error: "INTERNAL_ERROR", message: "服务器处理失败" });
    }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const response = await fetch(`http://127.0.0.1:${address.port}/chat/responses`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: "fixture-request", toolKey: "gpt-chat", input: [{ role: "user", content: "Local fixture only" }], tools: [], claude: { stream: true } }),
            signal: AbortSignal.timeout(5_000),
        });
        const text = await response.text();
        return { status: response.status, text, settlements, forwarded, upstreamCalls: upstream.mock.calls.length, logs: log.mock.calls.map(args => [...args]) };
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        upstream.mockRestore();
        log.mockRestore();
        finish.mockRestore();
        begin.mockRestore();
    }
}

describe("chat route transport failure classification", () => {
    for (const phase of ["initial_tls", "preflight", "http_started", "response"] as const) {
        test(`${phase} returns a safe upstream error without losing submission state or refunding twice`, async () => {
            const code = phase === "preflight" ? "UNSUPPORTED_NODE_RUNTIME" : "ECONNRESET";
            const transportError = Object.assign(new Error(privateDetail), { code, phase, attempts: 1, proxy: privateDetail });
            const result = await failedChat(new Error(`Wrapper ${privateDetail}`, { cause: transportError }));
            expect(result.status).toBe(502);
            const body = JSON.parse(result.text);
            expect(body.error).toBe("UPSTREAM_REQUEST_FAILED");
            expect(body.message).toContain(phase === "initial_tls" || phase === "preflight" ? "尚未发送" : "结果待核查");
            if (phase === "http_started" || phase === "response") expect(body.message).toContain("不会自动重新提交");
            if (phase === "http_started") expect(body.message).toContain("请求可能已发出");
            expect(result.text).not.toContain("proxy-user");
            expect(result.text).not.toContain("private-provider-token");
            expect(result.logs).toEqual([["Chat provider transport failed", { code, phase, attempts: 1 }]]);
            expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: false }]);
            expect(result.upstreamCalls).toBe(1);
        });
    }

    test.each(["gpt-6-astra", "gpt-6-sol"])("%s response interruption reaches safe diagnostics and refunds once", async modelId => {
        const error = Object.assign(new Error(privateDetail), { code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1 });
        const result = await failedChat(error, true, modelId);
        expect(result.status).toBe(502);
        expect(JSON.parse(result.text).error).toBe("UPSTREAM_REQUEST_FAILED");
        expect(result.text).toContain("结果待核查");
        expect(result.text).toContain("不会自动重新提交");
        expect(result.text).not.toContain("proxy-user");
        expect(result.text).not.toContain("private-provider-token");
        expect(result.logs).toEqual([["Chat provider transport failed", { code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1 }]]);
        expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: false }]);
        expect(result.upstreamCalls).toBe(1);
    });

    test("an unclassified reset remains an unknown server error instead of claiming a safe transport phase", async () => {
        const error = Object.assign(new Error(privateDetail), { code: "ECONNRESET" });
        const result = await failedChat(error);
        expect(result.status).toBe(500);
        expect(JSON.parse(result.text)).toEqual({ error: "INTERNAL_ERROR", message: "服务器处理失败" });
        expect(result.forwarded).toEqual([error]);
        expect(result.logs).toEqual([]);
        expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: false }]);
        expect(result.upstreamCalls).toBe(1);
    });

    test.each([true, false])("an interrupted stream never recommends a blind retry (diagnosed=%s)", async diagnosed => {
        const error = diagnosed
            ? Object.assign(new Error(privateDetail), { code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1 })
            : new Error(privateDetail);
        const result = await failedChat(error, true);
        expect(result.status).toBe(200);
        expect(result.text).toContain("partial fixture answer");
        expect(result.text).toContain("event: error");
        expect(result.text).toContain("结果待核查");
        expect(result.text).toContain("不会自动重新提交");
        expect(result.text).not.toContain("请重试");
        expect(result.text).not.toContain("proxy-user");
        expect(result.text).not.toContain("private-provider-token");
        expect(result.forwarded).toEqual([]);
        expect(result.logs).toEqual(diagnosed ? [["Chat provider transport failed", { code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1 }]] : []);
        expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: false }]);
        expect(result.upstreamCalls).toBe(1);
    });
});
