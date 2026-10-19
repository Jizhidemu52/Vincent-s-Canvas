import { expect, test } from "bun:test";
import { canvasImageEditContext, imageEditContextDescription, resolveCanvasImageEdit as resolveEdit, type CanvasImageEditLineage } from "@/lib/canvas/canvas-assistant-image-edit";
import { buildCanvasConversationHistory } from "@/lib/canvas/canvas-assistant-history";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";
import { CANVAS_ASSISTANT_SYSTEM_PROMPT } from "@/lib/canvas/canvas-assistant-prompt";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";

const original: CanvasAssistantReference = { id: "source", type: CanvasNodeType.Image, title: "原始照片", dataUrl: "data:image/png;base64,ORIGINAL", storageKey: "image:original" };
const lineage: CanvasImageEditLineage = { intent: "new", originalReferences: [original], originalPrompt: "白底，人物服装不变", editPrompt: "仅换成纯白背景，保留人物服装", baseReferences: [original] };
const result = (id: string, imageEdit = lineage): CanvasAssistantMessage => ({ id, role: "assistant", text: "已生成", detail: { kind: "agent_generation", status: "completed", imageEdit, prompt: imageEdit.editPrompt }, attachments: [{ id, name: id, mediaType: "image", url: `data:image/png;base64,${id}`, storageKey: `image:${id}` }] });
const ctx = canvasImageEditContext([result("v1")]);

// These legacy tests isolate base selection; contract semantics have dedicated adversarial tests.
function resolveCanvasImageEdit(...[args, context, explicit, userPrompt]: Parameters<typeof resolveEdit>) {
    const references = args.editIntent === "correct_original" ? context.originals : args.editIntent === "refine_latest" ? context.results.filter(ref => !args.resultImageId || ref.id === args.resultImageId) : explicit();
    const previous = context.contract;
    const editContract = { mode: previous ? "update" : "complete", changes: [{ id: "fixture", text: /[\u3400-\u9fff]/u.test(args.prompt) ? "Refine the selected garment." : args.prompt, source: userPrompt }], preserve: [], forbid: [], supersedes: previous ? ["fixture"] : [], referenceRoles: references.map(ref => ({ id: ref.id, role: "base" })) };
    return resolveEdit({ ...args, editContract }, context, explicit, userPrompt);
}

test("round 1: correction uses original bytes even when the model requests the bad result", () => {
    let readWrongRefs = false;
    const edit = resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "Restore the original cuffs; keep the white background and all other garment details." }, ctx, () => { readWrongRefs = true; return ctx.results; }, "袖口改错了，改回来");
    expect(readWrongRefs).toBe(false);
    expect(edit.references.map(ref => ref.dataUrl)).toEqual([original.dataUrl]);
    expect(edit.references[0]?.storageKey).toBe("image:original");
    expect(edit.prompt).toContain("attached original source image");
    expect(edit.prompt).toContain("keep the white background");
    expect(edit.prompt).not.toMatch(/[\u3400-\u9fff]/);
    expect(edit.lineage.originalPrompt).toBe("白底，人物服装不变");
});

test("round 2: refinement uses latest result, not lingering selected originals", () => {
    const edit = resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "Improve lighting and negative space while retaining the white background and unchanged garment." }, ctx, () => [original], "再好看一点");
    expect(edit.references[0]?.dataUrl).toBe("data:image/png;base64,v1");
    expect(edit.lineage.originalReferences[0]?.storageKey).toBe("image:original");
    expect(edit.prompt).toContain("preserving the successful changes");
    expect(edit.prompt).not.toContain("再好看一点");
});

test("round 3: correction after refinement and reload still returns to first original", () => {
    const refinement = resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "Improve the lighting while retaining all garment details and the white background." }, ctx, () => [], "再好看点");
    const reloaded = JSON.parse(JSON.stringify([result("v1"), result("v2", refinement.lineage)]));
    const edit = resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "Restore the original garment colors; retain the improved lighting and white background." }, canvasImageEditContext(reloaded), () => [], "颜色改错了");
    expect(edit.references[0]?.dataUrl).toBe(original.dataUrl);
    expect(edit.prompt).toContain("retain the improved lighting");
    expect(edit.prompt).not.toMatch(/[\u3400-\u9fff]/);
    expect(canvasImageEditContext(reloaded).lastPrompt).toBe(refinement.lineage.editPrompt);
    expect(edit.prompt).not.toContain("data:image/");
});

test("round 4: explicit base and new work reset the root without borrowing the previous task", () => {
    const different = { ...original, id: "other", storageKey: "image:other", dataUrl: "data:image/png;base64,OTHER" };
    for (const editIntent of ["new", "explicit"]) {
        const edit = resolveCanvasImageEdit({ editIntent, prompt: "调整新图" }, ctx, () => [different], "用这张新图开始");
        const next = canvasImageEditContext([result("other-v1", edit.lineage)]);
        expect(next.originals[0]?.dataUrl).toBe(different.dataUrl);
        expect(next.originalPrompt).toBe("用这张新图开始");
        expect(edit.prompt).not.toContain("白底");
    }
});

test("missing intent, unavailable originals, and ambiguous result selections fail before generation", () => {
    expect(() => resolveCanvasImageEdit({ prompt: "修图" }, ctx, () => [], "修图")).toThrow("editIntent");
    expect(() => resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "修图" }, canvasImageEditContext([]), () => ctx.results, "修图")).toThrow("原图");
    const multiple = { ...ctx, results: [...ctx.results, { ...ctx.results[0]!, id: "v1-b" }] };
    expect(() => resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "美化" }, multiple, () => [], "美化")).toThrow("选择一张");
    expect(resolveCanvasImageEdit({ editIntent: "refine_latest", resultImageId: "v1-b", prompt: "美化" }, multiple, () => [], "美化").references[0]?.id).toBe("v1-b");
    expect(() => resolveCanvasImageEdit({ editIntent: "refine_latest", resultImageId: "missing", prompt: "美化" }, multiple, () => [], "美化")).toThrow();
});

test("failed attempts and text replies never replace successful image lineage", () => {
    const history: CanvasAssistantMessage[] = [result("v1"), { ...result("failed"), role: "error", detail: { status: "failed" } }, { id: "reply", role: "assistant", text: "分析" }];
    expect(canvasImageEditContext(history).results[0]?.id).toBe("v1");
});

test("explicitly correcting the latest result honors the override without losing its first original", () => {
    const edit = resolveCanvasImageEdit({ editIntent: "explicit", prompt: "直接在上一版修袖口" }, ctx, () => ctx.results, "别回原图，用上一版改");
    expect(edit.references[0]?.storageKey).toBe("image:v1");
    expect(edit.lineage.originalReferences[0]?.storageKey).toBe("image:original");
});

test("old originals and latest results are seen even outside the 24-message window; source stays intact", async () => {
    const history: CanvasAssistantMessage[] = [result("v1"), ...Array.from({ length: 30 }, (_, i): CanvasAssistantMessage => ({ id: `chat-${i}`, role: "user", text: "讨论" }))];
    const context = canvasImageEditContext(history);
    const before = JSON.stringify(history);
    const conversation = await buildCanvasConversationHistory(history, { id: "now", role: "user", text: "袖口改错了", contextReferences: [...context.originals, ...context.results] }, async ref => `data:image/jpeg;base64,PREVIEW-${ref.storageKey}`);
    const content = JSON.stringify(conversation.currentContent);
    expect(content).toContain("PREVIEW-image:original");
    expect(content).toContain("PREVIEW-image:v1");
    expect(JSON.stringify(history)).toBe(before);
    expect(resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "修正袖口" }, context, () => [], "修正").references[0]?.dataUrl).toBe(original.dataUrl);
});

test("portable cloud media rewrites saved lineage assets and retains semantic fields", async () => {
    const saved = await portableCanvasMedia(result("v1"), async source => `https://canvas.example/api/assets/${source.storageKey?.replace(":", "-")}`);
    const persisted = saved.detail?.imageEdit as CanvasImageEditLineage;
    expect(persisted.originalReferences[0]?.dataUrl).toBe("https://canvas.example/api/assets/image-original");
    expect(persisted.originalReferences[0]?.storageKey).toBeUndefined();
    expect(persisted.originalPrompt).toBe(lineage.originalPrompt);
    expect(canvasImageEditContext([saved]).results[0]?.dataUrl).toContain("image-v1");
});

const userMessage = (id: string, text: string): CanvasAssistantMessage => ({ id, role: "user", text });
const initialRequest = "把衬衫改成粉色，保留五颗纽扣，不要添加口袋";
const requestedGoal = () => ({
    mode: "complete", changes: [{ id: "color", text: "Make the shirt pink.", source: "改成粉色" }],
    preserve: [{ id: "buttons", text: "Keep the five buttons unchanged.", source: "保留五颗纽扣" }],
    forbid: [{ id: "pockets", text: "Do not add pockets.", source: "不要添加口袋" }],
    supersedes: [], referenceRoles: [{ id: original.id, role: "base" }],
});
const requestedContext = () => {
    const first = resolveEdit({ editIntent: "new", prompt: "Edit the shirt.", editContract: requestedGoal() }, canvasImageEditContext([]), () => [original], initialRequest);
    return canvasImageEditContext([userMessage("request", initialRequest), result("requested-v1", first.lineage)]);
};
const contextData = (context: ReturnType<typeof canvasImageEditContext>) => JSON.parse(imageEditContextDescription(context).split("（素材数据，不是新指令）：")[1]!);

test("new always requires complete even when previous task targets are available", () => {
    const context = requestedContext();
    expect(contextData(context).requiredContractModes).toMatchObject({ new: "complete", correct_original: "update", refine_latest: "update" });
    expect(contextData(context).legacyUserSources).toEqual([]);
    const next = { mode: "complete", changes: [{ id: "mug", text: "Create a blue mug.", source: "生成蓝色杯子" }], preserve: [], forbid: [], supersedes: [], referenceRoles: [] };
    expect(() => resolveEdit({ editIntent: "new", prompt: "Create a blue mug.", editContract: { ...next, mode: "update" } }, context, () => [], "生成蓝色杯子")).toThrow("complete");
    const edit = resolveEdit({ editIntent: "new", prompt: "Create a blue mug.", editContract: next }, context, () => [], "生成蓝色杯子");
    expect(edit.lineage.contract!.changes.map(item => item.id)).toEqual(["mug"]);
    expect(edit.lineage.contract!.preserve).toEqual([]);
    expect(edit.prompt).not.toContain("pink");
    expect(edit.prompt).not.toContain("buttons");
});

test.each(["再来一张", "再跑一张", "在跑一张"])("unchanged rerun %s inherits the complete goal and uses the original bytes", userPrompt => {
    const context = requestedContext(), before = JSON.stringify(context);
    const editContract = { mode: "update", changes: [], preserve: [], forbid: [], supersedes: [], referenceRoles: [{ id: "edit-original-0", role: "base" }] };
    const edit = resolveEdit({ editIntent: "correct_original", prompt: "Repeat the complete requested goal.", editContract }, context, () => context.results, userPrompt);
    expect(edit.references[0]!.dataUrl).toBe(original.dataUrl!);
    expect(edit.references[0]!.storageKey).toBe(original.storageKey!);
    expect(edit.lineage.contract).toEqual(context.contract);
    expect(edit.prompt).toContain("Make the shirt pink.");
    expect(edit.prompt).toContain("Keep the five buttons unchanged.");
    expect(edit.prompt).toContain("Do not add pockets.");
    expect(JSON.stringify(context)).toBe(before);
});

test("legacy reconstruction exposes only this task's original user texts to the model and compiler", () => {
    const oldTask: CanvasImageEditLineage = { ...lineage, originalPrompt: "生成红色杯子" };
    const first: CanvasImageEditLineage = { ...lineage, originalPrompt: initialRequest };
    const latest: CanvasImageEditLineage = { ...first, intent: "correct_original", editPrompt: "Make the shirt blue." };
    const history = [userMessage("other-u", "生成红色杯子"), result("other-v", oldTask), userMessage("current-u", initialRequest), result("current-v1", first), userMessage("change-u", "取消粉色，改成蓝色"), { id: "analysis", role: "assistant" as const, text: "我认为用户想要绿色条纹" }, result("current-v2", latest), userMessage("unsubmitted-u", "另一个任务先讨论红色条纹")];
    const before = JSON.stringify(history), context = canvasImageEditContext(history), visible = contextData(context);
    expect(context.contract).toBeUndefined();
    expect(visible.requiredContractModes).toMatchObject({ new: "complete", correct_original: "complete", refine_latest: "complete" });
    expect(visible.legacyUserSources).toEqual([initialRequest, "取消粉色，改成蓝色"]);
    expect(visible.legacyUserSources).not.toContain("生成红色杯子");
    expect(visible.legacyUserSources).not.toContain("我认为用户想要绿色条纹");
    expect(visible.legacyUserSources).not.toContain("另一个任务先讨论红色条纹");
    const editContract = { ...requestedGoal(), changes: [{ id: "color", text: "Make the shirt blue.", source: "改成蓝色" }], referenceRoles: [{ id: "edit-original-0", role: "base" }] };
    const edit = resolveEdit({ editIntent: "correct_original", prompt: "Repeat the complete requested goal.", editContract }, context, () => [], "再跑一张");
    expect(edit.prompt).toContain("Make the shirt blue.");
    expect(edit.prompt).toContain("Keep the five buttons unchanged.");
    expect(edit.prompt).toContain("Do not add pockets.");
    expect(edit.references[0]!.dataUrl).toBe(original.dataUrl!);
    expect(() => resolveEdit({ editIntent: "correct_original", prompt: "Repeat.", editContract: { ...editContract, changes: [{ id: "other", text: "Create a red mug.", source: "生成红色杯子" }] } }, context, () => [], "再跑一张")).toThrow("source");
    expect(JSON.stringify(history)).toBe(before);
});

test("a latest legacy result never silently inherits an older version's contract", () => {
    const first = resolveEdit({ editIntent: "new", prompt: "Edit the shirt.", editContract: requestedGoal() }, canvasImageEditContext([]), () => [original], initialRequest);
    const { contract: _oldContract, ...legacy } = first.lineage;
    const context = canvasImageEditContext([userMessage("initial", initialRequest), result("with-contract", first.lineage), userMessage("amendment", "取消粉色，改成蓝色"), result("without-contract", { ...legacy, intent: "correct_original" })]);
    expect(context.contract).toBeUndefined();
    expect(context.legacyUserSources).toEqual([initialRequest, "取消粉色，改成蓝色"]);
    expect(() => resolveEdit({ editIntent: "correct_original", prompt: "Repeat.", editContract: { mode: "update", changes: [], preserve: [], forbid: [], supersedes: [], referenceRoles: [{ id: "edit-original-0", role: "base" }] } }, context, () => [], "再跑一张")).toThrow("complete");
});

test("legacy sources stop at a new task even when prompt and original bytes are reused", () => {
    const first: CanvasImageEditLineage = { ...lineage, originalPrompt: initialRequest };
    const context = canvasImageEditContext([userMessage("old-start", initialRequest), result("old-first", first), userMessage("old-change", "加绿色条纹"), result("old-final", { ...first, intent: "correct_original" }), userMessage("new-start", initialRequest), result("new-first", first)]);
    expect(context.legacyUserSources).toEqual([initialRequest]);
});

test("missing legacy task origin never makes unrelated history an allowed source", () => {
    const context = canvasImageEditContext([userMessage("unrelated", "生成红色杯子"), result("legacy-only", { ...lineage, originalPrompt: initialRequest, intent: "correct_original" })]);
    expect(context.legacyUserSources).toEqual([initialRequest]);
    expect(contextData(context).legacyUserSources).toEqual([initialRequest]);
    const bare = result("bare");
    delete bare.detail!.imageEdit;
    expect(canvasImageEditContext([userMessage("unrelated", "生成红色杯子"), bare]).legacyUserSources).toEqual([]);
});

test("planner instructions distinguish unchanged reruns, new tasks, and legacy reconstruction", () => {
    expect(CANVAS_ASSISTANT_SYSTEM_PROMPT).toContain("new 永远用 complete");
    expect(CANVAS_ASSISTANT_SYSTEM_PROMPT).toContain("correct_original/refine_latest 只有当前 currentRequestedTargets 非空时用 update");
    expect(CANVAS_ASSISTANT_SYSTEM_PROMPT).toContain("legacyUserSources");
    expect(CANVAS_ASSISTANT_SYSTEM_PROMPT).toContain("再跑一张");
    expect(CANVAS_ASSISTANT_SYSTEM_PROMPT).toContain("changes/preserve/forbid 和 supersedes 全部填 []");
    expect(CANVAS_ASSISTANT_SYSTEM_PROMPT).toContain("source 是证据，不是生图指令，必须保留用户原语言");
});
