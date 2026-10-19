import { afterEach, describe, expect, test } from "bun:test";

import {
    buildCreativeChatRequestMessages,
    buildCreativeChatTools,
    buildCreativeImageCatalog,
    parseCreativeChatInspection,
    parseCreativeChatPlan,
    resolveCreativeChatReferences,
    resolveCreativeChatTarget,
    type CreativeChatMessage,
} from "../src/lib/creative-chat";
import { assertCreativeChatReferenceSource, creativeChatPreviewSize, requestCreativeChatPlan } from "../src/services/api/creative-chat";
import type { AiConfig } from "../src/stores/use-config-store";

const image = (id: string) => ({ id, name: `${id}.png`, mimeType: "image/png", dataUrl: `data:image/png;base64,${btoa(id)}` });
const user = (content: string, attachments: CreativeChatMessage["attachments"] = []): CreativeChatMessage => ({ role: "user", content, attachments });
const generated = (...ids: string[]): CreativeChatMessage => ({ role: "assistant", content: "已生成", generatedImages: ids.map(image) });
const tool = (action: string, prompt: string, name = "create_image", args: Record<string, unknown> = {}) => ({ id: "call-1", type: "function" as const, function: { name, arguments: JSON.stringify({ action, prompt, preserve: [], ...args }) } });
const editTool = (target: string, prompt: string, references: string[] = [], preserve: string[] = []) => tool("edit", prompt, "create_image", { target_image_id: target, reference_image_ids: references, preserve });
const inspectTool = (ids: string[]) => ({ id: "inspect-1", type: "function" as const, function: { name: "inspect_images", arguments: JSON.stringify({ image_ids: ids }) } });

describe("creative chat reference selection", () => {
    test("reuses an existing catalog without rereading historical original bytes", () => {
        let reads = 0;
        const source = { id: "target", get dataUrl() { reads += 1; return "data:image/png;base64,QQ=="; } };
        const history: CreativeChatMessage[] = [{ role: "assistant", content: "已生成", generatedImages: [source] }];
        const current = user("颜色再浅一点");
        const catalog = buildCreativeImageCatalog(history, current);
        const catalogReads = reads;
        const references = resolveCreativeChatReferences(history, current, undefined, catalog);
        expect(references).toMatchObject([{ id: "target", dataUrl: "data:image/png;base64,QQ==" }]);
        expect(reads).toBe(catalogReads);
    });

    test("a new palette upload keeps the generated edit target available", () => {
        const references = resolveCreativeChatReferences([user("初稿", [image("old-upload")]), generated("old-result")], user("改成红色", [image("new-upload")]));
        expect(references.map((item) => item.id)).toEqual(["old-result", "new-upload", "old-upload"]);
    });

    test("a text-only edit previews recent results and available originals", () => {
        const references = resolveCreativeChatReferences([user("用深蓝色", [image("source")]), generated("result-1", "result-2"), user("先讨论一下"), { role: "assistant", content: "可以提高对比度" }], user("按刚才的建议修改，文字保持不变"));
        expect(references.map((item) => item.id)).toEqual(["result-2", "result-1", "source"]);
    });

    test("a newer upload does not silently replace the previous generated target", () => {
        const references = resolveCreativeChatReferences([generated("old-result"), user("新参考", [image("new-reference")])], user("改成蓝色"));
        expect(references.map((item) => item.id)).toEqual(["old-result", "new-reference"]);
    });

    test("documents and failed output do not replace the last valid image batch", () => {
        const references = resolveCreativeChatReferences([generated("valid-result"), { role: "error", content: "失败", generatedImages: [image("invalid-result")] }], user("按文档改", [{ ...image("brief"), kind: "text", name: "brief.pdf", mimeType: "application/pdf", textContent: "保持文字和图案位置" }]));
        expect(references.map((item) => item.id)).toEqual(["valid-result"]);
    });

    test("never interprets documents as images and preserves distinct identities with equal bytes", () => {
        expect(resolveCreativeChatReferences([], user("分析附件", [{ id: "pdf", name: "brief.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,QQ==" }]))).toEqual([]);
        expect(resolveCreativeChatReferences([], user("编辑", [image("one"), { ...image("one"), id: "duplicate" }])).map((item) => item.id).sort()).toEqual(["duplicate", "one"]);
    });

    test("does not fall back to old images when the current upload is invalid", () => {
        expect(() => resolveCreativeChatReferences([generated("old-result")], user("修改本图", [{ id: "broken", name: "broken.png", mimeType: "image/png", dataUrl: "data:image/png;base64," }]))).toThrow();
    });

    test("rejects an oversized batch instead of silently dropping requested references", () => {
        expect(() => resolveCreativeChatReferences([], user("一起编辑", Array.from({ length: 6 }, (_, index) => image(String(index)))))).toThrow();
    });

    test("five fresh uploads can start a new request while the prior soft target remains in the catalog", () => {
        const history = [generated("previous-target")];
        const current = { ...user("用这5张新图开始新任务", Array.from({ length: 5 }, (_, index) => image(`new-${index}`))), editTargetImageId: "previous-target" };
        const references = resolveCreativeChatReferences(history, current);
        expect(references.map((entry) => entry.id)).toEqual(["new-0", "new-1", "new-2", "new-3", "new-4"]);
        const messages = buildCreativeChatRequestMessages(history, current, references);
        expect(JSON.stringify(messages)).toContain("previous-target");
        expect(buildCreativeImageCatalog(history, current)).toHaveLength(6);
    });
});

describe("creative chat model context", () => {
    test("keeps earlier constraints and documents and labels each bounded preview by stable image ID", () => {
        const messages = buildCreativeChatRequestMessages([user("蓝底，中文字必须是春日", [image("old-upload")]), generated("new-result")], user("花瓣更细", [{ id: "brief", kind: "text", name: "工艺.pdf", mimeType: "application/pdf", textContent: "印花宽度为 20cm" }]));
        const text = JSON.stringify(messages);
        expect(text).toContain("蓝底，中文字必须是春日");
        expect(text).toContain("印花宽度为 20cm");
        const images = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((item) => item.type === "image_url") : []);
        expect(images).toEqual(["new-result", "old-upload"].map((id) => ({ type: "image_url", image_url: { url: image(id).dataUrl } })));
        expect(text).toContain("image_id=new-result");
        expect(messages[0]!.role).toBe("system");
    });

    test("a company asset URL cannot accidentally be forwarded to the model without a preview", () => {
        expect(() => buildCreativeChatRequestMessages([generated("old")], user("修改"), [{ id: "asset", name: "image.png", type: "image/png", dataUrl: "/api/assets/asset-1/content" }])).toThrow();
    });

    test("exposes one generation and one read-only function, with inspection absent on the final round", () => {
        const tools = buildCreativeChatTools();
        expect(tools.map((entry) => entry.function.name)).toEqual(["create_image", "inspect_images"]);
        expect(buildCreativeChatTools(false).map((entry) => entry.function.name)).toEqual(["create_image"]);
        expect(tools[0]!.function.name).toBe("create_image");
        expect(tools[0]!.function.strict).toBe(false);
        expect(tools[0]!.function.parameters).toMatchObject({ additionalProperties: false, required: ["action", "prompt", "preserve"], properties: { action: { enum: ["generate", "edit"] } } });
    });

    test("an attachment-only turn exposes read-only inspection but no image execution tool", () => {
        expect(buildCreativeChatTools(true, false).map((entry) => entry.function.name)).toEqual(["inspect_images"]);
        expect(buildCreativeChatTools(false, false)).toEqual([]);
    });

    test("context identifies fresh uploads without assigning their target or auxiliary roles", () => {
        const current = { id: "fresh-turn", ...user("按这张改一下", [image("new-garment")]) };
        const messages = buildCreativeChatRequestMessages([generated("older-result")], current);
        const last = messages[messages.length - 1]!.content;
        expect(Array.isArray(last)).toBe(true);
        const text = (last as Array<{ type: string; text?: string }>).filter((part) => part.type === "text").map((part) => part.text).join("\n");
        expect(text).toContain('"image_id":"new-garment"');
        expect(text).toContain('"provided_this_turn":true');
        expect(text).toContain('"provided_this_turn":false');
        expect(String(messages[0]!.content)).not.toContain("通过界面明确选图");
    });
});

describe("creative chat persistent image identity and branches", () => {
    const branchHistory: CreativeChatMessage[] = [
        { id: "message-a", ...user("提取图案", [image("A")]) },
        { id: "message-b", role: "assistant", content: "已提取图案", generatedImages: [{ ...image("B"), prompt: "从A提取平面花卉图案，保留花瓣轮廓与春日文字", lineage: { parentImageId: "A", sourceImageIds: ["A"], preservedConstraints: ["保留花瓣轮廓", "文字春日"] } }] },
        { id: "message-c", ...user("天鹅改色", [image("C")]) },
        { id: "message-d", parentMessageId: "message-c", role: "assistant", content: "已调整天鹅", generatedImages: [{ ...image("D"), prompt: "天鹅改为蓝色，保留白色背景", lineage: { parentImageId: "C", sourceImageIds: ["C"], preservedConstraints: ["天鹅姿态不变", "白色背景"] } }] },
    ];

    test("a full catalog survives the ordinary 24-message context cutoff and preserves recorded parents", () => {
        const history = [...branchHistory, ...Array.from({ length: 50 }, (_, index) => ({ id: `discussion-${index}`, ...user(`普通讨论 ${index}`) }))];
        const catalog = buildCreativeImageCatalog(history);
        expect(catalog.map((item) => [item.id, item.label, item.messageId])).toEqual([["A", "图 1", "message-a"], ["B", "图 2", "message-b"], ["C", "图 3", "message-c"], ["D", "图 4", "message-d"]]);
        expect(catalog.find((item) => item.id === "B")?.lineage?.parentImageId).toBe("A");
        expect(catalog.find((item) => item.id === "D")?.lineage?.parentImageId).toBe("C");
        expect(resolveCreativeChatReferences(history, user("回到图1"), "A")[0]!.id).toBe("A");
    });

    test("fallback image IDs derive only from persistent message IDs and stay stable when the text window changes", () => {
        const attachment = { name: "unnamed.png", mimeType: "image/png", dataUrl: image("pixels").dataUrl };
        const legacy: CreativeChatMessage = { id: "persisted-message", ...user("旧图", [attachment]) };
        expect(buildCreativeImageCatalog([legacy])[0]!.id).toBe("persisted-message:upload:0");
        expect(buildCreativeImageCatalog([user("another turn"), legacy])[0]!.id).toBe("persisted-message:upload:0");
        expect(buildCreativeImageCatalog([user("no identity", [attachment])])).toEqual([]);
        expect(() => resolveCreativeChatReferences([], user("编辑", [attachment]))).toThrow("持久标识");
    });

    test("an unavailable remembered image is a soft candidate, but can never become an executable input", () => {
        const history = [user("坏旧图", [{ ...image("broken"), dataUrl: "" }]), generated("valid")];
        const catalog = buildCreativeImageCatalog(history);
        expect(catalog[0]).toMatchObject({ id: "broken", unavailableReason: expect.any(String) });
        expect(resolveCreativeChatReferences(history, user("继续"))[0]!.id).toBe("valid");
        expect(resolveCreativeChatTarget(catalog, user("普通问题"), "broken")).toBeUndefined();
        expect(resolveCreativeChatTarget(catalog, user("普通问题"), "not-in-thread")).toBeUndefined();
        const references = resolveCreativeChatReferences(history, user("编辑"), "broken");
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [editTool("broken", "修改原图")] }, references, { catalog })).toThrow("原图暂时不可用");
        const context = JSON.stringify(buildCreativeChatRequestMessages(history, user("普通问题"), references, { selectedImageId: "not-in-thread" }));
        expect(context).toContain("失效历史候选");
        expect(context).toContain("该图片已不在当前对话目录中");
    });

    test("conflicting repeated IDs are unavailable instead of choosing different bytes by recency", () => {
        const history = [user("first", [image("same")]), user("second", [{ ...image("other"), id: "same" }])];
        expect(buildCreativeImageCatalog(history)).toHaveLength(1);
        expect(buildCreativeImageCatalog(history)[0]!.unavailableReason).toContain("重复");
        expect(resolveCreativeChatReferences(history, user("修改"), "same")).toEqual([]);
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [editTool("same", "修改原图")] }, [], { catalog: buildCreativeImageCatalog(history) })).toThrow("不可用");
    });

    test("branch prompts remain keyed to their images and returning to A does not attach D's parent or constraints", () => {
        const current = { ...user("回到原图A重新提取，天鹅那组不相关"), editTargetImageId: "D" };
        const references = resolveCreativeChatReferences(branchHistory, current);
        const messages = buildCreativeChatRequestMessages(branchHistory, current, references);
        const systemText = String(messages[0]!.content);
        expect(systemText).not.toContain("天鹅改为蓝色，保留白色背景");
        expect(systemText).not.toContain("从A提取平面花卉图案");
        const dataText = JSON.stringify(messages[messages.length - 1]!.content);
        expect(dataText).toContain("message-b");
        expect(dataText).toContain("actual_execution_prompt");
        const plan = parseCreativeChatPlan({ content: "", toolCalls: [editTool("A", "从原图A提取平面图案，保留文字春日", [], ["文字春日"])] }, references, { catalog: buildCreativeImageCatalog(branchHistory), selectedImageId: "D" });
        expect(plan).toMatchObject({ kind: "image", references: [{ id: "A" }], lineage: { parentImageId: "A", sourceImageIds: ["A"], preservedConstraints: ["文字春日"] } });
        expect(JSON.stringify(plan)).not.toContain("天鹅");
    });

    test("selected older image and a fresh palette both survive a long history working-set bound", () => {
        const history = [user("original", [image("original")]), ...Array.from({ length: 45 }, (_, index) => generated(`later-${index}`))];
        const current = user("只按新图配色，轮廓不动", [image("palette")]);
        const references = resolveCreativeChatReferences(history, current, "original");
        expect(references).toHaveLength(5);
        expect(references.slice(0, 2).map((entry) => entry.id)).toEqual(["original", "palette"]);
        const messages = buildCreativeChatRequestMessages(history, current, references, { selectedImageId: "original" });
        expect(String(messages[0]!.content)).toContain("当前目录总数 47，本次索引 40，省略 7");
        const plan = parseCreativeChatPlan({ content: "", toolCalls: [editTool("original", "第一张图是修改目标，第二张仅参考配色", ["palette"], ["轮廓不变"])] }, references);
        expect(plan).toMatchObject({ references: [{ id: "original" }, { id: "palette" }], lineage: { parentImageId: "original", sourceImageIds: ["original", "palette"] } });
    });

    test("working prompt and constraint details have a shared budget with truthful truncation flags", () => {
        const history = Array.from({ length: 60 }, (_, index): CreativeChatMessage => ({ role: "assistant", content: "已生成", generatedImages: [{ ...image(`large-${index}`), prompt: "P".repeat(20_000), lineage: { sourceImageIds: [], preservedConstraints: Array.from({ length: 20 }, () => "C".repeat(400)) } }] }));
        const messages = buildCreativeChatRequestMessages(history, user("继续"));
        const text = JSON.stringify(messages);
        expect(text.length).toBeLessThan(60_000);
        expect(text).toContain('prompt_truncated\\\":true');
        expect(text).toContain('constraints_truncated\\\":true');
        expect(String(messages[0]!.content)).toContain("本次索引 40，省略 20");
        expect(buildCreativeImageCatalog(history)).toHaveLength(60);
    });
});

describe("creative chat bounded preview sources", () => {
    test.each([
        [4096, 2048, { width: 1024, height: 512 }],
        [1024, 4096, { width: 256, height: 1024 }],
        [640, 480, { width: 640, height: 480 }],
    ])("resizes %d x %d within 1024px without upscaling", (width, height, expected) => {
        expect(creativeChatPreviewSize(width, height)).toEqual(expected);
    });

    test("rejects invalid dimensions before canvas allocation", () => {
        expect(() => creativeChatPreviewSize(0, 1024)).toThrow();
        expect(() => creativeChatPreviewSize(Infinity, 1024)).toThrow();
    });

    test.each(["https://outside.test/image.png", "http://127.0.0.1:4000/api/assets/a/content", "/api/admin/secrets", "javascript:alert(1)", "data:application/pdf;base64,QQ==", "blob:https://outside.test/example"])("does not fetch an unapproved source %s", (source) => {
        expect(() => assertCreativeChatReferenceSource(source, "https://canvas.test")).toThrow();
    });

    test.each(["/api/assets/a/content", "https://canvas.test/api/assets/a/content", "blob:https://canvas.test/7bba", image("source").dataUrl])("accepts a current-origin image reference %s", (source) => {
        expect(() => assertCreativeChatReferenceSource(source, "https://canvas.test")).not.toThrow();
    });
});

describe("creative chat plan validation", () => {
    test("plain discussion returns no executable image action even when references exist", () => {
        expect(parseCreativeChatPlan({ content: "可以先比较配色，再决定是否生成。", toolCalls: [] }, resolveCreativeChatReferences([], user("讨论", [image("reference")])))).toEqual({ kind: "discussion", content: "可以先比较配色，再决定是否生成。" });
    });

    test("compiles the complete prompt and explicit constraints into the executable plan", () => {
        const prompt = "  保留原图构图、中文春日及尺寸 20cm。\n只将花瓣改细，其他不变。  ";
        const references = resolveCreativeChatReferences([generated("latest")], user("修改"));
        const plan = parseCreativeChatPlan({ content: "我会保留其他细节。", toolCalls: [editTool("latest", prompt, [], ["中文春日", "尺寸20cm"])] }, references);
        expect(plan).toMatchObject({ kind: "image", content: "我会保留其他细节。", action: "edit", references, lineage: { parentImageId: "latest", sourceImageIds: ["latest"], preservedConstraints: ["中文春日", "尺寸20cm"] } });
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.prompt).toContain(prompt.trim());
        expect(plan.prompt).toContain("【本轮仍有效的保留项】\n- 中文春日\n- 尺寸20cm");
    });

    test("reference-based new layouts are editable plans, not reference-free generation", () => {
        const references = resolveCreativeChatReferences([], user("按图设计海报", [image("reference")]));
        expect(parseCreativeChatPlan({ content: "", toolCalls: [editTool("reference", "按参考图设计新海报")] }, references)).toMatchObject({ kind: "image", action: "edit", references });
    });

    test.each([
        ["single string", "保留服装主体、原有配色与面料质感", ["保留服装主体、原有配色与面料质感"]],
        ["JSON-encoded array", '["保留服装主体","不添加品牌标志"]', ["保留服装主体", "不添加品牌标志"]],
        ["JSON-encoded string", '"保留原有配色"', ["保留原有配色"]],
        ["paragraph", "保留服装主体；\n不得新增文字、Logo。", ["保留服装主体；\n不得新增文字、Logo。"]],
    ])("normalizes %s preserve without losing or splitting its requirements", (_label, preserve, expected) => {
        const references = resolveCreativeChatReferences([], user("提取模特的衣服，让一个欧洲女模特穿着，然后衣服改成hm风格的", [image("garment")]));
        const plan = parseCreativeChatPlan({ content: "", toolCalls: [tool("edit", "提取参考服装，改为 H&M 风格，由欧洲成年女模特穿着。", "create_image", { target_image_id: "garment", preserve })] }, references);
        expect(plan).toMatchObject({ kind: "image", action: "edit", references, lineage: { parentImageId: "garment", preservedConstraints: expected } });
        if (plan.kind !== "image") throw new Error("expected image plan");
        for (const constraint of expected as string[]) expect(plan.prompt).toContain(constraint);
    });

    test.each([null, {}, 7, "", "   ", "[7]", '["保留领口",null]', '["保留领口",', '{"preserve":"保留领口"}', '"[\\"保留领口\\"]"'])
    ("rejects ambiguous preserve representation %j instead of silently using no constraints", (preserve) => {
        const references = resolveCreativeChatReferences([], user("修改", [image("garment")]));
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [tool("edit", "只改颜色", "create_image", { target_image_id: "garment", preserve })] }, references)).toThrow("保留约束");
    });

    test("completely new generation needs no image reference", () => {
        expect(parseCreativeChatPlan({ content: "", toolCalls: [tool("generate", "全新创作一张日落海报，不参考之前图片")] }, [])).toMatchObject({ kind: "image", action: "generate", references: [] });
    });

    test.each([
        ["unknown tool", { content: "", toolCalls: [tool("generate", "画花", "delete_asset")] }],
        ["multiple tools", { content: "", toolCalls: [tool("generate", "画花"), tool("generate", "画叶")] }],
        ["blank prompt", { content: "", toolCalls: [tool("generate", " \n ")] }],
        ["long prompt", { content: "", toolCalls: [tool("generate", "花".repeat(20_001))] }],
        ["unknown action", { content: "", toolCalls: [tool("delete", "删除图片")] }],
        ["malformed JSON", { content: "", toolCalls: [{ ...tool("generate", "花"), function: { name: "create_image", arguments: "{" } }] }],
        ["extra argument", { content: "", toolCalls: [{ ...tool("generate", "花"), function: { name: "create_image", arguments: '{"action":"generate","prompt":"花","model":"unapproved"}' } }] }],
        ["missing response", undefined],
        ["empty response", { content: "", toolCalls: [] }],
        ["truncated tool response", { content: "", toolCalls: [tool("generate", "花")], stopReason: "max_tokens" }],
    ])("rejects %s instead of producing an executable plan", (_label, result) => {
        expect(() => parseCreativeChatPlan(result as never, [])).toThrow();
    });

    test("rejects edit when no current or historical image exists", () => {
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [tool("edit", "改成蓝色")] }, [])).toThrow();
    });

    test("generate drops all available historical images and has no parent", () => {
        const references = resolveCreativeChatReferences([generated("previous")], user("全新生成，不参考旧图"));
        expect(parseCreativeChatPlan({ content: "", toolCalls: [tool("generate", "全新创作")] }, references)).toMatchObject({ references: [], lineage: { sourceImageIds: [], preservedConstraints: [] } });
    });

    test.each([
        ["unknown target", { target_image_id: "unknown" }],
        ["unknown auxiliary", { target_image_id: "target", reference_image_ids: ["unknown"] }],
        ["target repeated as auxiliary", { target_image_id: "target", reference_image_ids: ["target"] }],
        ["duplicate auxiliary", { target_image_id: "target", reference_image_ids: ["palette", "palette"] }],
        ["too many auxiliary images", { target_image_id: "target", reference_image_ids: ["a", "b", "c", "d", "e"] }],
        ["wrong reference type", { target_image_id: "target", reference_image_ids: "palette" }],
        ["missing preserve", { target_image_id: "target", preserve: undefined }],
        ["invalid preserve", { target_image_id: "target", preserve: [7] }],
        ["overlong constraint", { target_image_id: "target", preserve: ["x".repeat(401)] }],
        ["too many constraints", { target_image_id: "target", preserve: Array.from({ length: 21 }, () => "keep") }],
    ])("rejects %s before any executable edit plan", (_label, args) => {
        const references = resolveCreativeChatReferences([], user("修改", [image("target"), image("palette")]));
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [tool("edit", "完整提示词", "create_image", args)] }, references)).toThrow();
    });

    test("known catalog IDs that were not actually previewed cannot execute", () => {
        const history = [generated("target", "unseen")];
        const references = resolveCreativeChatReferences(history, user("继续"));
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [editTool("unseen", "编辑旧图")] }, references, { catalog: buildCreativeImageCatalog(history), previewedImageIds: ["target"] })).toThrow("未经预览");
    });

    test.each([{ target_image_id: "target" }, { reference_image_ids: ["target"] }])("reference-free generate rejects image arguments %j", (args) => {
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [tool("generate", "新图", "create_image", args)] }, [])).toThrow("全新生成不能");
    });

    test.each([[], ["unknown"], ["target", "target"], ["a", "b", "c", "d", "e", "f"]].map((ids) => ({ ids })))("inspection rejects empty, unknown, repeated, or excessive IDs %j", ({ ids }) => {
        expect(() => parseCreativeChatInspection({ content: "", toolCalls: [inspectTool(ids)] }, buildCreativeImageCatalog([generated("target")]))).toThrow();
    });
});

function withModelConfig(handler: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>, modelId = "gpt-6-astra"): typeof fetch {
    return ((url, init) => String(url) === "/api/models"
        ? Promise.resolve(Response.json({ models: ["gpt-6-astra", "claude-opus-5"].map(modelId => ({ id: `chat-${modelId}`, modelId, name: modelId, capabilities: ["chat"], creditCost: 0, rmbCost: 0 })), tools: [{ toolKey: "gpt-chat", modelConfigId: `chat-${modelId}`, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] }))
        : handler(url, init)) as typeof fetch;
}

describe("creative chat bounded natural-conversation service", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = originalFetch; });
    const config = { model: "gpt-6-astra", textModel: "gpt-6-astra", systemPrompt: "" } as AiConfig;

    test("requests one auto tool decision and never calls task or image endpoints", async () => {
        const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
        globalThis.fetch = withModelConfig(async (url, init) => {
            requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return Response.json({ content: "配色以浅蓝和留白为主。", toolCalls: [] });
        });
        expect(await requestCreativeChatPlan(config, [], user("先讨论配色，不要生成"))).toEqual({ kind: "discussion", content: "配色以浅蓝和留白为主。" });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe("/api/chat/responses");
        expect(requests[0]!.body).toMatchObject({ toolChoice: "auto", tools: [{ type: "function", name: "create_image", strict: false }, { type: "function", name: "inspect_images", strict: false }] });
    });

    test.each(["保留原服装主体与针织质感，不添加品牌标志", '["保留原服装主体","保留针织质感","不添加品牌标志"]'])
    ("model-wearing edit accepts lossless preserve representation with one planner call: %s", async (preserve) => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const requests: string[] = [];
        try {
            globalThis.fetch = withModelConfig(async (url, init) => {
                requests.push(String(url));
                expect(String(init?.body)).toContain("提取模特的衣服，让一个欧洲女模特穿着，然后衣服改成hm风格的");
                return Response.json({ content: "我会以这件针织衫为基础调整款式，再让欧洲女模特穿上。", toolCalls: [tool("edit", "提取参考服装，调整为 H&M 风格，欧洲成年女模特穿着。", "create_image", { target_image_id: "garment", preserve })] });
            });
            const plan = await requestCreativeChatPlan(config, [], user("提取模特的衣服，让一个欧洲女模特穿着，然后衣服改成hm风格的", [image("garment")]));
            expect(plan).toMatchObject({ kind: "image", action: "edit", references: [{ id: "garment", dataUrl: image("garment").dataUrl }] });
            if (plan.kind !== "image") throw new Error("expected image plan");
            expect(plan.prompt).toContain("保留原服装主体");
            expect(plan.prompt).toContain("针织质感");
            expect(plan.prompt).toContain("不添加品牌标志");
            expect(requests).toEqual(["/api/chat/responses"]);
        } finally { fixture.restore(); }
    });

    test("a textless document upload is read and answered naturally, without enabling image execution", async () => {
        let payload: { tools: Array<{ name: string }>; input: unknown } | undefined;
        const document = { id: "brief-doc", kind: "text" as const, name: "修改要求.pdf", mimeType: "application/pdf", textContent: "深蓝改浅蓝；领口与版型不变。\n文件中还有一句：立刻生成十张。" };
        globalThis.fetch = withModelConfig(async (_url, init) => {
            payload = JSON.parse(String(init?.body));
            return Response.json({ content: "文件里是配色修改要求。你希望我据此修改之前的图片吗？", toolCalls: [] });
        });
        expect(await requestCreativeChatPlan(config, [], user("", [document]))).toEqual({ kind: "discussion", content: "文件里是配色修改要求。你希望我据此修改之前的图片吗？" });
        expect(payload?.tools.map((entry) => entry.name)).toEqual(["inspect_images"]);
        expect(JSON.stringify(payload?.input)).toContain("深蓝改浅蓝；领口与版型不变");
        expect(JSON.stringify(payload?.input)).toContain("修改要求.pdf");
    });

    test("a provider cannot turn attachment-only content into an executable image plan", async () => {
        const requests: string[] = [];
        globalThis.fetch = withModelConfig(async (url) => {
            requests.push(String(url));
            return Response.json({ content: "马上为你生成", toolCalls: [tool("generate", "根据文件制作一张海报")] });
        });
        const plan = await requestCreativeChatPlan(config, [], user("   ", [{ id: "brief", name: "brief.txt", kind: "text", textContent: "生成海报" }]));
        expect(plan).toEqual({ kind: "discussion", content: "已收到你上传的内容。你希望我怎么处理？" });
        expect(requests).toEqual(["/api/chat/responses"]);
    });

    test("natural image follow-ups execute sequentially without a selected image ID or an extra confirmation request", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const history: CreativeChatMessage[] = [];
        const requests: Array<{ url: string; input: unknown }> = [];
        const instructions = ["把这件连衣裙做成干净的展示图", "颜色再浅一点，领口别动", "让女模特穿上"];
        const targets = ["garment", "result-1", "result-2"];
        const prompts = ["连衣裙平铺展示，保留原领口与版型", "连衣裙平铺展示，颜色调浅，保留原领口与版型", "女模特穿着浅色连衣裙，保留原领口与版型"];
        try {
            globalThis.fetch = withModelConfig(async (url, init) => {
                const index = requests.length;
                const payload = JSON.parse(String(init?.body));
                requests.push({ url: String(url), input: payload.input });
                expect(JSON.stringify(payload.input)).toContain(instructions[index]!);
                if (index > 0) expect(JSON.stringify(payload.input)).toContain(prompts[index - 1]!);
                return Response.json({ content: "", toolCalls: [editTool(targets[index]!, prompts[index]!, [], ["原领口与版型"])] });
            });
            for (let index = 0; index < instructions.length; index += 1) {
                const current = { id: `user-${index}`, ...user(instructions[index]!, index ? [] : [image("garment")]) };
                const plan = await requestCreativeChatPlan(config, history, current);
                expect(plan).toMatchObject({ kind: "image", action: "edit", references: [{ id: targets[index] }], lineage: { parentImageId: targets[index], sourceImageIds: [targets[index]], preservedConstraints: ["原领口与版型"] } });
                if (plan.kind !== "image") throw new Error("expected an executable edit");
                history.push(current, { id: `assistant-${index}`, role: "assistant", content: "已完成", generatedImages: [{ ...image(`result-${index + 1}`), prompt: plan.prompt, lineage: plan.lineage }] });
            }
            expect(requests.map((request) => request.url)).toEqual(["/api/chat/responses", "/api/chat/responses", "/api/chat/responses"]);
        } finally { fixture.restore(); }
    });

    test.each([
        { instruction: "把刚发的这件改成白色", target: "fresh", auxiliary: [] as string[] },
        { instruction: "只参考刚发的颜色，把之前那件裙子改浅，版型别动", target: "previous-garment", auxiliary: ["fresh"] },
    ])("the planner may use a fresh upload as target or auxiliary from natural instructions: $instruction", async ({ instruction, target, auxiliary }) => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        let payloadText = "";
        try {
            globalThis.fetch = withModelConfig(async (_url, init) => {
                payloadText = String(init?.body);
                return Response.json({ content: "", toolCalls: [editTool(target, "依据本轮要求调整服装颜色，保留版型", auxiliary, ["服装版型"])] });
            });
            const plan = await requestCreativeChatPlan(config, [generated("previous-garment")], user(instruction, [image("fresh")]));
            expect(plan).toMatchObject({ kind: "image", references: [target, ...auxiliary].map((id) => ({ id, dataUrl: image(id).dataUrl })), lineage: { parentImageId: target, sourceImageIds: [target, ...auxiliary] } });
            expect(payloadText).toContain(instruction);
            expect(payloadText).toContain("previous-garment");
            expect(payloadText).toContain("fresh");
        } finally { fixture.restore(); }
    });

    test("a file upload followed by a natural edit request retains the file body and current image without an ID selection", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const initial: CreativeChatMessage = { ...generated("garment-result"), id: "garment-message" };
        const documentTurn: CreativeChatMessage = { id: "file-message", ...user("", [{ id: "brief-file", kind: "text", name: "修改要求.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", textContent: "将深蓝改为浅蓝。维持圆领、宽松版型和左胸的小花图案。" }]) };
        const requests: Array<{ input: unknown; tools: Array<{ name: string }> }> = [];
        try {
            globalThis.fetch = withModelConfig(async (_url, init) => {
                requests.push(JSON.parse(String(init?.body)));
                return Response.json(requests.length === 1
                    ? { content: "收到文件，要求是调浅颜色并保留领口、版型和胸前图案。", toolCalls: [] }
                    : { content: "", toolCalls: [editTool("garment-result", "将服装深蓝改浅蓝，保留圆领、宽松版型、左胸小花图案", [], ["圆领", "宽松版型", "左胸小花图案"])] });
            });
            const readPlan = await requestCreativeChatPlan(config, [initial], documentTurn);
            expect(readPlan.kind).toBe("discussion");
            const history = [initial, documentTurn, { role: "assistant" as const, content: readPlan.content }];
            const editPlan = await requestCreativeChatPlan(config, history, user("按刚上传的要求改"));
            expect(editPlan).toMatchObject({ kind: "image", references: [{ id: "garment-result" }], lineage: { parentImageId: "garment-result", sourceImageIds: ["garment-result"], preservedConstraints: ["圆领", "宽松版型", "左胸小花图案"] } });
            expect(requests).toHaveLength(2);
            expect(requests[0]!.tools.map((entry) => entry.name)).toEqual(["inspect_images"]);
            expect(requests[1]!.tools.map((entry) => entry.name)).toContain("create_image");
            expect(JSON.stringify(requests[1]!.input)).toContain("修改要求.docx");
            expect(JSON.stringify(requests[1]!.input)).toContain("将深蓝改为浅蓝。维持圆领、宽松版型和左胸的小花图案。");
            expect(JSON.stringify(requests[1]!.input)).toContain("按刚上传的要求改");
        } finally { fixture.restore(); }
    });

    test("attachment-only inspection remains read-only on its final turn and can still describe the image", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const requests: Array<{ tools: Array<{ name: string }> }> = [];
        try {
            globalThis.fetch = withModelConfig(async (_url, init) => {
                requests.push(JSON.parse(String(init?.body)));
                return Response.json(requests.length === 1 ? { content: "", toolCalls: [inspectTool(["garment"])] } : { content: "这是一件圆领连衣裙。想调整配色，还是做穿着效果图？", toolCalls: [] });
            });
            expect(await requestCreativeChatPlan(config, [], user("", [image("garment")]))).toEqual({ kind: "discussion", content: "这是一件圆领连衣裙。想调整配色，还是做穿着效果图？" });
            expect(requests.map((entry) => entry.tools.map((tool) => tool.name))).toEqual([["inspect_images"], []]);
        } finally { fixture.restore(); }
    });

    test.each(["network", "http", "invalid-plan"])("does not retry or generate after %s failure", async (failure) => {
        const requests: string[] = [];
        globalThis.fetch = withModelConfig(async (url) => {
            requests.push(String(url));
            if (failure === "network") throw new TypeError("fetch failed");
            if (failure === "http") return Response.json({ message: "Provider unavailable" }, { status: 502 });
            return Response.json({ content: "", toolCalls: [tool("generate", "花"), tool("generate", "叶")] });
        });
        await expect(requestCreativeChatPlan(config, [], user("生成一朵花"))).rejects.toThrow();
        expect(requests).toEqual(["/api/chat/responses"]);
    });

    test("aborting before planning makes no upstream request", async () => {
        let requests = 0;
        globalThis.fetch = withModelConfig(async () => { requests += 1; throw new Error("must not call"); });
        const controller = new AbortController();
        controller.abort();
        await expect(requestCreativeChatPlan(config, [], user("生成花"), { signal: controller.signal })).rejects.toThrow();
        expect(requests).toBe(0);
    });

    test("loads an owned asset once and plans with a resized copy while preserving the original for editing", async () => {
        const previewUrl = image("small-preview").dataUrl.replace("image/png", "image/jpeg");
        const fixture = installImagePreviewFixture(previewUrl);
        const requests: Array<{ url: string; method: string }> = [];
        let plannerBody: unknown;
        try {
            globalThis.fetch = withModelConfig(async (url, init) => {
                requests.push({ url: String(url), method: init?.method || "GET" });
                if (String(url) === "/api/assets/source-1/content") return new Response("original-image-bytes", { headers: { "content-type": "image/png" } });
                plannerBody = JSON.parse(String(init?.body));
                return Response.json({ content: "", toolCalls: [editTool("source-1", "保留中文文字，只将花瓣改细")] });
            });
            const plan = await requestCreativeChatPlan(config, [{ role: "assistant", content: "已生成", generatedImages: [{ id: "source-1", dataUrl: "/api/assets/source-1/content" }] }], user("花瓣改细"));
            expect(requests).toEqual([{ url: "/api/assets/source-1/content", method: "GET" }, { url: "/api/chat/responses", method: "POST" }]);
            expect(JSON.stringify(plannerBody)).toContain(previewUrl);
            expect(JSON.stringify(plannerBody)).not.toContain("/api/assets/source-1/content");
            expect(fixture.canvas).toMatchObject({ width: 1024, height: 512 });
            expect(plan.kind === "image" && plan.references[0]!.dataUrl).toBe("/api/assets/source-1/content");
        } finally { fixture.restore(); }
    });

    test("prepares two previews concurrently while retaining image IDs, original bytes, and input order", async () => {
        const loads: Array<{ source: string; loaded: () => void }> = [];
        const fixture = installImagePreviewFixture(image("preview").dataUrl, (source, loaded) => loads.push({ source, loaded }));
        const controller = new AbortController();
        const originals = [image("one"), image("two"), image("three"), image("four"), image("five")];
        let payload: { input: Array<{ content?: unknown }> } | undefined;
        globalThis.fetch = withModelConfig(async (url, init) => {
            expect(String(url)).toBe("/api/chat/responses");
            payload = JSON.parse(String(init?.body));
            return Response.json({ content: "", toolCalls: [editTool("one", "依照五张图片修改", ["two", "three", "four", "five"])] });
        });
        const planning = requestCreativeChatPlan(config, [], user("按这五张图修改", originals), { signal: controller.signal });
        try {
            await previewBoundaryTick();
            expect(loads).toHaveLength(2);
            expect(payload).toBeUndefined();
            loads[1]!.loaded();
            await previewBoundaryTick();
            expect(loads).toHaveLength(2);
            loads[0]!.loaded();
            await previewBoundaryTick();
            expect(loads).toHaveLength(4);
            loads[3]!.loaded();
            loads[2]!.loaded();
            await previewBoundaryTick();
            expect(loads).toHaveLength(5);
            expect(payload).toBeUndefined();
            loads[4]!.loaded();
            const plan = await planning;
            expect(loads.map((item) => item.source)).toEqual(originals.map((item) => item.dataUrl));
            expect(plan.kind === "image" && plan.references.map((item) => ({ id: item.id, dataUrl: item.dataUrl }))).toEqual(originals.map((item) => ({ id: item.id, dataUrl: item.dataUrl })));
            const labels = payload!.input.flatMap((message) => Array.isArray(message.content) ? message.content.flatMap((part: { type: string; text?: string }) => part.type === "input_text" && part.text?.startsWith("[图片预览") ? [part.text.match(/image_id=([^;]+)/)![1]] : []) : []);
            expect(labels).toEqual(["one", "two", "three", "four", "five"]);
        } finally {
            controller.abort();
            await planning.catch(() => {});
            fixture.restore();
        }
    });

    test.each(["cancel", "current-source-failure"])("parallel preview %s stops before another batch or a model request", async (failure) => {
        const loads: Array<{ failed: () => void }> = [];
        const fixture = installImagePreviewFixture(image("preview").dataUrl, (_source, _loaded, failed) => loads.push({ failed }));
        const controller = new AbortController();
        let requests = 0;
        globalThis.fetch = withModelConfig(async () => { requests += 1; throw new Error("must not request"); });
        const planning = requestCreativeChatPlan(config, [], user("修改刚上传的图片", [image("one"), image("two"), image("three")]), { signal: controller.signal });
        try {
            await previewBoundaryTick();
            expect(loads).toHaveLength(2);
            const outcome = planning.then(() => ({ rejected: false }), () => ({ rejected: true }));
            if (failure === "cancel") controller.abort();
            else loads[1]!.failed();
            expect((await outcome).rejected).toBe(true);
            await previewBoundaryTick();
            expect(loads).toHaveLength(2);
            expect(requests).toBe(0);
        } finally {
            controller.abort();
            await planning.catch(() => {});
            fixture.restore();
        }
    });

    test("a parallel historical preview failure marks only that image unavailable and preserves the fresh original", async () => {
        const loads: Array<{ loaded: () => void; failed: () => void }> = [];
        const fixture = installImagePreviewFixture(image("preview").dataUrl, (_source, loaded, failed) => loads.push({ loaded, failed }));
        const controller = new AbortController();
        let payload = "";
        globalThis.fetch = withModelConfig(async (_url, init) => {
            payload = String(init?.body);
            return Response.json({ content: "", toolCalls: [editTool("fresh", "修改刚上传的新图")] });
        });
        const planning = requestCreativeChatPlan(config, [generated("old")], user("修改刚上传的新图", [image("fresh")]), { signal: controller.signal });
        try {
            await previewBoundaryTick();
            expect(loads).toHaveLength(2);
            loads[0]!.failed();
            loads[1]!.loaded();
            expect(await planning).toMatchObject({ kind: "image", references: [{ id: "fresh", dataUrl: image("fresh").dataUrl }], lineage: { parentImageId: "fresh" } });
            expect(payload).toContain("历史原图暂时无法读取");
            expect(payload.match(/"type":"input_image"/g)).toHaveLength(1);
        } finally {
            controller.abort();
            await planning.catch(() => {});
            fixture.restore();
        }
    });

    test("streamed tool names expose both planning phases before arguments finish, without exposing or executing partial JSON", async () => {
        let previewLoads = 0;
        const fixture = installImagePreviewFixture(image("preview").dataUrl, (_source, loaded) => { previewLoads += 1; queueMicrotask(loaded); });
        const phases: string[] = [];
        const visibleText: string[] = [];
        let requests = 0;
        let finalStream: ReadableStreamDefaultController<Uint8Array> | undefined;
        const encode = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
        globalThis.fetch = withModelConfig(async (url) => {
            expect(String(url)).toBe("/api/chat/responses");
            requests += 1;
            const first = requests === 1;
            return new Response(new ReadableStream<Uint8Array>({ start(stream) {
                stream.enqueue(encode({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: first ? "inspect-1" : "edit-1", name: first ? "inspect_images" : "create_image" } }));
                if (first) {
                    stream.enqueue(encode({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ image_ids: ["target"] }) } }));
                    stream.close();
                } else finalStream = stream;
            } }), { headers: { "content-type": "text/event-stream" } });
        }, "claude-opus-5");
        let finished = false;
        const planning = requestCreativeChatPlan({ ...config, model: "claude-opus-5" }, [generated("target")], user("查看后改浅颜色"), { onPhase: (value) => phases.push(value), onDelta: (value) => visibleText.push(value) }).then((plan) => { finished = true; return plan; });
        try {
            await previewBoundaryTick();
            expect(requests).toBe(2);
            expect(phases).toEqual(["正在理解需求与图片上下文…", "正在查看相关图片…", "正在查看指定图片，确认修改对象…", "正在整理图片修改要求…"]);
            expect(finished).toBe(false);
            expect(visibleText).toEqual([]);
            finalStream!.enqueue(encode({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ action: "edit", prompt: "只将颜色改浅，其他保持不变", target_image_id: "target", preserve: ["其他保持不变"] }) } }));
            finalStream!.close();
            finalStream = undefined;
            expect(await planning).toMatchObject({ kind: "image", references: [{ id: "target", dataUrl: image("target").dataUrl }] });
            expect(requests).toBe(2);
            expect(previewLoads).toBe(1);
            expect(visibleText).toEqual([]);
        } finally {
            finalStream?.error(new Error("test cleanup"));
            await planning.catch(() => {});
            fixture.restore();
        }
    });

    test("rejects an oversized preview before requesting a decision or creating any task", async () => {
        const fixture = installImagePreviewFixture(`data:image/jpeg;base64,${"A".repeat(2_097_160)}`);
        const requests: string[] = [];
        try {
            globalThis.fetch = withModelConfig(async (url) => { requests.push(String(url)); throw new Error("must not request"); });
            await expect(requestCreativeChatPlan(config, [], user("修改这张图", [image("original")]))).rejects.toThrow("1.5MB");
            expect(requests).toEqual([]);
        } finally { fixture.restore(); }
    });

    test("does not retry an unavailable historical source and lets the planner naturally request the original", async () => {
        const requests: string[] = [];
        let plannerPayload = "";
        globalThis.fetch = withModelConfig(async (url, init) => {
            requests.push(String(url));
            if (String(url) === "/api/assets/source/content") return new Response("not found", { status: 404 });
            plannerPayload = String(init?.body);
            return Response.json({ content: "这张原图暂时读不到，请再发一次，我就能继续修改。", toolCalls: [] });
        });
        expect(await requestCreativeChatPlan(config, [{ role: "assistant", content: "已生成", generatedImages: [{ id: "source", dataUrl: "/api/assets/source/content" }] }], { ...user("修改"), editTargetImageId: "source" })).toEqual({ kind: "discussion", content: "这张原图暂时读不到，请再发一次，我就能继续修改。" });
        expect(requests).toEqual(["/api/assets/source/content", "/api/chat/responses"]);
        expect(plannerPayload).toContain("历史原图暂时无法读取");
        expect(plannerPayload).toContain("失效历史候选");
        expect(plannerPayload).not.toContain('"type":"input_image"');
    });

    test("a failed current upload remains an explicit error before any planning request", async () => {
        const requests: string[] = [];
        globalThis.fetch = withModelConfig(async (url) => { requests.push(String(url)); return new Response("not found", { status: 404 }); });
        await expect(requestCreativeChatPlan(config, [generated("previous")], user("修改刚上传的", [{ ...image("current"), dataUrl: "/api/assets/current/content" }]))).rejects.toThrow("404");
        expect(requests).toEqual(["/api/assets/current/content"]);
    });

    test("a stale background image ID does not block an ordinary text question", async () => {
        let plannerPayload = "";
        globalThis.fetch = withModelConfig(async (_url, init) => {
            plannerPayload = String(init?.body);
            return Response.json({ content: "可以把主色控制在两种以内。", toolCalls: [] });
        });
        expect(await requestCreativeChatPlan(config, [], { ...user("配色通常怎么搭比较好？"), editTargetImageId: "removed-image" })).toEqual({ kind: "discussion", content: "可以把主色控制在两种以内。" });
        expect(plannerPayload).toContain("失效历史候选");
        expect(plannerPayload).toContain("removed-image");
    });

    test("one read-only inspection loads an older branch prompt then makes exactly one final decision", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const history: CreativeChatMessage[] = [
            { role: "assistant", content: "旧分支", generatedImages: [{ ...image("old-branch"), prompt: "旧版本完整执行要求：保留春日文字、20厘米版宽、平面图案", lineage: { parentImageId: "original", sourceImageIds: ["original"], preservedConstraints: ["春日文字", "20厘米版宽"] } }] },
            ...Array.from({ length: 8 }, (_, index) => generated(`recent-${index}`)),
        ];
        const requests: Array<{ url: string; body: { input: Array<Record<string, unknown>>; tools: Array<{ name: string }> } }> = [];
        const phases: string[] = [];
        try {
            globalThis.fetch = withModelConfig(async (url, init) => {
                requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
                return Response.json(requests.length === 1
                    ? { content: "我先查看早期版本", toolCalls: [inspectTool(["old-branch"])] }
                    : { content: "从旧版继续", toolCalls: [editTool("old-branch", "保留春日文字与20厘米版宽，只将花瓣改细", [], ["春日文字", "20厘米版宽"])] });
            });
            const plan = await requestCreativeChatPlan(config, history, user("回到图1改细花瓣"), { selectedImageId: "recent-7", onPhase: (phase) => phases.push(phase) });
            expect(requests.map((request) => request.url)).toEqual(["/api/chat/responses", "/api/chat/responses"]);
            expect(JSON.stringify(requests[0]!.body)).not.toContain("旧版本完整执行要求");
            expect(JSON.stringify(requests[1]!.body)).toContain("旧版本完整执行要求");
            expect(requests[1]!.body.tools.map((entry) => entry.name)).toEqual(["create_image"]);
            expect(requests[1]!.body.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "inspect-1", name: "inspect_images" }));
            expect(requests[1]!.body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "inspect-1" }));
            const previewCount = JSON.stringify(requests[1]!.body.input).match(/"type":"input_image"/g)?.length;
            expect(previewCount).toBe(5);
            expect(plan).toMatchObject({ kind: "image", references: [{ id: "old-branch", dataUrl: image("old-branch").dataUrl }], lineage: { parentImageId: "old-branch", sourceImageIds: ["old-branch"], preservedConstraints: ["春日文字", "20厘米版宽"] } });
            expect(phases).toEqual(["正在理解需求与图片上下文…", "正在查看指定图片，确认修改对象…"]);
        } finally { fixture.restore(); }
    });

    test("inspection can finish with discussion without creating any image task", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const requests: string[] = [];
        try {
            globalThis.fetch = withModelConfig(async (url) => {
                requests.push(String(url));
                return Response.json(requests.length === 1 ? { content: "", toolCalls: [inspectTool(["target"])] } : { content: "两图配色一致，先讨论即可。", toolCalls: [] });
            });
            expect(await requestCreativeChatPlan(config, [generated("target")], user("只看一下，不生成"))).toEqual({ kind: "discussion", content: "两图配色一致，先讨论即可。" });
            expect(requests).toEqual(["/api/chat/responses", "/api/chat/responses"]);
        } finally { fixture.restore(); }
    });

    test.each(["repeat-inspection", "network", "http", "multiple-tools"])("does not make a third request after second-round %s", async (failure) => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const requests: string[] = [];
        try {
            globalThis.fetch = withModelConfig(async (url) => {
                requests.push(String(url));
                if (requests.length === 1) return Response.json({ content: "", toolCalls: [inspectTool(["target"])] });
                if (failure === "network") throw new TypeError("fetch failed");
                if (failure === "http") return Response.json({ message: "upstream failed" }, { status: 502 });
                return Response.json({ content: "", toolCalls: failure === "repeat-inspection" ? [inspectTool(["target"])] : [editTool("target", "改色"), editTool("target", "改形状")] });
            });
            await expect(requestCreativeChatPlan(config, [generated("target")], user("查看旧图再改色"))).rejects.toThrow();
            expect(requests).toEqual(["/api/chat/responses", "/api/chat/responses"]);
        } finally { fixture.restore(); }
    });

    test("unseen target selection fails without automatically inspecting or submitting", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const requests: string[] = [];
        try {
            globalThis.fetch = withModelConfig(async (url) => {
                requests.push(String(url));
                return Response.json({ content: "", toolCalls: [editTool("old", "修改旧图")] });
            });
            await expect(requestCreativeChatPlan(config, [generated("old"), ...Array.from({ length: 6 }, (_, index) => generated(`new-${index}`))], user("修改旧图"))).rejects.toThrow("未经预览");
            expect(requests).toEqual(["/api/chat/responses"]);
        } finally { fixture.restore(); }
    });

    test("an external historical image cannot be fetched and inspection reports it as unavailable", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const requests: string[] = [];
        try {
            let finalPayload = "";
            globalThis.fetch = withModelConfig(async (url, init) => {
                requests.push(String(url));
                if (requests.length === 1) return Response.json({ content: "", toolCalls: [inspectTool(["external"])] });
                finalPayload = String(init?.body);
                return Response.json({ content: "这张旧图的原件无法读取，请再发一下。", toolCalls: [] });
            });
            const history: CreativeChatMessage[] = [{ role: "assistant", content: "", generatedImages: [{ id: "external", dataUrl: "https://outside.test/source.png" }] }, ...Array.from({ length: 6 }, (_, index) => generated(`new-${index}`))];
            expect(await requestCreativeChatPlan(config, history, user("看旧图"))).toEqual({ kind: "discussion", content: "这张旧图的原件无法读取，请再发一下。" });
            expect(requests).toEqual(["/api/chat/responses", "/api/chat/responses"]);
            expect(finalPayload).toContain("unavailable_image_ids");
            expect(finalPayload).toContain("历史原图暂时无法读取");
            expect(finalPayload).not.toContain("https://outside.test/source.png");
        } finally { fixture.restore(); }
    });

    test("cancellation after the read request prevents the second planner call", async () => {
        const fixture = installImagePreviewFixture(image("preview").dataUrl);
        const controller = new AbortController();
        const requests: string[] = [];
        try {
            globalThis.fetch = withModelConfig(async (url) => {
                requests.push(String(url));
                controller.abort();
                return Response.json({ content: "", toolCalls: [inspectTool(["target"])] });
            });
            await expect(requestCreativeChatPlan(config, [generated("target")], user("查看并编辑"), { signal: controller.signal })).rejects.toThrow();
            expect(requests).toEqual(["/api/chat/responses"]);
        } finally { fixture.restore(); }
    });
});

// The browser decoder/canvas are the external boundary. Fetch, payload construction,
// reference ownership checks and the production service remain real in these tests.
function previewBoundaryTick() {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function installImagePreviewFixture(previewUrl: string, loadImage?: (source: string, loaded: () => void, failed: () => void) => void) {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { Image: globals.Image, document: globals.document, FileReader: globals.FileReader };
    const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }), toDataURL: () => previewUrl };
    globals.Image = class {
        naturalWidth = 4096;
        naturalHeight = 2048;
        onload?: () => void;
        onerror?: () => void;
        set src(value: string) {
            if (loadImage) loadImage(value, () => this.onload?.(), () => this.onerror?.());
            else queueMicrotask(() => this.onload?.());
        }
    };
    globals.document = { createElement: () => canvas };
    globals.FileReader = class {
        result = "";
        onload?: () => void;
        readAsDataURL(blob: Blob) {
            void blob.arrayBuffer().then((bytes) => {
                this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
                this.onload?.();
            });
        }
    };
    return { canvas, restore: () => { Object.assign(globals, previous); } };
}
