import { describe, expect, test } from "bun:test";
import { beginChatBilling, ChatStreamOutcome } from "../src/chat-billing";
import type { Database } from "../src/db";
import type { ToolConfiguration } from "../src/tool-configuration";

const execution = { toolKey: "gpt-chat", modelConfigId: "model", enabled: true, creditCostOverride: 4, rmbCostOverride: 0, configurationVersion: 1 } satisfies ToolConfiguration & { modelConfigId: string };
const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`);

describe("optional chat billing", () => {
    test("disabled policy performs no pricing or wallet access", async () => {
        const db = { query: () => { throw new Error("Unexpected SQL"); } } as unknown as Database;
        expect(await beginChatBilling(db, { userId: "user", enabled: false, execution })).toBeNull();
    });

    test("enabled policy cannot use anonymous creation", async () => {
        await expect(beginChatBilling({} as Database, { userId: "guest", enabled: true, anonymous: true, execution })).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
    });

});

describe("billable Claude stream completion", () => {
    test("requires complete nonempty success, even across chunk and UTF-8 boundaries", () => {
        const stream = new ChatStreamOutcome();
        const bytes = new Uint8Array([...encode({ type: "content_block_delta", delta: { type: "text_delta", text: "您好" } }), ...encode({ type: "message_stop" })]);
        for (const byte of bytes) stream.push(new Uint8Array([byte]));
        expect(stream.successful).toBe(true);
    });

    test("counts a tool plan as successful, but not thinking-only, empty, errors or truncation", () => {
        const tool = new ChatStreamOutcome();
        tool.push(encode({ type: "content_block_start", content_block: { type: "tool_use", name: "canvas_get_state" } }));
        expect(tool.successful).toBe(false);
        tool.push(encode({ type: "message_stop" }));
        expect(tool.successful).toBe(true);
        tool.push(encode({ type: "error", error: { message: "failed" } }));
        expect(tool.successful).toBe(false);
        const empty = new ChatStreamOutcome();
        empty.push(encode({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "thought" } }));
        empty.push(encode({ type: "message_stop" }));
        expect(empty.successful).toBe(false);
    });
});
