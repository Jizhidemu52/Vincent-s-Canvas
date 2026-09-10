import { expect, test } from "bun:test";
import { chatFunctionToolsSchema } from "../src/routes/chat";

test("chat accepts declared client function plans and defaults to no tools", () => {
    expect(chatFunctionToolsSchema.parse(undefined)).toEqual([]);
    const tool = { type: "function" as const, name: "create_image", parameters: { type: "object", properties: { prompt: { type: "string" } } }, strict: false };
    expect(chatFunctionToolsSchema.parse([tool])).toEqual([tool]);
});

test.each(["image_generation", "web_search_preview", "computer", "mcp"])("chat cannot execute unconfigured hosted %s tools", (type) => {
    expect(chatFunctionToolsSchema.safeParse([{ type, name: "create_image", parameters: {} }]).success).toBe(false);
});

test("chat rejects malformed or expanded function definitions before contacting any provider", () => {
    expect(chatFunctionToolsSchema.safeParse([{ type: "function", name: "create_image", parameters: {}, model: "gpt-image-2.5" }]).success).toBe(false);
    expect(chatFunctionToolsSchema.safeParse([{ type: "function", name: "", parameters: {} }]).success).toBe(false);
    expect(chatFunctionToolsSchema.safeParse([{ type: "function", name: "create_image", parameters: "{}" }]).success).toBe(false);
});
