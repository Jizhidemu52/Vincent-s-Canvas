import { describe, expect, spyOn, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Database } from "../src/db";
import * as chatBilling from "../src/chat-billing";
import * as providerTransport from "../src/provider-submission-transport";
import { ChatProtocolError, createChatRouter } from "../src/routes/chat";
import { encryptSecret } from "../src/security";

const privateDetail = "https://proxy-user:proxy-password@proxy.invalid bearer private-provider-token";

async function failedChat(error: unknown, afterHeaders = false, modelId = "claude-sonnet-5-5", responseFactory?: () => Response) {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const usageWrites: Array<{ sql: string; values: unknown[] }> = [];
    const db = { query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith("INSERT INTO usage_chat_requests") || sql.startsWith("UPDATE usage_chat_requests")) {
            usageWrites.push({ sql, values }); return { rows: [] };
        }
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "gpt-chat", modelConfigId: "chat-model", enabled: true, creditCostOverride: 4, rmbCostOverride: 0, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs")) return { rows: [{
            id: "chat-model", modelId, enabled: true, providerEnabled: true, capabilities: ["chat"],
            model_id: modelId, protocol: "apimart", base_url: "https://never-called.invalid/v1",
            encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "private-provider-token" }), encryptionKey),
        }] };
        if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
        throw new Error(`Unexpected fixture SQL: ${sql}`);
    } } as unknown as Database;
    const settlements: Array<{ reservationId: string | null; success: boolean }> = [];
    const begin = spyOn(chatBilling, "beginChatBilling").mockResolvedValue("held-chat-fixture");
    const finish = spyOn(chatBilling, "finishChatBilling").mockImplementation(async (_db, reservationId, success) => { settlements.push({ reservationId, success }); });
    const log = spyOn(console, "error").mockImplementation(() => {});
    const upstream = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async () => {
        if (responseFactory) return responseFactory();
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
        else {
            console.error(caught);
            response.status(500).json({ error: "INTERNAL_ERROR", message: "服务器处理失败" });
        }
    }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const response = await fetch(`http://127.0.0.1:${address.port}/chat/responses`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: "fixture-request", toolKey: "gpt-chat", input: [{ role: "user", content: "private-source-prompt" }], tools: [], claude: { stream: true } }),
            signal: AbortSignal.timeout(5_000),
        });
        const text = await response.text();
        return { status: response.status, text, settlements, forwarded, usageWrites, upstreamCalls: upstream.mock.calls.length, logs: log.mock.calls.map(args => [...args]) };
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        upstream.mockRestore();
        log.mockRestore();
        finish.mockRestore();
        begin.mockRestore();
    }
}

function expectSafeFailureLog(result: Awaited<ReturnType<typeof failedChat>>, code: string, phase: string, name = "Error") {
    expect(result.logs).toEqual([["Chat request failed", { code, name, phase, elapsedMs: expect.any(Number) }]]);
    const metadata = result.logs[0]![1] as { elapsedMs: number };
    expect(Number.isFinite(metadata.elapsedMs)).toBe(true);
    expect(metadata.elapsedMs).toBeGreaterThanOrEqual(0);
    const observable = result.text + JSON.stringify(result.logs);
    for (const privateValue of ["proxy-user", "proxy-password", "private-provider-token", "private-source-prompt", "never-called.invalid", "proxy.invalid"]) {
        expect(observable).not.toContain(privateValue);
    }
}

describe("chat route transport failure classification", () => {
    test.each([400, 408, 409, 429, 500, 503, 504])("HTTP %s refunds only a definitive provider rejection", async status => {
        const result = await failedChat(undefined, false, "claude-sonnet-5-5", () => Response.json({ error: privateDetail }, { status }));
        expect(result.status).toBe(502);
        expect(result.upstreamCalls).toBe(1);
        expect(result.settlements).toEqual([400, 429].includes(status) ? [{ reservationId: "held-chat-fixture", success: false }] : []);
        expect(result.text).not.toContain(privateDetail);
        if (![400, 429].includes(status)) expect(result.text).toContain("结果待核查");
    });
    for (const phase of ["initial_tls", "preflight", "http_started", "response"] as const) {
        test(`${phase} returns a safe upstream error without losing submission state or refunding twice`, async () => {
            const code = phase === "preflight" ? "UNSUPPORTED_NODE_RUNTIME" : "ECONNRESET";
            const transportError = Object.assign(new Error(privateDetail), { code, phase, attempts: 1, proxy: privateDetail });
            const result = await failedChat(new Error(`Wrapper ${privateDetail}`, { cause: transportError }));
            expect(result.status).toBe(502);
            expect(result.usageWrites).toHaveLength(2);
            expect(result.usageWrites[0]!.values.slice(1, 5)).toEqual(["fixture-user", "chat-model", "gpt-chat", "private-source-prompt"]);
            expect(result.usageWrites[1]!.values).toEqual([result.usageWrites[0]!.values[0], "failed"]);
            const body = JSON.parse(result.text);
            expect(body.error).toBe("UPSTREAM_REQUEST_FAILED");
            expect(body.message).toContain(phase === "initial_tls" || phase === "preflight" ? "尚未发送" : "结果待核查");
            if (phase === "http_started" || phase === "response") expect(body.message).toContain("不会自动重新提交");
            if (phase === "http_started") expect(body.message).toContain("请求可能已发出");
            expect(result.text).not.toContain("proxy-user");
            expect(result.text).not.toContain("private-provider-token");
            expectSafeFailureLog(result, code, phase);
            expect(result.settlements).toEqual(phase === "initial_tls" || phase === "preflight"
                ? [{ reservationId: "held-chat-fixture", success: false }] : []);
            expect(result.upstreamCalls).toBe(1);
        });
    }

    test.each(["gpt-6-astra", "gpt-6-sol"])("%s response interruption retains its hold pending verification", async modelId => {
        const error = Object.assign(new Error(privateDetail), { code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1 });
        const result = await failedChat(error, true, modelId);
        expect(result.status).toBe(502);
        expect(JSON.parse(result.text).error).toBe("UPSTREAM_REQUEST_FAILED");
        expect(result.text).toContain("结果待核查");
        expect(result.text).toContain("不会自动重新提交");
        expect(result.text).not.toContain("proxy-user");
        expect(result.text).not.toContain("private-provider-token");
        expectSafeFailureLog(result, "PROVIDER_RESPONSE_STREAM_ERROR", "response");
        expect(result.settlements).toEqual([]);
        expect(result.upstreamCalls).toBe(1);
    });

    test("an unclassified reset retains 500 without claiming a safe phase or forwarding raw provider errors", async () => {
        const error = Object.assign(new Error(privateDetail), { code: "ECONNRESET" });
        const result = await failedChat(error);
        expect(result.status).toBe(500);
        expect(JSON.parse(result.text)).toEqual({ error: "INTERNAL_ERROR", message: "服务器处理失败" });
        expect(result.forwarded).toEqual([]);
        expectSafeFailureLog(result, "ECONNRESET", "request");
        expect(result.settlements).toEqual([]);
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
        expectSafeFailureLog(result, diagnosed ? "PROVIDER_RESPONSE_STREAM_ERROR" : "UNCLASSIFIED_ERROR", "response");
        expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: true }]);
        expect(result.upstreamCalls).toBe(1);
    });
});

describe("chat route request timeout classification", () => {
    test.each([false, true])("a real timeout before client headers returns 504 without replay (wrapped=%s)", async wrapped => {
        const timeout = new DOMException(privateDetail, "TimeoutError");
        const error = wrapped ? new Error(privateDetail, { cause: new Error(privateDetail, { cause: timeout }) }) : timeout;
        const result = await failedChat(error);
        expect(result.status).toBe(504);
        const body = JSON.parse(result.text);
        expect(body.error).toBe("CHAT_REQUEST_TIMEOUT");
        expect(body.message).toContain("180 秒");
        expect(body.message).toContain("本轮对话未完成");
        expect(body.message).toContain("不会自动重新提交");
        expect(body.message).not.toContain("尚未发送");
        expect(result.forwarded).toEqual([]);
        expectSafeFailureLog(result, "CHAT_REQUEST_TIMEOUT", "request", "TimeoutError");
        expect(result.settlements).toEqual([]);
        expect(result.upstreamCalls).toBe(1);
    });

    test("a timeout after partial SSE is distinct from a reset and takes precedence over transport wrapping", async () => {
        const error = Object.assign(new Error(privateDetail, { cause: new DOMException(privateDetail, "TimeoutError") }), {
            code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1,
        });
        const result = await failedChat(error, true);
        expect(result.status).toBe(200);
        expect(result.text).toContain("partial fixture answer");
        expect(result.text).toContain('"code":"CHAT_REQUEST_TIMEOUT"');
        expect(result.text).toContain("180 秒");
        expect(result.text).toContain("本轮对话未完成");
        expect(result.text).toContain("不会自动重新提交");
        expect(result.text).not.toContain("结果待核查");
        expect(result.text).not.toContain("尚未发送");
        expect(result.forwarded).toEqual([]);
        expectSafeFailureLog(result, "CHAT_REQUEST_TIMEOUT", "response", "TimeoutError");
        expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: true }]);
        expect(result.upstreamCalls).toBe(1);
    });

    test.each(["gpt-6-astra", "gpt-6-sol"])("%s response-body timeout is not erased by JSON parsing", async modelId => {
        const result = await failedChat(new Error(privateDetail, { cause: new DOMException(privateDetail, "TimeoutError") }), true, modelId);
        expect(result.status).toBe(504);
        expect(JSON.parse(result.text).error).toBe("CHAT_REQUEST_TIMEOUT");
        expect(result.text).toContain("180 秒");
        expect(result.text).not.toContain("尚未发送");
        expectSafeFailureLog(result, "CHAT_REQUEST_TIMEOUT", "request", "TimeoutError");
        expect(result.settlements).toEqual([]);
        expect(result.upstreamCalls).toBe(1);
    });

    test("a pre-HTTP TLS connection timeout retains its proven submission phase", async () => {
        const error = Object.assign(new Error(privateDetail), { code: "PROVIDER_CONNECT_TIMEOUT", phase: "initial_tls", attempts: 2 });
        const result = await failedChat(error);
        expect(result.status).toBe(502);
        expect(JSON.parse(result.text).error).toBe("UPSTREAM_REQUEST_FAILED");
        expect(result.text).toContain("尚未发送");
        expect(result.text).not.toContain("180 秒");
        expectSafeFailureLog(result, "PROVIDER_CONNECT_TIMEOUT", "initial_tls");
        expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: false }]);
        expect(result.upstreamCalls).toBe(1);
    });

    test.each(["message", "string", "cycle", "throwing getter", "abort"])("does not infer a request timeout from %s", async kind => {
        let error: unknown = new Error(`timeout TimeoutError ${privateDetail}`);
        if (kind === "string") error = `TimeoutError ${privateDetail}`;
        if (kind === "cycle") Object.assign(error as Error, { cause: error });
        if (kind === "throwing getter") Object.defineProperty(error, "cause", { get() { throw new Error(privateDetail); } });
        if (kind === "abort") error = new DOMException(privateDetail, "AbortError");
        const result = await failedChat(error);
        expect(result.status).toBe(500);
        expect(JSON.parse(result.text).error).toBe("INTERNAL_ERROR");
        expect(result.forwarded).toEqual([]);
        expect(result.text).not.toContain("180 秒");
        expectSafeFailureLog(result, "UNCLASSIFIED_ERROR", "request", kind === "abort" ? "AbortError" : kind === "string" ? "UnknownError" : "Error");
        expect(result.settlements).toEqual([]);
        expect(result.upstreamCalls).toBe(1);
    });

    test.each([
        { name: "empty terminal", wire: 'data: {"type":"message_stop"}\n\n', settlement: false },
        { name: "partial EOF", wire: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n', settlement: true },
        { name: "invalid event", wire: 'data: not-json\n\n', settlement: null },
    ])("$name reports incomplete output, not the 180-second timeout", async ({ wire, settlement }) => {
        const result = await failedChat(undefined, false, "claude-sonnet-5-5", () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
        expect(result.status).toBe(200);
        expect(result.text).toContain('"code":"CHAT_STREAM_INCOMPLETE"');
        expect(result.text).toContain("本轮对话未完成");
        expect(result.text).not.toContain("180 秒");
        expect(result.text).not.toContain("结果待核查");
        expectSafeFailureLog(result, "CHAT_STREAM_INCOMPLETE", "response", "ChatProtocolError");
        expect(result.settlements).toEqual(settlement === null ? [] : [{ reservationId: "held-chat-fixture", success: settlement }]);
        expect(result.upstreamCalls).toBe(1);
    });

    test("complete SSE remains successful when its intentional cancellation rejects", async () => {
        const wire = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"complete answer"}}\n\ndata: {"type":"message_stop"}\n\n';
        let cancellations = 0;
        const result = await failedChat(undefined, false, "claude-sonnet-5-5", () => new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode(wire)); },
            cancel() { cancellations++; throw new DOMException(privateDetail, "TimeoutError"); },
        }), { headers: { "content-type": "text/event-stream" } }));
        expect(result.status).toBe(200);
        expect(result.text).toBe(wire);
        expect(result.logs).toEqual([]);
        expect(result.forwarded).toEqual([]);
        expect(result.settlements).toEqual([{ reservationId: "held-chat-fixture", success: true }]);
        expect(result.upstreamCalls).toBe(1);
        expect(cancellations).toBe(1);
    });
});
