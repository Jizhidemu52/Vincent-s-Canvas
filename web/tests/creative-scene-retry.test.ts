import { expect, test } from "bun:test";
import { canRetrySceneResult, prepareSceneRetry, sceneFailure } from "../src/pages/creative/scene-retry";
import { QueuedTaskFailedError, QueuedTaskPausedError, QueuedTaskSubmissionUncertainError, type QueuedTask } from "../src/services/api/generation-tasks";
import { createSceneForm } from "../src/pages/creative/scene-form-model";
import { sceneReferenceUrl } from "../src/pages/creative/scene-result-actions";
import type { SceneLog, SceneResult } from "../src/pages/creative/use-scene-workspace";

const task: QueuedTask = { id: "failed-task", status: "failed", requestId: "original:0", resultUrls: [], failureReason: "模型明确失败" };
test("only an explicitly failed server task permits a new single-item request", () => {
    const failed = { id: "one", ...sceneFailure(new QueuedTaskFailedError(task), true) };
    expect(canRetrySceneResult(failed)).toBe(true);
    for (const error of [new QueuedTaskPausedError({ ...task, status: "paused", upstreamTaskId: "paid-upstream" }), new QueuedTaskSubmissionUncertainError("request", "task"), new Error("connection lost")]) {
        const failure = { id: "one", ...sceneFailure(error, true, task.id) };
        expect(failure.failureKind).toBe("uncertain"); expect(canRetrySceneResult(failure)).toBe(false);
    }
    expect(canRetrySceneResult({ id: "one", ...sceneFailure(new QueuedTaskFailedError({ ...task, status: "cancelled" }), true) })).toBe(false);
    expect(canRetrySceneResult({ ...failed, retryLogId: "already-submitted-retry" })).toBe(false);
    expect(canRetrySceneResult({ id: "old", status: "failed", error: "旧记录" })).toBe(false);
});

function fixture() {
    const config = { model: "uuid-model", imageModel: "uuid-model", size: "3:2", quality: "high", count: "3", systemPrompt: "原系统词" };
    const image = { id: "original", name: "原图.png", type: "image/png", mimeType: "image/png", dataUrl: "", width: 10, height: 20, bytes: 10, inputSha256: "a".repeat(64) };
    const result: SceneResult = { id: "failed-one", taskId: task.id, status: "failed", failureKind: "terminal" };
    const log: SceneLog = { id: "original-log", ownerId: "owner", sceneId: "local-restyle", createdAt: 1, prompt: "原提示词", inputArchiveVersion: 1, operation: "ai",
        form: createSceneForm("local-restyle"), config, referenceImages: { primary: image }, selection: { sourceId: image.id, mask: { ...image, id: "mask" } }, results: [result], images: [], durationMs: 1, successCount: 0, failCount: 1 };
    const archive = { version: 1, ownerId: "owner", modelConfigId: config.imageModel, modelId: "gpt-image-2", effectivePrompt: "完整系统词+参考图分工+原提示词", parameters: { quality: "high", size: "3:2", originalOption: "keep" } };
    const model = { id: config.imageModel, modelId: archive.modelId, name: "Original", capabilities: ["edit"], creditCost: 1, rmbCost: 0 };
    const calls: string[] = [];
    const deps: Parameters<typeof prepareSceneRetry>[4] = {
        async getQueuedTask() { calls.push("task"); return { ...task, userId: "owner", parameters: { inputArchive: archive } }; },
        async restoreGenerationDraft() { calls.push("archive"); return { prompt: log.prompt, config, references: [{ ...image, dataUrl: "data:original-verified" }, { ...image, id: "guide", dataUrl: "data:frozen-blue-guide" }], operationType: "inpaint", tool: "creative-local-restyle", parameters: archive.parameters, maskReferenceIndex: undefined }; },
        async restoreLocalInput(image) { calls.push(image.id); return { ...image, dataUrl: `verified:${image.id}` }; },
    };
    return { log, result, model, calls, deps, archive };
}
test("retry reuses frozen effective prompt, exact model/parameters/references and one output", async () => {
    const f = fixture(); const ready = await prepareSceneRetry(f.log, f.result, [f.model], "owner", f.deps);
    expect(ready.input).toMatchObject({ prompt: f.archive.effectivePrompt, modelId: "gpt-image-2", resolvedModel: f.model, count: 1, parameters: f.archive.parameters, tool: "creative-local-restyle" });
    expect(ready.input.references.map(item => item.dataUrl)).toEqual(["data:original-verified", "data:frozen-blue-guide"]);
    expect(ready.referenceImages.primary?.dataUrl).toBe("verified:original"); expect(ready.selection?.mask.dataUrl).toBe("verified:mask");
    expect(f.calls).toEqual(["task", "archive", "original", "mask"]); expect(f.log.config.count).toBe("3");
});
for (const status of ["processing", "paused", "success", "cancelled"]) test(`fresh ${status} status is never resubmitted`, async () => {
    const f = fixture(); f.deps!.getQueuedTask = async () => ({ ...task, status });
    await expect(prepareSceneRetry(f.log, f.result, [f.model], "owner", f.deps)).rejects.toThrow("不是明确失败"); expect(f.calls).toEqual([]);
});
test("changed model and missing historical mask stop before any new submission", async () => {
    const f = fixture(); await expect(prepareSceneRetry(f.log, f.result, [{ ...f.model, modelId: "different" }], "owner", f.deps)).rejects.toThrow("配置已变化");
    f.deps!.restoreLocalInput = async image => { if (image.id === "mask") throw new Error("历史字节不一致"); return image; };
    await expect(prepareSceneRetry(f.log, f.result, [f.model], "owner", f.deps)).rejects.toThrow("历史字节不一致");
});
test("continue-as-reference routes to existing edit flow without generation flags", () => {
    const url = new URL(sceneReferenceUrl("asset", "owner", "原始 + 提示词", "model"), "http://localhost");
    expect(url.pathname).toBe("/image"); expect(Object.fromEntries(url.searchParams)).toEqual({ tool: "image-edit", sourceAssetId: "asset", sourceOwnerId: "owner", prompt: "原始 + 提示词", model: "model" });
});
