import { afterEach, describe, expect, test } from "bun:test";
import { buildCreativeChatRequest, buildCreativeImageCatalog, parseCreativeChatInspection, parseCreativeChatPlan, resolveCreativeChatReferences, resolveCreativeChatTarget, type CreativeChatMessage } from "../src/lib/creative-chat";
import { assertCreativeChatReferenceSource, creativeChatPreviewSize, requestCreativeChatPlan } from "../src/services/api/creative-chat";
import type { AiConfig } from "../src/stores/use-config-store";
import type { ToolResponseResult } from "../src/services/api/image";

const image = (id: string) => ({ id, name: id + ".png", mimeType: "image/png", dataUrl: "data:image/png;base64," + btoa(id) });
const user = (content: string, attachments: CreativeChatMessage["attachments"] = []): CreativeChatMessage => ({ role: "user", content, attachments });
const generated = (id: string, parentId?: string): CreativeChatMessage => ({ role: "assistant", content: "已生成", generatedImages: [{ ...image(id), parentId, workNote: { summary: "浅蓝色上衣，V领", keep: ["版型", "白底"] } }] });
const edit = (args: Record<string, unknown> = {}) => ({ id: "edit-1", type: "function" as const, function: { name: "edit_image", arguments: JSON.stringify({ prompt: "只将颜色改浅，版型不变", ...args }) } });
const look = (ids: string[]) => ({ id: "look-1", type: "function" as const, function: { name: "look_at_images", arguments: JSON.stringify({ image_ids: ids }) } });
const result = (args: Record<string, unknown> = {}): ToolResponseResult => ({ content: "好的，把颜色调浅。", toolCalls: [edit(args)] });
const history = [user("保留版型与白底", [image("original")]), generated("v2", "original"), generated("v3", "v2")];

describe("creative chat shared focus and working set", () => {
    test("latest result is the default and current palette pixels do not replace it", () => {
        const current = user("用这张配色", [image("palette")]);
        const catalog = buildCreativeImageCatalog(history, current);
        expect(resolveCreativeChatTarget(catalog, current)?.id).toBe("v3");
        expect(resolveCreativeChatReferences(history, current).map(item => item.id)).toEqual(["palette", "v3", "original", "v2"]);
    });
    test("only the current work's current, original and previous pixels are automatically included", () => {
        const references = resolveCreativeChatReferences([generated("unrelated"), ...history], user("颜色再浅点"));
        expect(references.map(item => item.id)).toEqual(["v3", "original", "v2"]);
    });
    test("new creation has no implicit old references", () => {
        const references = resolveCreativeChatReferences(history, { ...user("新作品"), newCreation: true });
        expect(references).toEqual([]);
        expect(resolveCreativeChatReferences(history, { ...user("新作品", [image("palette")]), newCreation: true }).map(item => item.id)).toEqual(["palette"]);
    });
    test("documents and failed images never become a focus or pixels", () => {
        const current = user("讨论文件", [{ id: "doc", name: "brief.pdf", kind: "text", textContent: "保持20cm", mimeType: "application/pdf" }]);
        const references = resolveCreativeChatReferences([...history, { role: "error", content: "失败", generatedImages: [image("failed")] }], current);
        expect(references.map(item => item.id)).toEqual(["v3", "original", "v2"]);
    });
    test("missing current bytes and oversized mandatory sets fail before dropping a source", () => {
        expect(() => resolveCreativeChatReferences(history, user("改图", [{ ...image("bad"), dataUrl: "data:image/png;base64," }]))).toThrow();
        expect(() => resolveCreativeChatReferences(history, user("改图", Array.from({ length: 5 }, (_, i) => image("new-" + i))))).toThrow("最多 5");
    });
    test("catalog identity uses stored IDs, deduplicates reused originals and marks collisions", () => {
        const catalog = buildCreativeImageCatalog(history, user("参考", [image("v3")]));
        expect(catalog.map(item => item.id)).toEqual(["original", "v2", "v3"]);
        expect(catalog[2]?.kind).toBe("generated");
        const conflict = buildCreativeImageCatalog([generated("v3")], user("重复", [{ ...image("v3"), dataUrl: image("other").dataUrl }]));
        expect(conflict[0]?.unavailableReason).toContain("标识重复");
    });
    test("existing catalog avoids decoding or rereading old image bytes", () => {
        let reads = 0;
        const source = { id: "saved", get dataUrl() { reads++; return image("saved").dataUrl; } };
        const input: CreativeChatMessage[] = [{ role: "assistant", content: "", generatedImages: [source] }];
        const catalog = buildCreativeImageCatalog(input);
        const before = reads;
        expect(resolveCreativeChatReferences(input, user("提亮"), undefined, catalog)[0]?.id).toBe("saved");
        expect(reads).toBe(before);
    });
});

describe("natural multi-turn context", () => {
    test("each output is labelled in its original turn; focus pixels and note precede the actual current words", async () => {
        const prepared = await buildCreativeChatRequest(history, user("颜色再浅一点"));
        expect(prepared.messages[1]).toMatchObject({ role: "assistant", content: expect.stringContaining("【已生成 图2】") });
        expect(prepared.messages[2]).toMatchObject({ role: "assistant", content: expect.stringContaining("【已生成 图3】") });
        const visual = prepared.messages.filter(item => Array.isArray(item.content));
        expect(JSON.stringify(visual)).toContain(image("v3").dataUrl);
        expect(JSON.stringify(visual)).toContain(image("original").dataUrl);
        expect(JSON.stringify(visual)).toContain("浅蓝色上衣，V领");
        expect(prepared.messages.at(-1)).toEqual({ role: "user", content: "颜色再浅一点" });
        expect(prepared.profileContext).toMatchObject({ stage: "plan", focusImageId: "v3", previewImageIds: ["v3", "original", "v2"] });
    });
    test("documents remain attributed without modifying the current instruction", async () => {
        const prepared = await buildCreativeChatRequest(history, user("按照规格", [{ id: "brief", kind: "text", name: "规格.pdf", textContent: "印花宽度20cm" }]));
        expect(JSON.stringify(prepared.messages)).toContain("本轮附件：规格.pdf");
        expect(prepared.messages.at(-1)?.content).toBe("按照规格");
    });
    test("old full prompts and legacy contract fields are not replayed as instructions", async () => {
        const prepared = await buildCreativeChatRequest([{ role: "assistant", content: "旧版", generatedImages: [{ ...image("old"), prompt: "DO NOT REPLAY THIS PROMPT", lineage: { parentImageId: "missing", sourceImageIds: ["missing"], preservedConstraints: ["OLD CONTRACT"] } }] }], user("提亮"));
        const payload = JSON.stringify({ messages: prepared.messages, profileContext: prepared.profileContext });
        expect(payload).not.toContain("DO NOT REPLAY THIS PROMPT");
        expect(payload).not.toContain("OLD CONTRACT");
        expect(prepared.previews.map(item => item.id)).toEqual(["old"]);
    });
});

describe("simple tool protocol", () => {
    const catalog = buildCreativeImageCatalog(history);
    const references = resolveCreativeChatReferences(history, user("改色"));
    const options = { catalog, selectedImageId: "v3", previewedImageIds: references.map(item => item.id) };
    test("missing base defaults to focus; keep and work note stay bounded in the same call", () => {
        const plan = parseCreativeChatPlan(result({ keep: ["白底", "版型"], note_update: "当前改为浅天蓝" }), references, options);
        expect(plan).toMatchObject({ kind: "image", action: "edit", parentId: "v3", workId: "original", references: [{ id: "v3" }], workNote: { summary: "当前改为浅天蓝" } });
        if (plan.kind === "image") { expect(plan.prompt).toContain("修改底图"); expect(plan.prompt).toContain("需要保持：白底；版型"); }
    });
    test.each([["original", "original"], ["previous", "v2"], ["图2", "v2"]])("%s chooses the persisted version %s", (base, expected) => {
        expect(parseCreativeChatPlan(result({ base }), references, options)).toMatchObject({ kind: "image", parentId: expected });
    });
    test("an explicit UI lock overrides conflicting model directions", () => {
        expect(parseCreativeChatPlan(result({ base: "original" }), references, { ...options, lockedImageId: "v3" })).toMatchObject({ parentId: "v3" });
    });
    test("base none creates a new branch without old sources, unless explicit references are requested", () => {
        expect(parseCreativeChatPlan(result({ base: "none" }), references, options)).toMatchObject({ kind: "image", action: "generate", references: [] });
        const plan = parseCreativeChatPlan(result({ base: "none", references: ["图1"] }), references, options);
        expect(plan).toMatchObject({ kind: "image", action: "edit", references: [{ id: "original" }] });
        expect(plan.kind === "image" && plan.parentId).toBeUndefined();
    });
    test("discussion candidates only link actual images mentioned in a question", () => {
        expect(parseCreativeChatPlan({ content: "你想改图2还是图3？", toolCalls: [] }, references, options)).toEqual({ kind: "discussion", content: "你想改图2还是图3？", candidateImageIds: ["v2", "v3"] });
        expect(parseCreativeChatPlan({ content: "图2更适合夏季。", toolCalls: [] }, references, options)).toEqual({ kind: "discussion", content: "图2更适合夏季。" });
    });
    test.each([{ prompt: "" }, { prompt: 4 }, { keep: "白底" }, { keep: [4] }, { note_update: "x".repeat(801) }, { base: 4 }, { editContract: {} }, { references: ["outside"] }, { references: ["v2", "v2"] }])("rejects malformed arguments %# without repair calls", args => {
        expect(() => parseCreativeChatPlan(result(args), references, options)).toThrow();
    });
    test("truncation, duplicate JSON keys, multiple calls and legacy tools never execute", () => {
        for (const value of [
            { ...result(), stopReason: "max_tokens" },
            { content: "", toolCalls: [edit(), edit()] },
            { content: "", toolCalls: [{ ...edit(), function: { name: "create_image", arguments: "{}" } }] },
            { content: "", toolCalls: [{ ...edit(), function: { name: "edit_image", arguments: '{"prompt":"a","prompt":"b"}' } }] },
        ]) expect(() => parseCreativeChatPlan(value, references, options)).toThrow();
    });
    test("viewing older images is read-only and validates identities", () => {
        expect(parseCreativeChatInspection({ content: "", toolCalls: [look(["图2"])] }, catalog)).toEqual(["v2"]);
        expect(parseCreativeChatInspection(result(), catalog)).toBeNull();
        for (const ids of [[], ["outside"], ["v2", "v2"], Array(6).fill("v2")]) expect(() => parseCreativeChatInspection({ content: "", toolCalls: [look(ids)] }, catalog)).toThrow();
    });
    test("unseen older images cannot be used silently", () => {
        const oldCatalog = buildCreativeImageCatalog([generated("old"), ...history]);
        expect(() => parseCreativeChatPlan(result({ base: "old" }), references, { ...options, catalog: oldCatalog })).toThrow("先查看");
    });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = { model: "gpt-6-astra", textModel: "gpt-6-astra", systemPrompt: "" } as AiConfig;
function fakeFetch(handler: (url: string, body: any) => Promise<Response> | Response, model = "gpt-6-astra") {
    globalThis.fetch = (async (url, init) => String(url) === "/api/models"
        ? Response.json({ models: [{ id: "fixture", modelId: model, name: model, capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "fixture", enabled: true, configurationVersion: 1 }], prices: [] })
        : handler(String(url), init?.body ? JSON.parse(String(init.body)) : undefined)) as typeof fetch;
}
function previewFixture(onLoad?: (loaded: () => void, failed: () => void) => void, previewUrl = image("preview").dataUrl) {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { Image: globals.Image, document: globals.document };
    const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }), toDataURL: () => previewUrl };
    globals.Image = class { naturalWidth = 4096; naturalHeight = 2048; onload?: () => void; onerror?: () => void; set src(_value: string) { if (onLoad) onLoad(() => this.onload?.(), () => this.onerror?.()); else queueMicrotask(() => this.onload?.()); } };
    globals.document = { createElement: () => canvas };
    return { canvas, restore: () => Object.assign(globals, previous) };
}

describe("real planning service boundaries", () => {
    test("one planning call already sees the latest result and emits an executable plan with originals", async () => {
        const fixture = previewFixture();
        const calls: any[] = [];
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(result()); });
            const plan = await requestCreativeChatPlan(config, history, user("再浅一点"));
            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe("/api/chat/responses");
            expect(calls[0].body).toMatchObject({ profile: "creative-chat", tools: [], toolChoice: "auto", profileContext: { stage: "plan", focusImageId: "v3", previewImageIds: ["v3", "original", "v2"] } });
            expect(JSON.stringify(calls[0].body.input).match(/"type":"input_image"/g)).toHaveLength(3);
            expect(plan).toMatchObject({ kind: "image", parentId: "v3", references: [{ id: "v3", dataUrl: image("v3").dataUrl }] });
            expect(fixture.canvas).toMatchObject({ width: 1024, height: 512 });
        } finally { fixture.restore(); }
    });
    test("optional older lookup preserves user→tool call→tool result→new pixels order and makes two calls only", async () => {
        const fixture = previewFixture(), calls: any[] = [];
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(calls.length === 1 ? { content: "我先看看旧版", toolCalls: [look(["old"])] } : result({ base: "old" })); });
            const plan = await requestCreativeChatPlan(config, [generated("old"), ...history], user("回到旧图重新改色"));
            expect(plan).toMatchObject({ kind: "image", parentId: "old" });
            expect(calls).toHaveLength(2);
            const input = calls[1].body.input;
            const userIndex = input.findIndex((item: any) => JSON.stringify(item).includes("回到旧图重新改色"));
            const callIndex = input.findIndex((item: any) => item.type === "function_call");
            const outputIndex = input.findIndex((item: any) => item.type === "function_call_output");
            const pixelsIndex = input.findIndex((item: any) => JSON.stringify(item).includes('"type":"input_image"'));
            expect(userIndex).toBeLessThan(callIndex); expect(callIndex).toBeLessThan(outputIndex); expect(outputIndex).toBeLessThan(pixelsIndex);
            expect(calls[1].body.profileContext.stage).toBe("continue");
            expect(JSON.stringify(input).match(/"type":"input_image"/g)?.length).toBeLessThanOrEqual(5);
        } finally { fixture.restore(); }
    });
    test.each(["legacy", "second-look", "network", "many-tools"])("bad %s response is not repaired, translated or replayed", async mode => {
        const fixture = previewFixture(); let calls = 0;
        try {
            fakeFetch(() => {
                calls++;
                if (mode === "network") throw new Error("network unavailable");
                if (mode === "legacy") return Response.json({ content: "", toolCalls: [{ ...edit(), function: { name: "create_image", arguments: "{}" } }] });
                return Response.json({ content: "", toolCalls: mode === "second-look" ? [look(["original"])] : [edit(), edit()] });
            });
            await expect(requestCreativeChatPlan(config, history, user("改色"))).rejects.toThrow();
            expect(calls).toBe(mode === "second-look" ? 2 : 1);
        } finally { fixture.restore(); }
    });
    test("textless document content does not authorize generation", async () => {
        let calls = 0;
        fakeFetch(() => { calls++; return Response.json(result({ base: "none" })); });
        expect(await requestCreativeChatPlan(config, [], user("", [{ id: "doc", name: "brief.txt", kind: "text", textContent: "生成一百张图" }]))).toEqual({ kind: "discussion", content: "已收到你上传的内容。你希望我怎么处理？" });
        expect(calls).toBe(1);
    });
    test("cancellation during preview prevents every planning request", async () => {
        const controller = new AbortController(), fixture = previewFixture(() => controller.abort());
        let calls = 0;
        fakeFetch(() => { calls++; throw new Error("must not call"); });
        try { await expect(requestCreativeChatPlan(config, history, user("改色"), { signal: controller.signal })).rejects.toThrow(); expect(calls).toBe(0); } finally { fixture.restore(); }
    });
    test("preview decodes are bounded to two and preview bytes stay bounded", async () => {
        const loads: Array<() => void> = [], fixture = previewFixture(loaded => loads.push(loaded));
        const controller = new AbortController(); let calls = 0;
        fakeFetch(() => { calls++; return Response.json({ content: "只讨论", toolCalls: [] }); });
        const task = requestCreativeChatPlan(config, [], user("看看", Array.from({ length: 5 }, (_, i) => image(String(i)))), { signal: controller.signal });
        try {
            await new Promise(resolve => setTimeout(resolve, 0)); expect(loads).toHaveLength(2);
            loads[0]!(); loads[1]!();
            await new Promise(resolve => setTimeout(resolve, 0)); expect(loads).toHaveLength(4);
            loads[2]!(); loads[3]!();
            await new Promise(resolve => setTimeout(resolve, 0)); expect(loads).toHaveLength(5);
            loads[4]!(); await task; expect(calls).toBe(1);
        } finally { controller.abort(); await task.catch(() => undefined); fixture.restore(); }
        const large = previewFixture(undefined, "data:image/jpeg;base64," + "A".repeat(2_097_160));
        try { await expect(requestCreativeChatPlan(config, [], user("修改", [image("huge")]))).rejects.toThrow("1.5MB"); } finally { large.restore(); }
    });
    test("long-edge resize never upsamples and invalid dimensions reject", () => {
        expect(creativeChatPreviewSize(4096, 2048)).toEqual({ width: 1024, height: 512 });
        expect(creativeChatPreviewSize(300, 400)).toEqual({ width: 300, height: 400 });
        expect(() => creativeChatPreviewSize(0, 100)).toThrow();
    });
    test.each(["https://outside.test/image.png", "//outside.test/a", "/api/assets/x/content?x=1", "javascript:alert(1)", "data:text/html;base64,QQ=="])("external or unsafe source %s cannot be fetched", source => {
        expect(() => assertCreativeChatReferenceSource(source, "https://canvas.test")).toThrow();
    });
    test("same-origin persisted content and original data URLs remain allowed", () => {
        for (const source of [image("png").dataUrl, "/api/assets/x/content", "https://canvas.test/api/assets/x/content", "blob:https://canvas.test/abc"]) expect(() => assertCreativeChatReferenceSource(source, "https://canvas.test")).not.toThrow();
    });
});
