import { afterEach, describe, expect, test } from "bun:test";
import { DuplicateJsonKeyError, parseStrictJson } from "../src/lib/strict-json";
import { parseCreativeChatInspection, parseCreativeChatPlan } from "../src/lib/creative-chat";
import { readClaudeSseResponse, requestToolResponse } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reference = { id: "shirt", name: "shirt.png", type: "image/png", dataUrl: "data:image/png;base64,QQ==" };
const args = (preserve: string) => `{"action":"edit","prompt":"衣身改蓝色","target_image_id":"shirt",${preserve}}`;
const call = (raw: string) => ({ id: "call-one", type: "function" as const, function: { name: "create_image", arguments: raw } });

function toolStream(raw: string, name = "create_image") {
    const halfway = Math.floor(raw.length / 2);
    const events = [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-one", name, input: {} } },
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

    test("native SSE rejects duplicate keys in a complete content_block_start input", async () => {
        const raw = `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-one","name":"create_image","input":${args('"preserve":"领口不变","preserve":"白底不变"')}}}`;
        const response = new Response(`data: ${raw}\n\n`, { headers: { "content-type": "text/event-stream" } });
        await expect(readClaudeSseResponse(response)).rejects.toThrow(DuplicateJsonKeyError);
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

describe("create_image duplicate preserve recovery", () => {
    // Preserve values captured from the real two-image Claude response; IDs and
    // prompt use the local replay fixture so no image or model request is needed.
    const observed = args('"preserve":"针织衫保持米白底色配浅蓝与粉色小碎花的基调","preserve":"搭配米色裤装"');

    test("recovers both observed constraints before inspection and final planning", async () => {
        const result = await readClaudeSseResponse(toolStream(observed));
        const expected = ["针织衫保持米白底色配浅蓝与粉色小碎花的基调", "搭配米色裤装"];
        expect(parseStrictJson(result.toolCalls[0]!.function.arguments)).toEqual({
            action: "edit", prompt: "衣身改蓝色", target_image_id: "shirt", preserve: expected,
        });
        expect(result.claudeAssistantContent?.[0]?.input).toEqual({
            action: "edit", prompt: "衣身改蓝色", target_image_id: "shirt", preserve: expected,
        });
        expect(parseCreativeChatInspection(result, [])).toBeNull();
        const plan = parseCreativeChatPlan(result, [reference]);
        expect(plan.kind).toBe("image");
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.lineage.preservedConstraints).toEqual(expected);
        expected.forEach(constraint => expect(plan.prompt).toContain(constraint));
    });

    test("decodes escaped preserve names and retains source order, whitespace and repeated values", async () => {
        const raw = args(String.raw`"preserve":"  领口不变\n", "pre\u0073erve":"\"preserve\": {装饰} \\ 保留\ud83e\uddf5", "preserve":"  领口不变\n"`);
        const result = await readClaudeSseResponse(toolStream(raw));
        expect((parseStrictJson(result.toolCalls[0]!.function.arguments) as { preserve: string[] }).preserve)
            .toEqual(["  领口不变\n", '"preserve": {装饰} \\ 保留🧵', "  领口不变\n"]);
        // The generic parser and raw direct planner replay remain fail-closed.
        expect(() => parseStrictJson(raw)).toThrow(DuplicateJsonKeyError);
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [call(raw)] }, [reference])).toThrow(DuplicateJsonKeyError);
    });

    test("accepts the existing generate action and an action placed after preserve", async () => {
        const result = await readClaudeSseResponse(toolStream('{"preserve":"背景纯白","prompt":"创作平面小花","preserve":"不添加文字","action":"generate"}'));
        const plan = parseCreativeChatPlan(result, []);
        expect(plan.kind).toBe("image");
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.action).toBe("generate");
        expect(plan.lineage.preservedConstraints).toEqual(["背景纯白", "不添加文字"]);
    });

    test("accepts twenty complete constraints and a four-hundred-code-unit string without truncation", async () => {
        const constraints = ["长".repeat(400), ...Array.from({ length: 19 }, (_, index) => `完整约束${index + 1}`)];
        const result = await readClaudeSseResponse(toolStream(args(constraints.map(value => `"preserve":${JSON.stringify(value)}`).join(","))));
        expect((parseStrictJson(result.toolCalls[0]!.function.arguments) as { preserve: string[] }).preserve).toEqual(constraints);
    });

    test.each([
        ["duplicate target", args('"target_image_id":"other","preserve":"领口不变","preserve":"白底不变"')],
        ["escaped duplicate target", args(String.raw`"target_image_\u0069d":"other","preserve":"领口不变","preserve":"白底不变"`)],
        ["duplicate action", args('"action":"edit","preserve":"领口不变","preserve":"白底不变"')],
        ["duplicate prompt", args('"prompt":"另一要求","preserve":"领口不变","preserve":"白底不变"')],
        ["nested preserve", args('"preserve":"领口不变","preserve":"白底不变","nested":{"preserve":"a","preserve":"b"}')],
        ["nested non-preserve", args('"preserve":"领口不变","preserve":"白底不变","reference_roles":[{"image_id":"shirt","image_id":"other"}]')],
        ["string then array", args('"preserve":"领口不变","preserve":["白底不变"]')],
        ["array then string", args('"preserve":["领口不变"],"preserve":"白底不变"')],
        ["object value", args('"preserve":{"text":"领口不变"},"preserve":"白底不变"')],
        ["null value", args('"preserve":null,"preserve":"白底不变"')],
        ["numeric value", args('"preserve":7,"preserve":"白底不变"')],
        ["boolean value", args('"preserve":true,"preserve":"白底不变"')],
        ["empty string", args('"preserve":"","preserve":"白底不变"')],
        ["whitespace string", args('"preserve":" \\n ","preserve":"白底不变"')],
        ["overlong string", args(`"preserve":${JSON.stringify("长".repeat(401))},"preserve":"白底不变"`)],
        ["twenty-one constraints", args(Array.from({ length: 21 }, (_, index) => `"preserve":"约束${index}"`).join(","))],
        ["unknown action", '{"action":"create","prompt":"创作小花","preserve":"背景纯白","preserve":"不添加文字"}'],
        ["missing action", '{"prompt":"创作小花","preserve":"背景纯白","preserve":"不添加文字"}'],
        ["nested object inside root array", `[${observed}]`],
    ])("blocks ambiguous recovery: %s", async (_name, raw) => {
        await expect(readClaudeSseResponse(toolStream(raw!))).rejects.toThrow(DuplicateJsonKeyError);
    });

    test.each([
        observed.slice(0, -1),
        `${observed.slice(0, -1)},}`,
        `${observed} {}`,
        `${observed.slice(0, -1)} // comment\n}`,
        observed.replace('"preserve":"搭配米色裤装"', '"preserve":undefined'),
    ])("does not recover invalid JSON syntax: %s", async raw => {
        await expect(readClaudeSseResponse(toolStream(raw))).rejects.toThrow(SyntaxError);
    });

    test("does not grant the preserve exception to another tool", async () => {
        await expect(readClaudeSseResponse(toolStream(observed, "inspect_images"))).rejects.toThrow(DuplicateJsonKeyError);
    });

    test("normalizes non-streaming raw string arguments before the strict planner without resubmitting", async () => {
        const requests: string[] = [];
        globalThis.fetch = (async url => {
            if (String(url) === "/api/models") return Response.json({ models: [{ id: "preserve-recovery-fixture", modelId: "preserve-recovery-fixture", name: "fixture", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "preserve-recovery-fixture", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] });
            requests.push(String(url));
            return Response.json({ content: "", toolCalls: [call(observed)] });
        }) as typeof fetch;
        const result = await requestToolResponse({ ...defaultConfig, model: "preserve-recovery-fixture", textModel: "preserve-recovery-fixture", systemPrompt: "" }, [{ role: "user", content: "衣身改蓝色，其他不变" }], []);
        const plan = parseCreativeChatPlan(result, [reference]);
        expect(plan.kind).toBe("image");
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.lineage.preservedConstraints).toEqual(["针织衫保持米白底色配浅蓝与粉色小碎花的基调", "搭配米色裤装"]);
        expect(requests).toEqual(["/api/chat/responses"]);
    });
});
