import { expect, spyOn, test } from "bun:test";
import type { Database } from "../src/db";
import * as billing from "../src/chat-billing";
import * as transport from "../src/provider-submission-transport";
import { createChatRouter } from "../src/routes/chat";
import { encryptSecret } from "../src/security";

const textEvent = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"有效回复"}}\n\n';
const stopEvent = 'data: {"type":"message_stop"}\n\n';
const encoder = new TextEncoder();

async function runChat(options: {
    stream?: boolean;
    input?: unknown[];
    beforeSubmission?: boolean;
    disconnectOnRead?: boolean;
    disconnectAfterWrite?: boolean;
    wire?: string;
    auditFailure?: boolean;
    settlementFailure?: boolean;
} = {}) {
    const key = Buffer.alloc(32, 8).toString("base64");
    const request = {
        body: { requestId: "disconnect-fixture", toolKey: "gpt-chat", tools: [], input: options.input ?? [{ role: "user", content: "hello" }], claude: { stream: options.stream !== false } },
        auth: { id: "fixture-user", role: "designer", departmentId: null },
        socket: { remoteAddress: "127.0.0.1" as string | undefined, destroyed: false },
        aborted: false, ip: "127.0.0.1",
    };
    const written: string[] = [];
    const response = {
        destroyed: false, headersSent: false,
        setHeader() {},
        write(value: Uint8Array) {
            response.headersSent = true;
            written.push(new TextDecoder().decode(value));
            if (options.disconnectAfterWrite) request.socket.remoteAddress = undefined;
        },
        end(value?: string) { if (value) written.push(value); },
        status() { return response; },
        json(value: unknown) { written.push(JSON.stringify(value)); },
    };
    const db = { query: async (sql: string) => {
        if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
        if (sql.includes("FROM tool_api_configurations")) return { rows: [{ toolKey: "gpt-chat", modelConfigId: "chat-model", enabled: true, creditCostOverride: 4, rmbCostOverride: 0, configurationVersion: 1 }] };
        if (sql.includes("FROM credit_policy")) return { rows: [{ creditsEnabled: true }] };
        if (sql.includes("FROM model_configs")) return { rows: [{ id: "chat-model", modelId: "claude-sonnet-5-5", enabled: true, providerEnabled: true, capabilities: ["chat"], model_id: "claude-sonnet-5-5", protocol: "apimart", base_url: "https://never-called.invalid/v1", encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "fixture-private-key" }), key) }] };
        if (sql.includes("INSERT INTO audit_logs") && options.auditFailure) throw new Error("Fixture audit outage");
        if (sql.includes("audit_logs") || sql.includes("usage_chat_requests")) return { rows: [] };
        throw new Error(`Unexpected fixture SQL: ${sql}`);
    } } as unknown as Database;
    const settlements: boolean[] = [];
    const begin = spyOn(billing, "beginChatBilling").mockImplementation(async () => {
        if (options.beforeSubmission) request.socket.remoteAddress = undefined;
        return "held-chat-fixture";
    });
    const finish = spyOn(billing, "finishChatBilling").mockImplementation(async (_db, _id, success) => {
        settlements.push(success);
        if (options.settlementFailure) throw new Error("Fixture settlement outage");
    });
    const upstream = spyOn(transport, "fetchProviderSubmission").mockImplementation(async () => {
        if (options.disconnectOnRead) request.socket.remoteAddress = undefined;
        if (options.stream === false) return Response.json({ content: [{ type: "text", text: "有效回复" }], stop_reason: "end_turn" });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(encoder.encode(options.wire ?? textEvent));
            controller.enqueue(encoder.encode(stopEvent));
            controller.close();
        } }), { headers: { "content-type": "text/event-stream" } });
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
        const router = createChatRouter(db, { AUTH_ENABLED: "true", CREDITS_ENABLED: "true", PROVIDER_ENCRYPTION_KEY: key } as never);
        const handler = router.stack.find(layer => layer.route?.path === "/responses")!.route!.stack[0]!.handle;
        const errors: unknown[] = [];
        await handler(request as never, response as never, (error?: unknown) => { if (error) errors.push(error); });
        return { settlements, calls: upstream.mock.calls.length, written: written.join(""), errors, logs: log.mock.calls.map(args => [...args]) };
    } finally { log.mockRestore(); upstream.mockRestore(); finish.mockRestore(); begin.mockRestore(); }
}

test("disconnecting after useful streamed text cannot turn the paid output into a refund", async () => {
    const result = await runChat({ disconnectAfterWrite: true });
    expect(result.written).toContain("有效回复");
    expect(result.settlements).toEqual([true]);
    expect(result.calls).toBe(1);
});

test.each([true, false])("valid output already returned by the provider is billed even if its client disconnected (stream=%s)", async stream => {
    const result = await runChat({ disconnectOnRead: true, stream });
    expect(result.settlements).toEqual([true]);
    expect(result.calls).toBe(1);
});

test("disconnecting without observed output leaves an uncertain submitted request held", async () => {
    const result = await runChat({ disconnectAfterWrite: true, wire: 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"internal"}}\n\n' });
    expect(result.settlements).toEqual([]);
    expect(result.calls).toBe(1);
});

test("a pre-submission disconnect releases once without invoking the provider", async () => {
    const result = await runChat({ beforeSubmission: true });
    expect(result.settlements).toEqual([false]);
    expect(result.calls).toBe(0);
});

test.each([true, false])("bookkeeping failure after useful output never refunds it (stream=%s)", async stream => {
    const result = await runChat({ auditFailure: true, stream });
    expect(result.settlements).toEqual([true]);
    expect(result.calls).toBe(1);
});

test("a failed capture never falls back to release or a second provider request", async () => {
    const result = await runChat({ settlementFailure: true });
    expect(result.settlements).toEqual([true]);
    expect(result.calls).toBe(1);
});

test("a locally rejected request releases its hold without pretending it was submitted", async () => {
    const result = await runChat({ input: [{ role: "user", content: [{ type: "input_image", image_url: "invalid-format" }] }] });
    expect(result.settlements).toEqual([false]);
    expect(result.calls).toBe(0);
});
