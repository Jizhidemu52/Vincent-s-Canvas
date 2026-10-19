import { expect, spyOn, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Database } from "../src/db";
import * as chatBilling from "../src/chat-billing";
import * as providerTransport from "../src/provider-submission-transport";
import { ChatProtocolError, createChatRouter } from "../src/routes/chat";
import { encryptSecret } from "../src/security";

const nativeBlocks = [
    { type: "thinking", thinking: "", signature: "opaque-sonnet-signature" },
    { type: "text", text: "先检查针织结构。" },
    { type: "tool_use", id: "inspect-1", name: "inspect_images", input: { imageIds: ["garment"] } },
];
const events = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Native stream reply"}}\n\ndata: {"type":"message_stop"}\n\n';

async function withChatRoute(
    protocol: string,
    provider: (body: Record<string, any>) => Response,
    run: (post: (body: Record<string, unknown>) => Promise<Response>, calls: Record<string, any>[], settlements: boolean[]) => Promise<void>,
) {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const db = { query: async (sql: string) => {
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "gpt-chat", modelConfigId: "chat-model", enabled: true, creditCostOverride: 4, rmbCostOverride: 0, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs")) return { rows: [{
            id: "chat-model", modelId: "claude-sonnet-5-5", enabled: true, providerEnabled: true, capabilities: ["chat"],
            model_id: "claude-sonnet-5-5", protocol, base_url: "https://never-called.invalid/v1",
            encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "private-provider-token" }), encryptionKey),
        }] };
        if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
        throw new Error(`Unexpected fixture SQL: ${sql}`);
    } } as unknown as Database;
    const settlements: boolean[] = [];
    const calls: Record<string, any>[] = [];
    const begin = spyOn(chatBilling, "beginChatBilling").mockResolvedValue("held-chat-fixture");
    const finish = spyOn(chatBilling, "finishChatBilling").mockImplementation(async (_db, _reservationId, success) => { settlements.push(success); });
    const upstream = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        return provider(body);
    });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: "fixture-user", role: "designer", departmentId: null } }); next(); });
    app.use("/chat", createChatRouter(db, { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never));
    app.use(((error, _request, response, _next) => {
        response.status(error instanceof ChatProtocolError && error.code === "UPSTREAM_REQUEST_FAILED" ? 502 : 500).json({ error: error.code, message: error.message });
    }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${address.port}/chat/responses`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: "fixture-request", toolKey: "gpt-chat", input: [{ role: "user", content: "检查这件针织衫" }], tools: [], claude: { stream: true }, ...body }),
            signal: AbortSignal.timeout(5_000),
        });
        await run(post, calls, settlements);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        upstream.mockRestore();
        finish.mockRestore();
        begin.mockRestore();
    }
}

test.each([false, true])("APIMart Sonnet honors requested JSON mode and preserves tool continuation (thinking=%s)", async thinking => {
    const tools = [{ type: "function", name: "inspect_images", parameters: { type: "object", properties: { imageIds: { type: "array", items: { type: "string" } } } } }];
    await withChatRoute("apimart", body => {
        // The upstream sends SSE only when requested; this exposes a wrong route selection.
        if (body.stream) return new Response(events, { headers: { "content-type": "text/event-stream" } });
        return Response.json({ content: body.messages.length === 1 ? nativeBlocks : [{ type: "text", text: "针织结构已确认。" }], stop_reason: body.messages.length === 1 ? "tool_use" : "end_turn" });
    }, async (post, calls, settlements) => {
        const first = await post({ tools, claude: { stream: false, thinking, maxTokens: 4096 } });
        expect(first.status).toBe(200);
        expect(first.headers.get("content-type")).toContain("application/json");
        const result = await first.json();
        expect(result).toEqual({ content: "先检查针织结构。", toolCalls: [{ id: "inspect-1", type: "function", function: { name: "inspect_images", arguments: '{"imageIds":["garment"]}' } }], claudeAssistantContent: nativeBlocks, stopReason: "tool_use" });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.stream).not.toBe(true);
        expect(calls[0]!.max_tokens).toBe(4096);
        expect(calls[0]!.tools).toEqual([{ name: "inspect_images", input_schema: tools[0]!.parameters }]);
        expect(calls[0]!).not.toHaveProperty("thinking");
        expect(calls[0]!).not.toHaveProperty("output_config");
        const second = await post({ tools, claude: { stream: false, thinking }, input: [
            { role: "user", content: "检查这件针织衫" },
            { type: "claude_assistant", content: result.claudeAssistantContent },
            { type: "function_call_output", call_id: "inspect-1", output: "绞花针织，保留原结构。" },
        ] });
        expect(second.status).toBe(200);
        expect(second.headers.get("content-type")).toContain("application/json");
        expect(await second.json()).toEqual({ content: "针织结构已确认。", toolCalls: [], stopReason: "end_turn" });
        expect(calls).toHaveLength(2);
        expect(calls[1]!.stream).not.toBe(true);
        expect(calls[1]!.messages).toEqual([
            { role: "user", content: "检查这件针织衫" },
            { role: "assistant", content: nativeBlocks },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "inspect-1", content: "绞花针织，保留原结构。" }] },
        ]);
        expect(settlements).toEqual([true, true]);
    });
});

test.each([false, true])("APIMart Sonnet failure is not replayed in another response mode (stream=%s)", async stream => {
    await withChatRoute("apimart", () => Response.json({ error: "Bearer private-provider-token" }, { status: 503 }), async (post, calls, settlements) => {
        const response = await post({ claude: { stream } });
        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body.error).toBe("UPSTREAM_REQUEST_FAILED");
        expect(body.message).not.toContain("private-provider-token");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.stream).toBe(stream ? true : undefined);
        expect(settlements).toEqual([false]);
    });
});

test.each(["apimart", "anthropic"])("%s Sonnet honors the requested SSE mode", async protocol => {
    await withChatRoute(protocol, () => new Response(events, { headers: { "content-type": "text/event-stream" } }), async (post, calls, settlements) => {
        const response = await post({});
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(await response.text()).toBe(events);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.stream).toBe(true);
        expect(calls[0]!).not.toHaveProperty("thinking");
        expect(calls[0]!).not.toHaveProperty("output_config");
        expect(settlements).toEqual([true]);
    });
});
