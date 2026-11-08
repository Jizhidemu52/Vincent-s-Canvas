import { afterEach, describe, expect, test } from "bun:test";
import { buildCreativeChatRequest, buildCreativeImageCatalog, parseCreativeChatInspection, parseCreativeChatPlan, resolveCreativeChatReferences, resolveCreativeChatTarget, type CreativeChatMessage } from "../src/lib/creative-chat";
import { assertCreativeChatReferenceSource, creativeChatPreviewSize, requestCreativeChatPlan } from "../src/services/api/creative-chat";
import type { AiConfig } from "../src/stores/use-config-store";
import type { ToolResponseResult } from "../src/services/api/image";
import { ImageAgentPlanningError } from "../../shared/image-agent-iteration";
import { IMAGE_AGENT_BASE_PRESERVATION } from "../src/lib/image-agent/compile";
import { completeChatImageTask } from "../src/pages/chat/chat-image-tasks";
import type { ChatSession } from "../src/pages/chat/chat-types";
import type { PendingChatImageTask } from "../src/services/api/chat-image-recovery";
import { prepareChatProfileInput, validateChatProfileOutput } from "../../server/src/prompt-chat-profiles";
import { imageAgentRepairMetadata } from "../../server/src/image-agent-profile";
import { PromptOptimizationError } from "../../server/src/prompt-safety";
import type { AgentDocument, DesignRequirements } from "../../shared/image-agent-documents";

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
    test("old public prompts become labelled historical excerpts, not new message instructions", async () => {
        const prompt = "该旧版曾要求暖灰背景。" + "历史要求".repeat(500) + "FULL PROMPT TAIL";
        const prepared = await buildCreativeChatRequest([{ role: "assistant", content: "旧版", generatedImages: [{ ...image("old"), prompt, lineage: { parentImageId: "missing", sourceImageIds: ["missing"], preservedConstraints: ["OLD CONTRACT"] } }] }], user("提亮"));
        const brief = prepared.profileContext.imageCatalog[0]?.designBrief;
        expect(brief).toContain("该旧版曾要求暖灰背景");
        expect(brief).toContain("并非已实现事实");
        expect(brief).toContain("仅为节选");
        expect(brief?.length).toBeLessThanOrEqual(1600);
        expect(JSON.stringify(prepared.messages)).not.toContain("该旧版曾要求暖灰背景");
        expect(JSON.stringify(prepared.profileContext)).not.toContain("FULL PROMPT TAIL");
        expect(JSON.stringify(prepared.profileContext)).not.toContain("OLD CONTRACT");
        expect(prepared.previews.map(item => item.id)).toEqual(["old"]);
        expect(prepared.messages.at(-1)?.content).toBe("提亮");
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
        ? Response.json({ models: [{ id: "fixture", modelId: model, name: model, capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "fixture", enabled: true, configurationVersion: 1 }], prices: [] })
        : handler(String(url), init?.body ? JSON.parse(String(init.body)) : undefined)) as typeof fetch;
}
function previewFixture(onLoad?: (loaded: () => void, failed: () => void, source: string) => void, previewUrl: string | ((source: string) => string) = image("preview").dataUrl) {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { Image: globals.Image, document: globals.document };
    const canvas = { width: 0, height: 0, source: "", getContext: () => ({ fillStyle: "", fillRect() {}, drawImage(element: { source: string }) { canvas.source = element.source; } }), toDataURL: () => typeof previewUrl === "function" ? previewUrl(canvas.source) : previewUrl };
    globals.Image = class { naturalWidth = 4096; naturalHeight = 2048; source = ""; onload?: () => void; onerror?: () => void; set src(value: string) { this.source = value; if (onLoad) onLoad(() => this.onload?.(), () => this.onerror?.(), value); else queueMicrotask(() => this.onload?.()); } };
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
    test("explicit old-version lookup returns only those versions' bounded historical metadata", async () => {
        const fixture = previewFixture(), calls: any[] = [];
        const oldPrompt = "旧版暖灰海报：" + "保留文字层次".repeat(1000);
        const records: CreativeChatMessage[] = [{ role: "assistant", content: "旧版", generatedImages: [{ ...image("old"), prompt: oldPrompt, workNote: { summary: "旧版说明".repeat(300), keep: ["保留标题"] } }] }, ...history];
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(calls.length === 1 ? { content: "查阅指定旧版", toolCalls: [look(["old", "v2"])] } : result({ base: "old" })); });
            const plan = await requestCreativeChatPlan(config, records, user("查看指定旧版，基于旧版改色"));
            expect(calls).toHaveLength(2);
            const output = calls[1].body.input.find((item: any) => item.type === "function_call_output").output;
            const metadata = JSON.parse(output);
            expect(output.length).toBeLessThanOrEqual(36_000);
            expect(metadata.metadata_scope).toContain("不是已实现或验收事实");
            expect(metadata.version_details.map((item: any) => item.id)).toEqual(["old", "v2"]);
            expect(metadata.version_details[0]).toMatchObject({ id: "old", label: "图1", prompt: oldPrompt.slice(0, 4000), promptTruncated: true, workNoteTruncated: true });
            expect(metadata.version_details[0].workNote.length).toBeLessThanOrEqual(800);
            expect(metadata.version_details[0].designBrief.length).toBeLessThanOrEqual(1600);
            expect(metadata.version_details[1]).toMatchObject({ id: "v2", parentId: "original", prompt: "", promptTruncated: false, workNote: "浅蓝色上衣，V领\n需保持：版型；白底" });
            expect(metadata.version_details.some((item: any) => item.id === "v3" || item.id === "original")).toBe(false);
            expect(records[0]?.generatedImages?.[0]?.prompt).toBe(oldPrompt);
            expect(plan).toMatchObject({ kind: "image", parentId: "old", references: [{ id: "old", dataUrl: image("old").dataUrl }] });
        } finally { fixture.restore(); }
    });
    test("escaped lookup metadata exceeding the aggregate budget refuses without dropping images or calling again", async () => {
        const fixture = previewFixture(); let calls = 0;
        const records: CreativeChatMessage[] = Array.from({ length: 5 }, (_, index) => ({ role: "assistant", content: "历史版本", generatedImages: [{ ...image(`old-${index}`), prompt: "\u0000".repeat(5000) }] }));
        try {
            fakeFetch(() => { calls++; return Response.json({ content: "查阅旧版", toolCalls: [look(records.map(item => item.generatedImages![0]!.id))] }); });
            await expect(requestCreativeChatPlan(config, records, { ...user("只查阅这五版"), newCreation: true })).rejects.toThrow("超过 36000");
            expect(calls).toBe(1);
            expect(records.every(item => item.generatedImages?.[0]?.prompt?.length === 5000)).toBe(true);
        } finally { fixture.restore(); }
    });
    test("actual service requests preserve discussion, chosen proposal, feedback and previous/original branches without manual review", async () => {
        const fixture = previewFixture(), calls: any[] = [];
        const records: CreativeChatMessage[] = [];
        const proposal = "方案A：红色方形标题。方案B：蓝色圆形标题。";
        const responses: ToolResponseResult[] = [
            { content: proposal, toolCalls: [] },
            result({ prompt: "采用方案B，蓝色圆形标题，保持版面。" }),
            result({ prompt: "蓝色圆形标题缩小，保持版面。" }),
            result({ base: "previous", prompt: "回到圆形标题未缩小的上一版，只增强文字对比。" }),
            result({ base: "original", prompt: "以原图为准，只调整标题位置。" }),
        ];
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(responses[calls.length - 1]); });
            const initial = user("先讨论这张海报的标题方向，不出图", [image("poster-original")]);
            const discussion = await requestCreativeChatPlan(config, records, initial);
            expect(discussion).toMatchObject({ kind: "discussion", content: proposal });
            records.push(initial, { role: "assistant", content: discussion.content });
            const turns = [
                { text: "选B，按这个方案出图", focus: "poster-original", output: "poster-v1", base: "poster-original" },
                { text: "圆形太大了，缩小一点，蓝色保留", focus: "poster-v1", output: "poster-v2", base: "poster-v1" },
                { text: "回上一版，圆形不缩小，只增强文字对比", focus: "poster-v2", output: "poster-v3", base: "poster-v1" },
                { text: "回原图，只调整标题位置", focus: "poster-v3", output: "poster-v4", base: "poster-original" },
            ];
            for (const turn of turns) {
                const current = user(turn.text);
                const plan = await requestCreativeChatPlan(config, records, current, { selectedImageId: turn.focus });
                expect(plan).toMatchObject({ kind: "image", parentId: turn.base, references: [{ id: turn.base, dataUrl: image(turn.base).dataUrl }] });
                if (plan.kind !== "image") throw new Error("expected image plan");
                const body = calls.at(-1)!.body;
                expect(body.profileContext).toMatchObject({ focusImageId: turn.focus, currentUserText: turn.text });
                expect(JSON.stringify(body.input)).toContain(proposal);
                expect(JSON.stringify(body.input)).toContain("选B");
                expect(JSON.stringify(body.input.at(-1))).toContain(turn.text);
                expect(body.profileContext.previewImageIds).toContain(turn.base);
                if (turn.focus !== "poster-original") {
                    const firstBrief = body.profileContext.imageCatalog.find((item: any) => item.id === "poster-v1").designBrief;
                    expect(firstBrief).toContain("采用方案B，蓝色圆形标题");
                    expect(firstBrief).toContain("并非已实现事实");
                    expect(firstBrief).not.toContain("缩小");
                }
                if (turn.focus === "poster-v2") {
                    expect(body.profileContext.imageCatalog.find((item: any) => item.id === "poster-v2").designBrief).toContain("标题缩小");
                    expect(JSON.stringify(body.input)).toContain("圆形太大了");
                }
                records.push(current, { role: "assistant", content: plan.content, generatedImages: [{ ...image(turn.output), parentId: plan.parentId, workId: plan.workId, prompt: plan.prompt }] });
            }
            expect(calls).toHaveLength(5);
            expect(calls.every(call => call.url === "/api/chat/responses")).toBe(true);
            expect(calls.some(call => call.body.profileContext.stage === "repair" || call.body.profileContext.stage === "continue")).toBe(false);
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

describe("standalone structured edits and bounded planning repair", () => {
    const spec = { changes: ["左袖口改为罗纹"], region: "左袖口", acceptance: ["袖口为罗纹，其余待核对"], assumptions: ["只处理左袖口"], reference_roles: [{ image_id: "图3", role: "base" as const, purpose: "保留当前版型", do_not_transfer: "不增加装饰" }] };
    test("full planner description and structured requirements compile with code-owned preservation", () => {
        const references = resolveCreativeChatReferences(history, user("改左袖口"));
        const plan = parseCreativeChatPlan(result({ prompt: "完整规划描述：自然棉纱光泽，袖口罗纹过渡清晰。", edit_spec: spec }), references, { catalog: buildCreativeImageCatalog(history), selectedImageId: "v3" });
        expect(plan.kind).toBe("image");
        if (plan.kind !== "image") return;
        expect(plan.prompt).toContain("完整规划描述：自然棉纱光泽，袖口罗纹过渡清晰。");
        expect(plan.prompt).toContain(IMAGE_AGENT_BASE_PRESERVATION);
        expect(plan.prompt).toContain("不迁移：不增加装饰");
        expect(plan.spec).toMatchObject({ ...spec, reference_roles: [{ ...spec.reference_roles[0], image_id: "v3" }] });
        const fresh = parseCreativeChatPlan(result({ base: "none", edit_spec: { changes: ["新建帽子"] } }), references, { catalog: buildCreativeImageCatalog(history), selectedImageId: "v3" });
        expect(fresh.kind === "image" && fresh.prompt).not.toContain(IMAGE_AGENT_BASE_PRESERVATION);
    });
    test("invalid roles and unseen sources are typed refusal, source corruption is not repairable", () => {
        const references = resolveCreativeChatReferences(history, user("改色"));
        const options = { catalog: buildCreativeImageCatalog(history), selectedImageId: "v3" };
        expect(() => parseCreativeChatPlan(result({ edit_spec: { ...spec, reference_roles: [{ ...spec.reference_roles[0], image_id: "outside" }] } }), references, options)).toThrow(ImageAgentPlanningError);
        expect(() => parseCreativeChatPlan(result({ base: "v2" }), references, { ...options, previewedImageIds: ["v3"] })).toThrow(ImageAgentPlanningError);
        const broken = options.catalog.map(item => item.id === "v3" ? { ...item, unavailableReason: "source missing" } : item);
        try { parseCreativeChatPlan(result(), references, { ...options, catalog: broken }); throw new Error("must refuse"); }
        catch (error) { expect(error).not.toBeInstanceOf(ImageAgentPlanningError); expect(String(error)).toContain("不可读取"); }
    });
    test("version briefs are bounded and belong only to their own recorded specification", async () => {
        const records: CreativeChatMessage[] = [user("原版", [image("original")]),
            { ...generated("v2", "original"), generatedImages: [{ ...image("v2"), parentId: "original", spec: { changes: ["蓝色袖口"], assumptions: ["保留纽扣"] } }] },
            { ...generated("v3", "v2"), generatedImages: [{ ...image("v3"), parentId: "v2", spec: { changes: Array.from({ length: 8 }, () => "绿色领口".repeat(80)) } }] }];
        const catalog = buildCreativeImageCatalog(records);
        expect(catalog[0]?.designBrief).toBeUndefined();
        expect(catalog[1]?.designBrief).toContain("蓝色袖口");
        expect(catalog[1]?.designBrief).not.toContain("绿色领口");
        expect(catalog[2]?.designBrief?.length).toBeLessThanOrEqual(1600);
        expect(catalog[2]?.designBrief).not.toContain("蓝色袖口");
        const prepared = await buildCreativeChatRequest(records, user("回到这版"), undefined, { selectedImageId: "v2" });
        expect(prepared.profileContext.focusImageId).toBe("v2");
        expect(prepared.profileContext.imageCatalog.find(item => item.id === "v2")?.designBrief).toContain("蓝色袖口");
    });
    test("missing optional specs and notes fall back only to the exact version's public prompt", () => {
        const records: CreativeChatMessage[] = [{ role: "assistant", content: "版本", generatedImages: [
            { ...image("one"), prompt: "第一版要求蓝色圆形标题" },
            { ...image("two"), parentId: "one", prompt: "第二版要求缩小标题" },
            { ...image("three"), parentId: "two", prompt: "不采用这份旧提示词", spec: { changes: ["第三版按明确规格改位置"] } },
        ] }];
        const catalog = buildCreativeImageCatalog(records);
        expect(catalog[0]?.designBrief).toContain("第一版要求蓝色圆形标题");
        expect(catalog[0]?.designBrief).not.toContain("缩小");
        expect(catalog[1]?.designBrief).toContain("第二版要求缩小标题");
        expect(catalog[1]?.designBrief).not.toContain("第一版");
        expect(catalog[2]?.designBrief).toContain("第三版按明确规格改位置");
        expect(catalog[2]?.designBrief).not.toContain("不采用这份旧提示词");
        expect(catalog.every(item => !item.note)).toBe(true);
    });
    test("pending specification survives completion and recovery without becoming an acceptance claim", () => {
        const pending: PendingChatImageTask = { requestId: "r", prompt: "袖口罗纹", modelId: "fixture", action: "edit", parentId: "v3", workId: "original", spec, explanation: "将修改左袖口" };
        const session: ChatSession = { id: "s", title: "test", updatedAt: "", messages: [{ id: "a", role: "assistant", content: "处理中", createdAt: "", pendingImageTask: pending }] };
        for (const recovered of [false, true]) {
            const complete = completeChatImageTask(session, "a", pending, [image("out")], recovered);
            expect(complete.messages[0]?.generatedImages?.[0]?.spec).toEqual(spec);
            expect(complete.messages[0]?.content).toContain("将修改左袖口");
            expect(complete.messages[0]?.content).not.toContain("验收通过");
        }
    });
    test("a known invalid plan repairs once before image submission and retains original context", async () => {
        const fixture = previewFixture(), calls: any[] = [];
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(calls.length === 1 ? result({ keep: "bad" }) : result({ edit_spec: spec })); });
            const plan = await requestCreativeChatPlan(config, history, user("左袖口改罗纹"));
            expect(plan).toMatchObject({ kind: "image", parentId: "v3" });
            expect(calls).toHaveLength(2);
            expect(calls.every(call => call.url === "/api/chat/responses")).toBe(true);
            expect(calls[1].body.profileContext).toMatchObject({ stage: "repair", currentUserText: "左袖口改罗纹", focusImageId: "v3", repairIssue: { code: "IMAGE_AGENT_ARGUMENTS_INVALID", repairable: true, submitted: false } });
            expect(calls[1].body.input).toEqual(calls[0].body.input);
        } finally { fixture.restore(); }
    });
    test("a direct edit of branched 图3 reloads its actual pixels before the sole repair and retains its original lineage", async () => {
        const records = [user("原包", [image("one")]), generated("two", "one"), generated("three", "two"), generated("four", "two"), generated("five", "one")];
        const originalRecords = JSON.stringify(records);
        const current = user("以图3为基础，只把两侧连接环从金色改成银色。保留图3的森林绿包身和肩带、浅暖灰背景，以及原有包型，生成一张。");
        const previewOf = (source: string) => image(`preview:${atob(source.split(",")[1]!)}`).dataUrl;
        const fixture = previewFixture(undefined, previewOf), calls: any[] = [];
        try {
            fakeFetch(async (url, body) => {
                calls.push({ url, body });
                const prepared = await prepareChatProfileInput(body);
                return Response.json(validateChatProfileOutput(result({ base: "three", prompt: current.content }), prepared.privateRules));
            });
            const plan = await requestCreativeChatPlan(config, records, current);
            expect(calls).toHaveLength(2);
            expect(calls.every(call => call.url === "/api/chat/responses")).toBe(true);
            expect(calls[0].body.profileContext.previewImageIds).toEqual(["five", "one"]);
            expect(JSON.stringify(calls[0].body.input)).not.toContain(previewOf(image("three").dataUrl));
            const repaired = calls[1].body;
            expect(repaired.profileContext).toMatchObject({ stage: "repair", focusImageId: "five", previewImageIds: ["three", "five", "one"] });
            expect(repaired.profileContext.imageCatalog.find((entry: any) => entry.id === "three")).toMatchObject({ parentId: "two", previewed: true });
            expect(repaired.profileContext.imageCatalog.find((entry: any) => entry.id === "four").previewed).toBe(false);
            expect(Object.keys(repaired.profileContext.repairIssue).sort()).toEqual(["code", "message", "repairable", "submitted"]);
            const pixels = repaired.input.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "input_image").map((part: any) => part.image_url) : []);
            expect(pixels).toEqual(["three", "five", "one"].map(id => previewOf(image(id).dataUrl)));
            expect(repaired.input.at(-1)).toEqual({ role: "user", content: current.content });
            expect(plan).toMatchObject({ kind: "image", parentId: "three", workId: "one", references: [{ id: "three", dataUrl: image("three").dataUrl }] });
            expect(plan.kind === "image" && plan.references).toHaveLength(1);
            expect(JSON.stringify(records)).toBe(originalRecords);
        } finally { fixture.restore(); }
    });
    test("five required repair sources replace optional focus pixels without changing the focus", async () => {
        const records = [...Array.from({ length: 5 }, (_, index) => generated(`old-${index}`)), ...history];
        const fixture = previewFixture(), calls: any[] = [];
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(result({ base: "old-0", references: ["old-1", "old-2", "old-3", "old-4"] })); });
            const plan = await requestCreativeChatPlan(config, records, user("以早期图为底图参考其余四图"));
            expect(calls).toHaveLength(2);
            expect(calls[1].body.profileContext).toMatchObject({ focusImageId: "v3", previewImageIds: ["old-0", "old-1", "old-2", "old-3", "old-4"] });
            expect(calls[1].body.profileContext.imageCatalog.find((entry: any) => entry.id === "v3").previewed).toBe(false);
            expect(JSON.stringify(calls[1].body.input).match(/"type":"input_image"/g)).toHaveLength(5);
            expect(plan.kind === "image" && plan.references.map(reference => reference.id)).toEqual(["old-0", "old-1", "old-2", "old-3", "old-4"]);
        } finally { fixture.restore(); }
    });
    test("pixel repair does not widen the real server's permission to introduce a document lookup", async () => {
        const document: AgentDocument = { id: "brief", name: "brief.pdf", kind: "pdf", mimeType: "application/pdf", bytes: 1, warnings: [],
            sections: [{ id: "s1", title: "配件要求", text: "两侧连接环改银色", figureIds: ["figure"] }],
            figures: [{ ...image("figure"), sectionId: "s1", label: "配件图" }] };
        const requirements: DesignRequirements = { title: "配件改色", documentIds: ["brief"], subject: "包", colors: "银色", materials: "", must: ["只改连接环"], avoid: [], unknowns: [], referenceFigureIds: [], sources: [{ documentId: "brief", sectionId: "s1" }] };
        const previewOf = (source: string) => image(`preview:${atob(source.split(",")[1]!)}`).dataUrl;
        const fixture = previewFixture(undefined, previewOf), calls: any[] = [];
        const current = user("以旧图为基础，核对文件后只把连接环改银色");
        try {
            fakeFetch(async (url, body) => {
                calls.push({ url, body });
                const prepared = await prepareChatProfileInput(body);
                const response = calls.length === 2
                    ? { content: "核对文件要求", toolCalls: [{ id: "read-1", type: "function" as const, function: { name: "read_document", arguments: JSON.stringify({ document_id: "brief", section_start: 1 }) } }] }
                    : result({ base: "old", prompt: current.content });
                return Response.json(validateChatProfileOutput(response, prepared.privateRules));
            });
            await expect(requestCreativeChatPlan(config, [generated("old"), ...history], current, { documents: [document], requirements })).rejects.toThrow("未开放");
            expect(calls.map(call => call.body.profileContext.stage)).toEqual(["plan", "repair"]);
            const repaired = calls[1].body;
            const pixels = repaired.input.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "input_image").map((part: any) => part.image_url) : []);
            expect(pixels).toHaveLength(4);
            expect(pixels).toContain(previewOf(image("old").dataUrl));
            expect(pixels).not.toContain(previewOf(image("figure").dataUrl));
            expect(repaired.profileContext).toMatchObject({ previewImageIds: ["old", "v3", "original", "v2"], focusImageId: "v3" });
            expect(repaired.input.at(-1)).toEqual({ role: "user", content: current.content });
        } finally { fixture.restore(); }
    });
    test.each(["load-failure", "abort", "oversized"])("old-image %s during repair makes no second planning request", async mode => {
        const controller = new AbortController(), calls: any[] = [];
        const oldSource = image("old").dataUrl;
        const fixture = previewFixture((loaded, failed, source) => {
            if (source === oldSource && mode === "load-failure") failed();
            else if (source === oldSource && mode === "abort") controller.abort();
            else loaded();
        }, source => source === oldSource && mode === "oversized" ? "data:image/jpeg;base64," + "A".repeat(2_097_160) : image("preview").dataUrl);
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(result({ base: "old" })); });
            await expect(requestCreativeChatPlan(config, [generated("old"), ...history], user("改旧图"), { signal: controller.signal })).rejects.toThrow();
            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe("/api/chat/responses");
        } finally { fixture.restore(); }
    });
    test("a repaired plan selecting a different unseen version refuses without a third request", async () => {
        const fixture = previewFixture(), calls: any[] = [];
        try {
            fakeFetch((url, body) => { calls.push({ url, body }); return Response.json(result({ base: calls.length === 1 ? "old-a" : "old-b" })); });
            await expect(requestCreativeChatPlan(config, [generated("old-a"), generated("old-b"), ...history], user("修改旧图"))).rejects.toBeInstanceOf(ImageAgentPlanningError);
            expect(calls).toHaveLength(2);
        } finally { fixture.restore(); }
    });
    test.each(["double-invalid", "repair-then-lookup-invalid", "lookup-then-repair"])("one repair budget covers %s across continuations", async mode => {
        const fixture = previewFixture(), calls: any[] = [];
        try {
            fakeFetch((url, body) => {
                calls.push({ url, body });
                if (mode === "double-invalid") return Response.json(result({ edit_spec: { changes: [] } }));
                if ((mode === "lookup-then-repair" && calls.length === 1) || (mode === "repair-then-lookup-invalid" && calls.length === 2)) return Response.json({ content: "查阅", toolCalls: [look(["original"])] });
                if (mode === "lookup-then-repair" && calls.length === 3) return Response.json(result({ edit_spec: spec }));
                return Response.json(result({ keep: "bad" }));
            });
            const request = requestCreativeChatPlan(config, history, user("修改袖口"));
            if (mode === "lookup-then-repair") expect(await request).toMatchObject({ kind: "image", parentId: "v3" });
            else await expect(request).rejects.toBeInstanceOf(ImageAgentPlanningError);
            expect(calls).toHaveLength(mode === "double-invalid" ? 2 : 3);
            expect(calls.filter(call => call.body.profileContext.stage === "repair")).toHaveLength(1);
            expect(calls.every(call => call.url === "/api/chat/responses")).toBe(true);
        } finally { fixture.restore(); }
    });
    test("lookup then typed repair satisfies the real server validator without breaking tool evidence adjacency", async () => {
        const fixture = previewFixture(), calls: any[] = [];
        const current = user("先看指定旧版，再把标题移到左上角");
        try {
            fakeFetch(async (url, body) => {
                calls.push({ url, body });
                try {
                    const prepared = await prepareChatProfileInput(body);
                    const response = calls.length === 1 ? { content: "先查看指定旧版", toolCalls: [look(["old"])] }
                        : calls.length === 2 ? result({ base: "old", keep: "invalid-list" }) : result({ base: "old", prompt: "以指定旧版为底图，将标题移到左上角。" });
                    return Response.json(validateChatProfileOutput(response, prepared.privateRules));
                } catch (error) {
                    if (!(error instanceof PromptOptimizationError)) throw error;
                    return Response.json({ error: error.code, message: error.message, ...imageAgentRepairMetadata(error) }, { status: error.status });
                }
            });
            const plan = await requestCreativeChatPlan(config, [generated("old"), ...history], current);
            expect(plan).toMatchObject({ kind: "image", parentId: "old", references: [{ id: "old", dataUrl: image("old").dataUrl }] });
            expect(calls).toHaveLength(3);
            expect(calls.map(call => call.body.profileContext.stage)).toEqual(["plan", "continue", "repair"]);
            const continued = calls[1]!.body.input, repaired = calls[2]!.body.input;
            expect(repaired.slice(0, -1)).toEqual(continued);
            expect(repaired.at(-1)).toEqual({ role: "user", content: current.content });
            const toolIndex = repaired.findIndex((item: any) => item.type === "function_call");
            expect(repaired[toolIndex + 1]).toMatchObject({ type: "function_call_output", call_id: repaired[toolIndex].call_id });
            expect(calls[2]!.body.profileContext).toMatchObject({ currentUserText: current.content, focusImageId: "v3", repairIssue: { code: "IMAGE_AGENT_ARGUMENTS_INVALID", submitted: false, repairable: true } });
            expect(calls[2]!.body.profileContext.previewImageIds).toContain("old");
            expect(calls.every(call => call.url === "/api/chat/responses")).toBe(true);
        } finally { fixture.restore(); }
    });
    test("abort after invalid response prevents repair and unknown document access never gets repaired", async () => {
        const fixture = previewFixture(); let calls = 0;
        try {
            const controller = new AbortController();
            fakeFetch(() => { calls++; controller.abort(); return Response.json(result({ keep: "bad" })); });
            await expect(requestCreativeChatPlan(config, history, user("改色"), { signal: controller.signal })).rejects.toThrow();
            expect(calls).toBe(1);
            calls = 0;
            fakeFetch(() => { calls++; return Response.json({ content: "", toolCalls: [{ id: "doc", type: "function", function: { name: "read_document", arguments: JSON.stringify({ document_id: "not-owned" }) } }] }); });
            await expect(requestCreativeChatPlan(config, history, user("读文件"))).rejects.toThrow();
            expect(calls).toBe(1);
        } finally { fixture.restore(); }
    });
});
