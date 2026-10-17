import { afterEach, describe, expect, test } from "bun:test";
import { DuplicateJsonKeyError, parseStrictJson } from "../src/lib/strict-json";
import { parseCreativeChatPlan } from "../src/lib/creative-chat";
import { readClaudeSseResponse, requestToolResponse } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reference = { id: "shirt", name: "shirt.png", type: "image/png", dataUrl: "data:image/png;base64,QQ==" };
const args = (preserve: string) => `{"action":"edit","prompt":"衣身改蓝色","target_image_id":"shirt",${preserve}}`;
const call = (raw: string) => ({ id: "call-one", type: "function" as const, function: { name: "create_image", arguments: raw } });

function toolStream(raw: string) {
    const halfway = Math.floor(raw.length / 2);
    const events = [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-one", name: "create_image", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw.slice(0, halfway) } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw.slice(halfway) } },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("strict JSON duplicate-key boundary", () => {
    test.each([
        '{"preserve":["领口不变"],"preserve":["白底不变"]}',
        '{"preserve":"领口不变","preserve":"白底不变"}',
        String.raw`{"preserve":[],"pre\u0073erve":[]}`,
        '{"reference_roles":[{"id":"one","id":"two"}]}',
        '{"__proto__":1,"__proto__":2}',
    ])("rejects duplicate keys within their object scope: %s", (raw) => {
        expect(() => parseStrictJson(raw)).toThrow(DuplicateJsonKeyError);
    });

    test("separate objects and string content are not duplicate property declarations", () => {
        const value = {
            preserve: ["领口不变", "七颗纽扣不变", "白底不变"],
            reference_roles: [{ image_id: "shirt", purpose: "主体" }, { image_id: "palette", purpose: "颜色" }],
            prompt: '字面文字："preserve":["a"],"preserve":["b"]；括号 { } 和转义 \\ 不改变 JSON 作用域',
        };
        expect(parseStrictJson(JSON.stringify(value))).toEqual(value);
        expect(parseStrictJson('{"same":{"same":1},"other":{"same":2}}')).toEqual({ same: { same: 1 }, other: { same: 2 } });
    });

    test.each(['{"a":1,}', '{"a":1 // comment\n}', '{"a":}', '{a:1}', ''])('does not widen native JSON syntax: %s', (raw) => {
        expect(() => parseStrictJson(raw)).toThrow(SyntaxError);
    });

    test("direct planner replay cannot bypass the strict boundary with duplicate arrays", () => {
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [call(args('"preserve":["领口不变"],"preserve":["白底不变"]'))] }, [reference])).toThrow(DuplicateJsonKeyError);
    });

    test.each([
        '"preserve":["领口不变"],"preserve":["白底不变"]',
        '"preserve":"七颗米白纽扣保持米白色","preserve":"翻领造型","preserve":"长袖版型和袖口","preserve":"门襟、缝线、衣摆","preserve":"面料纹理和褶皱","preserve":"衬衫比例与位置","preserve":"白色背景和阴影","preserve":"不添加口袋、文字、图案、Logo或装饰"',
        String.raw`"preserve":["领口不变"],"pre\u0073erve":["白底不变"]`,
    ])("native SSE rejects ambiguous raw arguments before normalization: %s", async (preserve) => {
        let executablePlans = 0;
        const pending = readClaudeSseResponse(toolStream(args(preserve))).then((result) => {
            parseCreativeChatPlan(result, [reference]);
            executablePlans += 1;
        });
        await expect(pending).rejects.toThrow(DuplicateJsonKeyError);
        expect(executablePlans).toBe(0);
    });

    test("native SSE preserves every valid constraint through the executable plan", async () => {
        const result = await readClaudeSseResponse(toolStream(args('"preserve":["领口形状不变","七颗纽扣不变","白底不变"]')));
        const plan = parseCreativeChatPlan(result, [reference]);
        expect(plan.kind).toBe("image");
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.lineage.preservedConstraints).toEqual(["领口形状不变", "七颗纽扣不变", "白底不变"]);
        plan.lineage.preservedConstraints.forEach((constraint) => expect(plan.prompt).toContain(constraint));
    });

    test("non-SSE raw tool arguments are checked without retries or image submission", async () => {
        const calls: string[] = [];
        globalThis.fetch = (async (url) => {
            if (String(url) === "/api/models") return Response.json({ models: [{ id: "strict-json-fixture", modelId: "strict-json-fixture", name: "fixture", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "strict-json-fixture", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] });
            calls.push(String(url));
            return Response.json({ content: "", toolCalls: [call(args('"preserve":["领口不变"],"preserve":["白底不变"]'))] });
        }) as typeof fetch;
        await expect(requestToolResponse({ ...defaultConfig, model: "strict-json-fixture", textModel: "strict-json-fixture", systemPrompt: "" }, [{ role: "user", content: "衣身改蓝色，其他不变" }], [])).rejects.toThrow(DuplicateJsonKeyError);
        expect(calls).toEqual(["/api/chat/responses"]);
    });
});
