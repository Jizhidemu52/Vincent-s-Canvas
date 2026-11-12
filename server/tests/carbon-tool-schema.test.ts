import { afterEach, expect, test } from "bun:test";
import { buildImageAgentTools, parseImageAgentEdit } from "../src/image-agent-profile";
import { requestChatCompletion } from "../src/routes/chat";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const model = { model_id: "gemini-4-carbon", protocol: "apimart", base_url: "http://carbon-schema.invalid/v1", encrypted_credentials: null };
const input = { input: [{ role: "user" as const, content: "把米白色针织毛衫改成浅蓝色，只改颜色。" }], tools: buildImageAgentTools() };
const completed = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };

test("Carbon accepts the actual ImageAgent plan schema without the rejected uniqueItems wire keyword", async () => {
    let calls = 0;
    const originalTools = structuredClone(input.tools);
    globalThis.fetch = (async (url, init) => {
        calls++;
        expect(String(url)).toBe("http://carbon-schema.invalid/v1/chat/completions");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ model: "gemini-4-carbon", stream: false, tool_choice: "auto", parallel_tool_calls: false });
        expect(body.tools.map((tool: any) => tool.function.name)).toEqual(["edit_image", "look_at_images"]);
        if (body.tools.some((tool: any) => Object.values(tool.function.parameters.properties).some((field: any) => field.uniqueItems !== undefined))) {
            return Response.json({ error: { message: 'Unknown field: "uniqueItems"' } }, { status: 400 });
        }
        const expected = structuredClone(originalTools);
        delete (expected[0]!.parameters.properties as any).references.uniqueItems;
        delete (expected[1]!.parameters.properties as any).image_ids.uniqueItems;
        expect(body.tools).toEqual(expected.map(({ type, ...definition }) => ({ type, function: definition })));
        return Response.json(completed);
    }) as typeof fetch;
    expect(await requestChatCompletion(model, { apiKey: "fixture-only" }, input)).toMatchObject({ content: "OK" });
    expect(calls).toBe(1);
    expect(input.tools).toEqual(originalTools);
    expect(parseImageAgentEdit({ prompt: "只改颜色", references: ["ref1", "ref1"] }).references).toEqual(["ref1"]);
    expect(() => parseImageAgentEdit({ prompt: "", references: [] })).toThrow();
    expect(() => parseImageAgentEdit({ prompt: "只改颜色", references: Array(6).fill("ref1") })).toThrow();
});

test.each([
    { protocol: "apimart", model_id: "gpt-6-sol" },
    { protocol: "openai-chat", model_id: "gemini-4-carbon" },
])("other Chat Completions bindings retain the original schema: %j", async target => {
    globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.tools).toEqual(input.tools.map(({ type, ...definition }) => ({ type, function: definition })));
        return Response.json(completed);
    }) as typeof fetch;
    expect(await requestChatCompletion({ ...model, ...target }, {}, input)).toMatchObject({ content: "OK" });
});

test("Carbon schema traversal keeps a property named uniqueItems and arbitrary example/default values", async () => {
    const literal = { uniqueItems: true, type: "array", content: ["unchanged"] };
    const parameters = { type: "object", properties: {
        uniqueItems: { type: "string", description: "A real property, not a schema keyword" },
        nested: { type: "array", uniqueItems: true, items: { type: "object", properties: {
            ids: { anyOf: [{ type: "array", uniqueItems: true, items: { type: "string" } }, { type: "null" }] },
        } } },
    }, required: ["uniqueItems"], examples: [literal], default: literal, additionalProperties: false };
    const before = structuredClone(parameters);
    globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const expected = structuredClone(before);
        delete (expected.properties.nested as any).uniqueItems;
        delete (expected.properties.nested.items.properties.ids.anyOf[0] as any).uniqueItems;
        expect(body.tools[0].function.parameters).toEqual(expected);
        return Response.json(completed);
    }) as typeof fetch;
    await requestChatCompletion(model, {}, { input: input.input, tools: [{ type: "function", name: "schema_fixture", parameters }] });
    expect(parameters).toEqual(before);
});
