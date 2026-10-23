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
        if (sql.startsWith("INSERT INTO usage_chat_requests") || sql.startsWith("UPDATE usage_chat_requests")) return { rows: [] };
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

test.each([false, true, undefined])("APIMart Sonnet honors requested JSON mode and preserves tool continuation (thinking=%s)", async thinking => {
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
        if (thinking === false) expect(calls[0]!.output_config).toEqual({ effort: "low" });
        else expect(calls[0]!).not.toHaveProperty("output_config");
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
        expect(calls[1]!).not.toHaveProperty("thinking");
        if (thinking === false) expect(calls[1]!.output_config).toEqual({ effort: "low" });
        else expect(calls[1]!).not.toHaveProperty("output_config");
        expect(settlements).toEqual([true, true]);
    });
});

for (const stream of [false, true]) {
    test.each([false, true, undefined])(`Sonnet effort selection preserves all instructions and tools (stream=${stream}, thinking=%s)`, async thinking => {
        const constraints = '保留七颗纽扣和原有版型；只改为蓝色；字样 "COTTON" 不变。\n不要删减约束。🧶';
        const inputSchema = { type: "object", properties: { image_ids: { type: "array", items: { type: "string" } } }, required: ["image_ids"], additionalProperties: false };
        await withChatRoute("apimart", body => body.stream
            ? new Response(events, { headers: { "content-type": "text/event-stream" } })
            : Response.json({ content: [{ type: "text", text: "约束已保留。" }], stop_reason: "end_turn" }), async (post, calls, settlements) => {
            const response = await post({
                input: [{ role: "system", content: constraints }, { role: "user", content: "请先检查图片，不要直接生成。" }],
                tools: [{ type: "function", name: "inspect_images", description: "只读查看原图，不得替换原图。", parameters: inputSchema }],
                claude: { stream, thinking, maxTokens: 2048 },
            });
            expect(response.status).toBe(200);
            await response.text();
            expect(calls).toEqual([{
                model: "claude-sonnet-5-5",
                system: constraints,
                messages: [{ role: "user", content: "请先检查图片，不要直接生成。" }],
                max_tokens: 2048,
                tools: [{ name: "inspect_images", description: "只读查看原图，不得替换原图。", input_schema: inputSchema }],
                tool_choice: { type: "auto" },
                ...(stream ? { stream: true } : {}),
                ...(thinking === false ? { output_config: { effort: "low" } } : {}),
            }]);
            expect(calls[0]!).not.toHaveProperty("thinking");
            expect(settlements).toEqual([true]);
        });
    });
}

test.each([false, true])("APIMart Sonnet failure is not replayed in another response mode (stream=%s)", async stream => {
    await withChatRoute("apimart", () => Response.json({ error: "Bearer private-provider-token" }, { status: 503 }), async (post, calls, settlements) => {
        const response = await post({ claude: { stream } });
        expect(response.status).toBe(502);
        const body = await response.json();
        expect(body.error).toBe("UPSTREAM_REQUEST_FAILED");
        expect(body.message).not.toContain("private-provider-token");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.stream).toBe(stream ? true : undefined);
        expect(settlements).toEqual([]);
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

test.each([
    { name: "nonempty message_stop", wire: events, splitBytes: false, billable: true, complete: true },
    { name: "byte-split CRLF message_stop", wire: events.replaceAll("\n", "\r\n"), splitBytes: true, billable: true, complete: true },
    { name: "empty message_stop", wire: 'event: message_stop\ndata: {"type":"message_stop"}\n\n', splitBytes: false, billable: false, complete: false },
    { name: "error after text", wire: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n', splitBytes: false, billable: true, complete: false },
])("Sonnet finishes and cancels an open upstream on $name without replay", async ({ wire, splitBytes, billable, complete }) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let cancellations = 0;
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream<Uint8Array>({
        start(value) {
            controller = value;
            if (splitBytes) for (const byte of bytes) value.enqueue(new Uint8Array([byte]));
            else value.enqueue(bytes);
            // Deliberately no close(): the provider keeps HTTP alive after SSE completion.
        },
        cancel() { cancellations++; },
    });
    await withChatRoute("apimart", () => new Response(body, { headers: { "content-type": "text/event-stream" } }), async (post, calls, settlements) => {
        const response = await post({});
        const read = response.text();
        try {
            const endedBeforeEOF = await Promise.race([
                read.then(() => true),
                Bun.sleep(400).then(() => false),
            ]);
            expect(endedBeforeEOF).toBe(true);
            const received = await read;
            if (complete) expect(received).toBe(wire);
            else {
                expect(received).toStartWith(wire);
                expect(received).toContain("event: error");
            }
            expect(cancellations).toBe(1);
            expect(calls).toHaveLength(1);
            expect(settlements).toEqual([billable]);
        } finally {
            if (!cancellations) controller!.close();
            await read.catch(() => {});
        }
    });
});
