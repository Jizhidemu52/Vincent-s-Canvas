import { expect, test } from "bun:test";
import { resolveCanvasImageAgentEdit, validateCanvasImageAgentPlan, canvasImageAgentCatalog, canvasImageAgentDesignBrief, canvasImageAgentResultOps, canvasImageAgentReviewTarget, canvasImageAgentReviewFingerprint, canvasImageAgentReviewInputs, canvasImageAgentReviewMatches, canvasImageAgentCorrectionDraft, canvasImageAgentHistory, canvasImageAgentInspectionDetails, type CanvasImageAgentImage, type CanvasImageAgentRecord } from "@/lib/canvas/canvas-image-agent";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";
import { buildImageAgentContext } from "@/lib/image-agent/context";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { requestImageAgentPlanWithRepair } from "@/lib/image-agent/planning-repair";
import { ImageAgentPlanningError } from "../../shared/image-agent-iteration";
import { recoverOnlineAgentTask, type PendingOnlineAgentTask } from "@/lib/canvas/canvas-online-task-recovery";
import { CanvasNodeType, type CanvasAssistantMessage } from "@/types/canvas";

const image = (id: string, label: string): CanvasImageAgentImage => ({ id, label, name: label, kind: "upload", nodeId: id,
    storageKey: `image:${id}`, reference: { id, title: label, type: CanvasNodeType.Image, storageKey: `image:${id}` } });
const images = [image("base", "图1"), image("fabric", "图2")];
const selection = { focusId: "base", lockedImageId: "base", previewedIds: ["base", "fabric"], focusRevision: 2 };
const call = (args: unknown) => ({ toolCalls: [{ id: "edit", type: "function" as const, function: { name: "edit_image", arguments: JSON.stringify(args) } }] });

test("Canvas compiles bounded edit_spec without truncating the original prompt or altering image order", () => {
    const prompt = `完整设计说明-${"保留细节。".repeat(50)}-末尾仍需保留`;
    const result = resolveCanvasImageAgentEdit({ prompt, references: ["图2"], keep: ["两颗纽扣"], edit_spec: {
        changes: ["更换衣身面料"], region: "仅衣身",
        reference_roles: [{ image_id: "图1", role: "base", purpose: "版型底图" }, { image_id: "图2", role: "material", purpose: "面料纹理", do_not_transfer: "背景" }],
        acceptance: ["保留两颗纽扣"], assumptions: ["按现有比例处理"],
    } }, images, selection);
    expect(result.prompt).toContain(prompt);
    expect(result.prompt).toContain("除本次明确修改外，其余保持底图不变");
    expect(result.prompt).not.toContain("结果应满足");
    expect(result.prompt).toContain("不迁移：背景");
    expect(result.references.map(reference => reference.id)).toEqual(["base", "fabric"]);
    expect(result.record.spec?.reference_roles?.map(role => role.image_id)).toEqual(["base", "fabric"]);
    expect(result.record.note.keep).toEqual(["两颗纽扣"]);
    expect(result.record.spec?.acceptance).toEqual(["保留两颗纽扣"]);
});

test("Canvas plan preflight rejects malformed JSON/spec and incompatible roles before any execution", () => {
    expect(() => validateCanvasImageAgentPlan({ toolCalls: [{ function: { name: "edit_image", arguments: "{" } }] }, images, selection)).toThrow(ImageAgentPlanningError);
    for (const args of [{ prompt: "改面料", edit_spec: { changes: [] } }, { prompt: "改面料", edit_spec: { changes: ["改面料"], private: "invalid" } },
        { prompt: "改面料", references: ["图2"], edit_spec: { changes: ["改面料"], reference_roles: [{ image_id: "fabric", role: "base", purpose: "不能换底图" }] } }]) {
        expect(() => validateCanvasImageAgentPlan(call(args), images, selection)).toThrow(ImageAgentPlanningError);
    }
    const plain = { toolCalls: [{ function: { name: "canvas_get_selection", arguments: "{}" } }] };
    expect(validateCanvasImageAgentPlan(plain, images, selection)).toBe(plain);
});

test("each Canvas result and recovered node preserves only its own version's design brief", () => {
    const before: CanvasAgentSnapshot = { projectId: "project", title: "versions", selectedNodeIds: ["base"], connections: [], viewport: { x: 0, y: 0, k: 1 }, nodes: [
        { id: "base", title: "原图", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:base" } },
        { id: "unrelated", title: "未选其他分支", type: CanvasNodeType.Image, position: { x: 0, y: 200 }, width: 100, height: 100,
            metadata: { storageKey: "image:unrelated", imageAgent: { workId: "different-work", version: 2, note: { summary: "另一个作品", keep: [] }, spec: { changes: ["不属于本轮的金色背景"] } } } },
    ] };
    const record: CanvasImageAgentRecord = { sourceNodeId: "base", baseImageId: "canvas-image:base", workId: "base", referenceIds: ["canvas-image:base"], version: 2,
        note: { summary: "蓝色袖口", keep: ["纽扣不变"] }, spec: { changes: ["袖口改蓝色"], acceptance: ["其余与原图一致"] } };
    for (const recovered of [false, true]) {
        const resultId = recovered ? "recovered-result" : "direct-result";
        const next = applyCanvasAgentOps(before, canvasImageAgentResultOps([{ type: "add_node", id: resultId, nodeType: CanvasNodeType.Image, metadata: { storageKey: `image:${resultId}` } }], before, record));
        expect(next.nodes.find(node => node.id === resultId)?.metadata?.imageAgent?.spec).toEqual(record.spec);
        const catalog = canvasImageAgentCatalog([], next.nodes, [{ id: resultId, title: "该版结果", type: CanvasNodeType.Image, storageKey: `image:${resultId}` }]);
        const result = catalog.find(item => item.nodeId === resultId)!;
        expect(catalog.map(item => item.nodeId)).toEqual(["base", resultId]);
        expect(result.spec).toEqual(record.spec);
        expect(canvasImageAgentDesignBrief(result.spec)).toContain("袖口改蓝色");
        expect(canvasImageAgentDesignBrief(result.spec)).not.toContain("金色背景");
        expect(catalog.find(item => item.nodeId === "base")?.spec).toBeUndefined();
    }
    expect(canvasImageAgentDesignBrief({ changes: Array.from({ length: 12 }, () => "长".repeat(400)) })).toHaveLength(1600);
    expect(canvasImageAgentDesignBrief({ changes: "corrupt" } as never)).toBe("");
});

test("Canvas has a single repair budget across planning turns and never repairs after a write attempt", async () => {
    const budget = { used: false }, issues: unknown[] = [];
    const resolved = await requestImageAgentPlanWithRepair({ budget, request: async issue => { issues.push(issue); return call(issue ? { prompt: "修正格式后改面料" } : { prompt: "改面料", edit_spec: { changes: [] } }); },
        validate: result => validateCanvasImageAgentPlan(result, images, selection), canRepair: () => true });
    expect(resolved.toolCalls).toHaveLength(1);
    expect(issues).toHaveLength(2);
    expect(issues[1]).toMatchObject({ code: "IMAGE_AGENT_SPEC_INVALID", submitted: false, repairable: true });
    expect(budget.used).toBe(true);
    let secondCalls = 0;
    await expect(requestImageAgentPlanWithRepair({ budget, request: async () => { secondCalls++; return call({ prompt: "改面料", keep: "invalid" }); },
        validate: result => validateCanvasImageAgentPlan(result, images, selection) })).rejects.toBeInstanceOf(ImageAgentPlanningError);
    expect(secondCalls).toBe(1);
    let writeCalls = 0;
    await expect(requestImageAgentPlanWithRepair({ budget: { used: false }, request: async () => { writeCalls++; return call({ prompt: "改面料", keep: "invalid" }); },
        validate: result => validateCanvasImageAgentPlan(result, images, selection), canRepair: () => false })).rejects.toBeInstanceOf(ImageAgentPlanningError);
    expect(writeCalls).toBe(1);
});

test("unavailable original and transport errors cannot trigger a new Canvas planner request", async () => {
    for (const failure of [new Error("HTTP 500"), new DOMException("stopped", "AbortError"), new Error("IMAGE_AGENT_PRIVACY_LEAK")]) {
        let calls = 0;
        await expect(requestImageAgentPlanWithRepair({ budget: { used: false }, request: async () => { calls++; throw failure; }, validate: value => value })).rejects.toBe(failure);
        expect(calls).toBe(1);
    }
    let calls = 0;
    await expect(requestImageAgentPlanWithRepair({ budget: { used: false }, request: async () => { calls++; return call({ prompt: "改面料" }); },
        validate: result => validateCanvasImageAgentPlan(result, [{ ...images[0]!, unavailableReason: "原件不存在" }], selection) })).rejects.toThrow("暂时不可读取");
    expect(calls).toBe(1);
});

test("Canvas task recovery always restores region protection before storing, and fails closed if restoration is unavailable", async () => {
    const regionComposite = { mode: "selection-composite" as const, source: { imageId: "base", storageKey: "source", width: 100, height: 100 }, selection: { storageKey: "selection", width: 100, height: 100 } };
    const pending: PendingOnlineAgentTask = { ownerId: "owner", projectId: "project", requestId: "request:0", mode: "image", prompt: "选区修改", model: "model", regionComposite };
    const calls: string[] = [];
    const io = {
        getQueuedTaskByRequestId: async () => ({ id: "task", requestId: "request:0", status: "success", resultUrls: ["/raw-result"] }),
        restoreChatMaskResult: async (received: PendingOnlineAgentTask, raw: string) => { expect(received.regionComposite).toEqual(regionComposite); expect(raw).toBe("/raw-result"); calls.push("restore"); return "data:image/png;protected"; },
        uploadImage: async (value: string) => { expect(value).toBe("data:image/png;protected"); calls.push("store"); return { url: "blob:protected", storageKey: "image:protected", width: 100, height: 100 }; },
    } as unknown as NonNullable<Parameters<typeof recoverOnlineAgentTask>[3]>;
    const result = await recoverOnlineAgentTask(pending, { x: 0, y: 0 }, new AbortController().signal, io);
    expect(calls).toEqual(["restore", "store"]);
    expect(result.attachments[0]?.storageKey).toBe("image:protected");
    expect(result.attachments[0]?.serverAssetId).toBeUndefined();
    io.restoreChatMaskResult = async () => { calls.push("restore-failed"); throw new Error("选区源文件丢失"); };
    await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, new AbortController().signal, io)).rejects.toThrow("选区源文件丢失");
    expect(calls).toEqual(["restore", "store", "restore-failed"]);
});

test("Canvas review and correction retain the actual per-version parent, not the oldest original or current UI focus", () => {
    const original: CanvasAssistantMessage = { id: "upload", role: "user", text: "原图", references: [{ id: "original", title: "原图", type: CanvasNodeType.Image, storageKey: "image:original" }] };
    const originalId = canvasImageAgentCatalog([original])[0]!.id;
    const first: CanvasAssistantMessage = { id: "first", role: "assistant", text: "第一版", attachments: [{ id: "result-first", name: "第一版", mediaType: "image", url: "blob:first", storageKey: "image:first" }],
        detail: { kind: "agent_generation", status: "completed", prompt: "改为蓝色", imageAgent: { baseImageId: originalId, referenceIds: [originalId], note: { summary: "蓝色", keep: [] } } } };
    const firstId = canvasImageAgentCatalog([original, first]).find(image => image.attachmentId === "result-first")!.id;
    const second: CanvasAssistantMessage = { id: "second", role: "assistant", text: "第二版", attachments: [{ id: "result-second", name: "第二版", mediaType: "image", url: "blob:second", storageKey: "image:second" }],
        detail: { kind: "agent_generation", status: "completed", prompt: "只改袖口", imageAgent: { baseImageId: firstId, referenceIds: [firstId], note: { summary: "蓝色罗纹袖口", keep: [] }, spec: { changes: ["袖口改罗纹"] } } } };
    const before = JSON.stringify([original, first, second]);
    const target = canvasImageAgentReviewTarget([original, first, second], [], second.id, "result-second");
    expect(target.base?.id).toBe(firstId);
    expect(target.base?.id).not.toBe(originalId);
    const review = { summary: "建议核对", checks: [{ criterion: "袖口", result: "warning" as const, evidence: "疑似仍为平针" }, { criterion: "隐藏缝线", result: "unverifiable" as const, evidence: "背面不可见" }] };
    const draft = canvasImageAgentCorrectionDraft(target, review);
    expect(draft.baseId).toBe(firstId);
    expect(draft.references.map(image => image.id)).toEqual([firstId]);
    expect(draft.text).toContain("疑似仍为平针");
    expect(draft.text).not.toContain("背面不可见");
    expect(draft.text).toContain("不是已经确认的事实");
    expect(draft.text).toContain("只改袖口");
    expect(JSON.stringify([original, first, second])).toBe(before);
    expect(() => canvasImageAgentReviewTarget([original, second], [], second.id, "result-second")).toThrow("实际使用的底图已不可用");
    expect(() => canvasImageAgentCorrectionDraft(target, { summary: "无法判断", checks: [{ criterion: "隐藏缝线", result: "unverifiable", evidence: "不可见" }] })).toThrow("未指出明确偏差");
});

test("Canvas review fingerprint detects same-id source and requirement replacement while retaining stable stored-media identity", () => {
    const upload: CanvasAssistantMessage = { id: "upload", role: "user", text: "参考", references: [{ id: "base", title: "底图", type: CanvasNodeType.Image, storageKey: "image:base", dataUrl: "blob:base" }, { id: "fabric", title: "面料", type: CanvasNodeType.Image, storageKey: "image:fabric" }] };
    const [base, fabric] = canvasImageAgentCatalog([upload]);
    const regionSelection = { imageId: base!.id, mask: { id: "mask", name: "蒙版", type: "image/png", dataUrl: "blob:mask", storageKey: "image:mask" }, selection: { id: "selection", name: "选区", type: "image/png", dataUrl: "blob:selection", storageKey: "image:selection" } };
    const result: CanvasAssistantMessage = { id: "result", role: "assistant", text: "结果", attachments: [{ id: "result-image", name: "结果", mediaType: "image", url: "blob:result", storageKey: "image:result" }],
        detail: { kind: "agent_generation", status: "completed", prompt: "更换面料", imageAgent: { baseImageId: base!.id, referenceIds: [base!.id, fabric!.id], note: { summary: "更换面料", keep: [] }, regionSelection } } };
    const target = () => canvasImageAgentReviewTarget([upload, result], [], result.id, "result-image");
    const fingerprint = canvasImageAgentReviewFingerprint(target());
    const persisted = JSON.parse(JSON.stringify([upload, result], (_key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
    expect(canvasImageAgentReviewFingerprint(canvasImageAgentReviewTarget(persisted, [], result.id, "result-image"))).toBe(fingerprint);
    result.attachments![0]!.url = "blob:rehydrated-result";
    expect(canvasImageAgentReviewFingerprint(target())).toBe(fingerprint);
    result.attachments![0]!.storageKey = "image:replaced-result";
    expect(canvasImageAgentReviewFingerprint(target())).not.toBe(fingerprint);
    result.attachments![0]!.storageKey = "image:result";
    upload.references![0]!.storageKey = "image:replaced-base";
    expect(canvasImageAgentReviewFingerprint(target())).not.toBe(fingerprint);
    upload.references![0]!.storageKey = "image:base";
    upload.references![1]!.storageKey = "image:replaced-fabric";
    expect(canvasImageAgentReviewFingerprint(target())).not.toBe(fingerprint);
    upload.references![1]!.storageKey = "image:fabric";
    result.detail!.prompt = "改为另一套方案";
    expect(canvasImageAgentReviewFingerprint(target())).not.toBe(fingerprint);
    result.detail!.prompt = "更换面料";
    const draft = canvasImageAgentCorrectionDraft(target(), { summary: "需要核对", checks: [{ criterion: "面料", result: "warning", evidence: "纹理方向疑似不符" }] });
    expect(draft.references.map(item => item.id)).toEqual([base!.id, fabric!.id]);
    expect(draft.regionSelection).toEqual(regionSelection);
    expect(canvasImageAgentReviewFingerprint(target())).toBe(fingerprint);
});

test("Canvas review survives actual cloud media conversion while immutable source snapshots reject same-id replacements", async () => {
    const messages: CanvasAssistantMessage[] = [{ id: "upload", role: "user", text: "原图", references: [{ id: "original", title: "原图", type: CanvasNodeType.Image, storageKey: "image:original" }] }];
    const original = canvasImageAgentCatalog(messages)[0]!.id;
    messages.push({ id: "result", role: "assistant", text: "结果", attachments: [{ id: "result-image", name: "结果", mediaType: "image", url: "blob:result", storageKey: "image:result" }],
        detail: { kind: "agent_generation", status: "completed", prompt: "改为红色", imageAgent: { baseImageId: original, referenceIds: [original], note: { summary: "红色", keep: [] },
            regionSelection: { imageId: original, mask: { id: "mask", name: "mask", type: "image/png", dataUrl: "blob:mask", storageKey: "image:mask" }, selection: { id: "selection", name: "selection", type: "image/png", dataUrl: "blob:selection", storageKey: "image:selection" } } } } });
    const target = canvasImageAgentReviewTarget(messages, [], "result", "result-image");
    const saved = { report: { summary: "已核对", checks: [{ criterion: "颜色", result: "pass" as const, evidence: "红色" }] }, reviewedAt: "2026-11-08", fingerprint: canvasImageAgentReviewFingerprint(target), inputs: canvasImageAgentReviewInputs(target) };
    messages[1]!.attachments![0]!.imageReview = saved;
    expect(canvasImageAgentReviewMatches(target, saved)).toBe(true);
    const originalSnapshot = JSON.stringify(saved.inputs);
    const replacedBeforeSave = structuredClone(messages);
    replacedBeforeSave[1]!.attachments![0]!.storageKey = "image:replaced-before-cloud";
    const replacedCloud = await portableCanvasMedia(replacedBeforeSave, async input => `/api/assets/${input.storageKey!.slice(6)}/content`);
    expect(canvasImageAgentReviewMatches(canvasImageAgentReviewTarget(replacedCloud, [], "result", "result-image"), replacedCloud[1]!.attachments![0]!.imageReview!)).toBe(false);
    expect(replacedCloud[1]!.attachments![0]!.imageReview!.inputs!.sources.some(item => item.url === "/api/assets/replaced-before-cloud/content")).toBe(false);
    const cloud = await portableCanvasMedia(messages, async input => `/api/assets/${input.storageKey!.slice(6)}/content`);
    const restored = JSON.parse(JSON.stringify(cloud)) as CanvasAssistantMessage[];
    const restoredTarget = () => canvasImageAgentReviewTarget(restored, [], "result", "result-image");
    const restoredReview = restored[1]!.attachments![0]!.imageReview!;
    expect(canvasImageAgentReviewFingerprint(restoredTarget())).not.toBe(saved.fingerprint);
    expect(canvasImageAgentReviewMatches(restoredTarget(), restoredReview)).toBe(true);
    expect(JSON.stringify(saved.inputs)).toBe(originalSnapshot);
    const cloudSnapshot = JSON.stringify(restoredReview.inputs);
    restored[1]!.attachments![0]!.url = "/api/assets/replaced-result/content";
    expect(canvasImageAgentReviewMatches(restoredTarget(), restoredReview)).toBe(false);
    restored[1]!.attachments![0]!.url = "/api/assets/result/content";
    restored[0]!.references![0]!.dataUrl = "/api/assets/replaced-original/content";
    expect(canvasImageAgentReviewMatches(restoredTarget(), restoredReview)).toBe(false);
    restored[0]!.references![0]!.dataUrl = "/api/assets/original/content";
    const record = restored[1]!.detail!.imageAgent as CanvasImageAgentRecord;
    record.regionSelection!.selection.dataUrl = "/api/assets/replaced-selection/content";
    expect(canvasImageAgentReviewMatches(restoredTarget(), restoredReview)).toBe(false);
    record.regionSelection!.selection.dataUrl = "/api/assets/selection/content";
    restored[1]!.detail!.prompt = "改为蓝色";
    expect(canvasImageAgentReviewMatches(restoredTarget(), restoredReview)).toBe(false);
    expect(JSON.stringify(restoredReview.inputs)).toBe(cloudSnapshot);
});

test("Canvas discussion and optional-spec-free versions retain exact historical intent for previous and original branches", async () => {
    const messages: CanvasAssistantMessage[] = [
        { id: "discussion", role: "user", text: "先讨论两个改图方向，不要出图" },
        { id: "proposal", role: "assistant", text: "方案A：米色简洁款；方案B：蓝色运动款。" },
        { id: "choice", role: "user", text: "否决B，按A生成原版，保持圆领" },
    ];
    const addVersion = (id: string, prompt: string, baseImageId: string | undefined, summary: string, keep: string[]) => {
        messages.push({ id, role: "assistant", text: "图片已生成", attachments: [{ id: `${id}-image`, name: id, url: `blob:${id}`, storageKey: `image:${id}`, mediaType: "image" }],
            detail: { kind: "agent_generation", status: "completed", prompt, imageAgent: { baseImageId, referenceIds: baseImageId ? [baseImageId] : [], note: { summary, keep } } } });
        return `chat-image:${id}:result:${id}-image`;
    };
    const original = addVersion("original", "方案A：米色简洁圆领款", undefined, "原版米色圆领", ["圆领"]);
    messages.push({ id: "change-one", role: "user", text: "颜色改成蓝色，圆领不变" });
    const previous = addVersion("previous", "米色改蓝色，仍保持圆领", original, "蓝色圆领", ["圆领"]);
    messages.push({ id: "change-two", role: "user", text: "不要圆领了，改成黑色V领" });
    const current = addVersion("current", "改为黑色V领，不保留圆领", previous, "黑色V领", ["V领"]);
    const before = JSON.stringify(messages), catalog = canvasImageAgentCatalog(messages);
    expect(catalog.find(image => image.id === original)?.designBrief).toContain("方案A：米色简洁圆领款");
    expect(catalog.find(image => image.id === previous)?.designBrief).not.toContain("黑色V领");
    expect(catalog.every(image => !image.spec && image.designBrief?.includes("非结果事实"))).toBe(true);
    const context = await buildImageAgentContext({ images: catalog, history: canvasImageAgentHistory(messages, catalog), focusId: current,
        currentText: "这版方向不好，回上一版只缩短衣长", note: catalog.find(image => image.id === current)?.note, readImage: async () => "data:image/png;base64,AA==" });
    expect(context.messages.some(message => typeof message.content === "string" && message.content.includes("方案A：米色简洁款；方案B：蓝色运动款"))).toBe(true);
    expect(context.messages.at(-1)?.content).toBe("这版方向不好，回上一版只缩短衣长");
    expect(context.profileContext.workNote).toContain("黑色V领");
    const selection = { focusId: current, previewedIds: catalog.map(image => image.id) };
    const previousEdit = resolveCanvasImageAgentEdit({ base: "previous", prompt: "上一版只缩短衣长" }, catalog, selection);
    const originalEdit = resolveCanvasImageAgentEdit({ base: "original", prompt: "原版只缩短衣长" }, catalog, selection);
    expect(previousEdit.base?.id).toBe(previous);
    expect(previousEdit.record.note).toEqual({ summary: "蓝色圆领", keep: ["圆领"] });
    expect(previousEdit.prompt).not.toContain("黑色V领");
    expect(originalEdit.base?.id).toBe(original);
    expect(originalEdit.record.note).toEqual({ summary: "黑色V领", keep: ["V领"] });
    expect(originalEdit.prompt).not.toContain("圆领");
    const originalBranch = resolveCanvasImageAgentEdit({ base: original, prompt: "原始分支只缩短衣长" }, catalog, selection);
    expect(originalBranch.record.note.summary).toBe("原版米色圆领");
    const details = canvasImageAgentInspectionDetails([catalog.find(image => image.id === previous)!], context.previews.map(image => image.id));
    expect(details.version_details).toHaveLength(1);
    expect(details.version_details[0]).toMatchObject({ id: previous, parentId: original, prompt: "米色改蓝色，仍保持圆领", promptTruncated: false, workNote: "蓝色圆领\n需保持：圆领" });
    expect(JSON.stringify(details.version_details)).not.toContain("黑色V领");
    expect(details.metadata_scope).toContain("当前用户要求优先");
    expect(JSON.stringify(messages)).toBe(before);
});

test("Canvas historical intent is bounded without mutating stored prompts or silently dropping inspected versions", () => {
    const prompt = `开始要求${"保留当前方向。".repeat(800)}结尾要求`;
    const catalog = canvasImageAgentCatalog([], [{ id: "old-node", type: CanvasNodeType.Image, title: "旧版", position: { x: 0, y: 0 }, width: 100, height: 100,
        metadata: { storageKey: "image:old-node", prompt, draftPrompt: "未发送的新草稿", imageAgent: { workId: "work", version: 1, note: { summary: "旧版状态", keep: [] } } } }],
        [{ id: "old-node", type: CanvasNodeType.Image, title: "旧版", storageKey: "image:old-node" }]);
    expect(catalog[0]?.prompt).toBe(prompt);
    expect(catalog[0]?.designBrief).toHaveLength(1600);
    expect(catalog[0]?.designBrief).toEndWith("[历史要求已节选]");
    expect(catalog[0]?.designBrief).not.toContain("未发送的新草稿");
    const data = canvasImageAgentInspectionDetails(catalog);
    expect(data.version_details[0]?.prompt).toBe(prompt.slice(0, 4000));
    expect(data.version_details[0]?.promptTruncated).toBe(true);
    expect(data.version_details[0]?.designBriefTruncated).toBe(true);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(36_000);
    expect(catalog[0]?.prompt).toBe(prompt);
    const escaped = Array.from({ length: 5 }, (_, index) => ({ ...image(`escaped-${index}`, `图${index + 1}`), prompt: "\u0001".repeat(4000) }));
    expect(() => canvasImageAgentInspectionDetails(escaped)).toThrow("没有丢弃版本或提交图片任务");
    expect(escaped.map(item => item.prompt.length)).toEqual([4000, 4000, 4000, 4000, 4000]);
});
