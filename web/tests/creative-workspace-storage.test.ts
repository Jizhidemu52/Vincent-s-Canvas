import { describe, expect, test } from "bun:test";
import { buildScenePrompt, cloneSceneForm, createSceneForm, setSceneColor } from "@/pages/creative/scene-form-model";
import type { StandardColorSelection } from "@/lib/standard-colors";
import { failedSceneResult, recoverSceneTaskResult, replaceSceneLogResult, sceneParameters, sceneResultTaskId, serializeSceneDraft, serializeSceneLog, type SceneImage, type SceneLog, type SceneResult } from "@/pages/creative/use-scene-workspace";
import { QueuedTaskFailedError, QueuedTaskPausedError, QueuedTaskSubmissionUncertainError, type QueuedTask } from "@/services/api/generation-tasks";

const config = { model: "image-model", imageModel: "image-model", size: "1024x1024", quality: "auto", count: "2" };
const primary: SceneImage = { id: "garment", name: "服装.png", type: "image/png", mimeType: "image/png", dataUrl: "blob:garment", url: "blob:garment", storageKey: "image:garment", width: 1200, height: 1800, bytes: 2400 };
const secondary: SceneImage = { ...primary, id: "palette", name: "色彩.jpg", type: "image/jpeg", mimeType: "image/jpeg", dataUrl: "blob:palette", storageKey: "image:palette" };

describe("creative workspace persistence", () => {
    test("all four reference roles remain independent through draft and history serialization", () => {
        const form = { ...createSceneForm("series-extension"), referenceCount: 4 };
        const third = { ...primary, id: "third", storageKey: "image:third" };
        const fourth = { ...primary, id: "fourth", storageKey: "image:fourth" };
        const draft = serializeSceneDraft({ form, images: { primary, secondary, tertiary: third, quaternary: fourth }, config });
        expect(Object.keys(draft.images)).toEqual(["primary", "secondary", "tertiary", "quaternary"]);
        expect(draft.images.tertiary).toMatchObject({ id: "third", storageKey: "image:third", dataUrl: "" });
        expect(draft.images.quaternary).toMatchObject({ id: "fourth", storageKey: "image:fourth", dataUrl: "" });
        expect(draft.form.referenceCount).toBe(4);
    });
    test("standard color identity survives draft and history serialization independently of live edits", () => {
        const selection: StandardColorSelection = { id: "color-a", name: "17-1234 TCX", hex: "#123456", library: "PANTONE TCX", source: "公开色库", sourceUrl: "https://example.invalid/color-a", datasetVersion: "snapshot-1" };
        const form = setSceneColor({ ...createSceneForm("garment-colorway"), colorMode: "specific" as const }, 0, selection.hex, selection);
        const draft = serializeSceneDraft({ form, images: { primary }, config });
        const log: SceneLog = { id: "log-color", ownerId: "designer-1", sceneId: "garment-colorway", createdAt: 123, prompt: buildScenePrompt("garment-colorway", form), form: cloneSceneForm(form), referenceImages: { primary }, config, images: [], results: [], durationMs: 0, successCount: 0, failCount: 0 };
        const stored = serializeSceneLog(log);
        form.colors[0] = "#ABCDEF";
        form.colorSelections![0]!.name = "CHANGED";
        expect(draft.form.colors[0]).toBe(selection.hex);
        expect(draft.form.colorSelections?.[0]).toEqual(selection);
        expect(stored.form.colorSelections?.[0]).toEqual(selection);
        expect(stored.form.colorSelections?.[0]).not.toBe(log.form.colorSelections?.[0]);
        const restored = { ...createSceneForm("garment-colorway"), ...JSON.parse(JSON.stringify(draft)).form };
        expect(buildScenePrompt("garment-colorway", restored)).toBe(stored.prompt);
        expect(stored).toMatchObject({ ownerId: "designer-1", sceneId: "garment-colorway" });
        const secondOwner = serializeSceneLog({ ...log, ownerId: "designer-2", sceneId: "pattern-colorway", form: createSceneForm("pattern-colorway") });
        expect(secondOwner.ownerId).toBe("designer-2");
        expect(secondOwner.form.colorSelections).toBeUndefined();
        expect(stored.form.colorSelections?.[0]?.id).toBe(selection.id);
    });

    test("only the five image parameters persist; provider credentials never enter the record", () => {
        const source = { ...config, apiKey: "SECRET", channels: [{ apiKey: "CHANNEL_SECRET" }], baseUrl: "https://private.example", systemPrompt: "private system text" };
        expect(sceneParameters(source)).toEqual(config);
        const draft = serializeSceneDraft({ form: createSceneForm("garment-colorway"), images: {}, config: source });
        expect(JSON.stringify(draft)).not.toMatch(/SECRET|private|channels|apiKey/);
        expect(source.apiKey).toBe("SECRET");
    });

    test("dual-image roles survive persistence without retaining temporary object URLs", () => {
        const form = { ...createSceneForm("garment-colorway"), colorMode: "reference" as const };
        const stored = serializeSceneDraft({ form, images: { primary, secondary }, config });
        expect(stored.images.primary?.storageKey).toBe("image:garment");
        expect(stored.images.secondary?.storageKey).toBe("image:palette");
        expect(stored.images.primary?.dataUrl).toBe("");
        expect(stored.images.secondary?.dataUrl).toBe("");
        expect(JSON.stringify(stored)).not.toContain("blob:");
        expect(stored.form.colorMode).toBe("reference");
        expect(primary.dataUrl).toBe("blob:garment");
    });

    test("partial successes retain task identity, slot errors, form and owner isolation metadata", () => {
        const image = { ...primary, id: "generated", sourceTaskId: "server-task-1", imageVersion: 2 };
        const log: SceneLog = {
            id: "local-log", ownerId: "designer-1", sceneId: "garment-colorway", createdAt: 123,
            prompt: "图片1是服装，图片2仅提供配色。", form: createSceneForm("garment-colorway"),
            referenceImages: { primary, secondary }, config, images: [image], durationMs: 1200, successCount: 1, failCount: 1,
            results: [{ id: "slot-1", status: "success", image }, { id: "slot-2", status: "failed", error: "模型任务失败" }],
        };
        const stored = serializeSceneLog(log);
        expect(stored).toMatchObject({ ownerId: "designer-1", sceneId: "garment-colorway", successCount: 1, failCount: 1 });
        expect(stored.results[0]?.image).toMatchObject({ sourceTaskId: "server-task-1", storageKey: "image:garment", dataUrl: "", imageVersion: 2 });
        expect(stored.results[1]).toMatchObject({ id: "slot-2", status: "failed", error: "模型任务失败" });
        expect(stored.referenceImages.secondary?.id).toBe("palette");
        expect(JSON.stringify(stored)).not.toContain("blob:");
        expect(log.results[0]?.image?.dataUrl).toBe("blob:garment");
    });

    test("durable server result URLs remain available when local image storage fails", () => {
        const remote = { ...primary, storageKey: undefined, dataUrl: "/api/assets/generated/content", url: undefined };
        const stored = serializeSceneDraft({ form: createSceneForm("style-to-sketch"), images: { primary: remote }, config });
        expect(stored.images.primary?.dataUrl).toBe("/api/assets/generated/content");
        expect(stored.images.primary?.mimeType).toBe("image/png");
    });
});

describe("creative original-task recovery", () => {
    const taskId = "a7f6b1ce-0169-49e0-b8c8-776023f064b9";
    const original: SceneResult = { id: "slot-1", taskId, requestId: "request-root", status: "failed", error: "结果下载暂停" };
    const task = (overrides: Partial<QueuedTask> = {}): QueuedTask => ({ id: taskId, requestId: "request-root:0", status: "success", ownerUserId: "designer-1", resultUrls: ["/api/assets/original-result/content"], failureReason: null, ...overrides });
    const log = (overrides: Partial<SceneLog> = {}): SceneLog => ({
        id: "original-log", ownerId: "designer-1", sceneId: "text-to-style", createdAt: 123,
        prompt: "原始毛衫设计要求", form: createSceneForm("text-to-style"), referenceImages: {}, config,
        results: [original], images: [], durationMs: 300, successCount: 0, failCount: 1, inputArchiveVersion: 1, operation: "ai", ...overrides,
    });
    const stored = { url: "blob:stored-result", storageKey: "image:result", width: 1200, height: 1800, bytes: 4000, mimeType: "image/png" };
    const context = { ownerId: "designer-1", sceneId: "text-to-style", isCurrent: () => true };

    test("accepted task IDs and request IDs survive serialization and subsequent failures", () => {
        const errors = [new Error("文件下载失败"), new QueuedTaskPausedError(task({ status: "paused", upstreamTaskId: "upstream-original" })), new QueuedTaskSubmissionUncertainError("request-root", taskId)];
        for (const error of errors) {
            const result = failedSceneResult(original, error);
            const saved = serializeSceneLog(log({ results: [result] }));
            expect(saved.results[0]).toMatchObject({ id: original.id, taskId, requestId: "request-root", status: "failed", recoveryAllowed: true });
        }
        expect(failedSceneResult(original, new QueuedTaskFailedError(task({ status: "failed" })))).toMatchObject({ taskId, recoveryAllowed: false });
    });

    test("legacy errors accept only an explicit task UUID, never an arbitrary UUID in prose", () => {
        expect(sceneResultTaskId({ id: "legacy", status: "failed", error: `查询已暂停（任务 ${taskId}）。可恢复查询。` })).toBe(taskId);
        expect(sceneResultTaskId({ id: "legacy", status: "failed", error: `图片 ${taskId} 读取失败` })).toBeUndefined();
    });

    test("successful original task reads its result without a recovery POST or a generation request", async () => {
        const operations: string[] = [];
        const result = await recoverSceneTaskResult(log(), original, { ...context,
            queryTask: async id => { operations.push(`get:${id}`); return task(); },
            recoverTask: async id => { operations.push(`recover:${id}`); return []; },
            storeImage: async source => { operations.push(`store:${source}`); return stored; },
        });
        expect(operations).toEqual([`get:${taskId}`, "store:/api/assets/original-result/content"]);
        expect(result).toMatchObject({ id: original.id, taskId, requestId: "request-root", status: "success", image: { sourceTaskId: taskId, storageKey: stored.storageKey } });
    });

    test("paused tasks recover only the existing ID and retain the same history record", async () => {
        const operations: string[] = [];
        const initial = log({ results: [original, { id: "slot-2", status: "pending", taskId: "second-task" }] });
        const result = await recoverSceneTaskResult(initial, original, { ...context,
            queryTask: async id => { operations.push(`get:${id}`); return task({ status: "paused" }); },
            recoverTask: async id => { operations.push(`recover:${id}`); return ["/api/assets/recovered/content"]; },
            storeImage: async () => stored,
        });
        const updated = replaceSceneLogResult(initial, result);
        expect(operations).toEqual([`get:${taskId}`, `recover:${taskId}`]);
        expect(updated).toMatchObject({ id: initial.id, ownerId: initial.ownerId, sceneId: initial.sceneId, createdAt: initial.createdAt, prompt: initial.prompt, durationMs: initial.durationMs, successCount: 1, failCount: 0 });
        expect(updated.form).toBe(initial.form);
        expect(updated.config).toBe(initial.config);
        expect(updated.results[1]).toBe(initial.results[1]);
        expect(initial.results[0]?.status).toBe("failed");
    });

    test("lost submission responses resolve the persisted request ID and save the task identity before reading results", async () => {
        const unresolved = { ...original, taskId: undefined };
        const operations: string[] = [];
        const result = await recoverSceneTaskResult(log({ results: [unresolved] }), unresolved, { ...context,
            queryTask: async () => { throw new Error("must query original request"); },
            queryRequest: async id => { operations.push(`request:${id}`); return task(); },
            onTaskResolved: async id => { operations.push(`persist:${id}`); },
            recoverTask: async () => { throw new Error("successful original task does not need polling recovery"); },
            storeImage: async () => { operations.push("store"); return stored; },
        });
        expect(operations).toEqual(["request:request-root:0", `persist:${taskId}`, "store"]);
        expect(result.taskId).toBe(taskId);
    });

    test("missing or mismatched request lookup never starts a replacement task", async () => {
        const unresolved = { ...original, taskId: undefined };
        for (const response of [null, task({ requestId: "another-request:0" })]) {
            let writes = 0;
            await expect(recoverSceneTaskResult(log({ results: [unresolved] }), unresolved, { ...context,
                queryRequest: async () => response,
                recoverTask: async () => { writes += 1; return []; },
                storeImage: async () => { writes += 1; return stored; },
            })).rejects.toThrow("尚未找到原任务");
            expect(writes).toBe(0);
        }
    });

    test("owner, scene and record membership are checked before any server call", async () => {
        let queries = 0;
        const queryTask = async () => { queries += 1; return task(); };
        await expect(recoverSceneTaskResult(log(), original, { ...context, ownerId: "designer-2", queryTask })).rejects.toThrow("账号或所选任务已变化");
        await expect(recoverSceneTaskResult(log(), original, { ...context, sceneId: "garment-colorway", queryTask })).rejects.toThrow("账号或所选任务已变化");
        await expect(recoverSceneTaskResult(log(), { ...original, id: "unknown-slot" }, { ...context, queryTask })).rejects.toThrow("没有可恢复");
        expect(queries).toBe(0);
    });

    test("server owner and terminal status prevent recovery or result storage", async () => {
        let writes = 0;
        for (const response of [task({ ownerUserId: "designer-2" }), task({ status: "failed", failureReason: "已失败" }), task({ status: "cancelled" })]) {
            await expect(recoverSceneTaskResult(log(), original, { ...context,
                queryTask: async () => response,
                recoverTask: async () => { writes += 1; return []; },
                storeImage: async () => { writes += 1; return stored; },
            })).rejects.toThrow();
        }
        expect(writes).toBe(0);
    });

    test("changing the active view while the query is pending blocks the late result", async () => {
        let current = true, stores = 0;
        await expect(recoverSceneTaskResult(log(), original, { ...context, isCurrent: () => current,
            queryTask: async () => { current = false; return task(); },
            storeImage: async () => { stores += 1; return stored; },
        })).rejects.toThrow("账号或所选任务已变化");
        expect(stores).toBe(0);
    });

    test("selection recovery uses only the original frozen inputs and mask", async () => {
        const frozen = { ...primary, inputSha256: "original-hash", storageKey: "image:history:original", originalFileName: "original-knitwear.png" };
        const mask = { ...primary, id: "original-mask", inputSha256: "mask-hash", storageKey: "image:history:mask" };
        const initial = log({ sceneId: "local-restyle", form: createSceneForm("local-restyle"), referenceImages: { primary: frozen }, selection: { sourceId: frozen.id, mask } });
        const restores: string[] = [], composites: string[][] = [];
        let stores = 0;
        const result = await recoverSceneTaskResult(initial, original, { ...context, sceneId: initial.sceneId,
            queryTask: async () => task(),
            restoreInput: async image => { restores.push(image.storageKey!); return { ...image, dataUrl: `blob:verified-${image.id}` }; },
            storeImage: async () => ({ ...stored, url: ++stores === 1 ? "blob:raw-ai" : "blob:composited" }),
            composite: async (...args) => { composites.push(args); return new Blob(["merged"], { type: "image/png" }); },
        });
        expect(restores).toEqual(["image:history:original", "image:history:mask"]);
        expect(composites).toEqual([["blob:verified-garment", "blob:raw-ai", "blob:verified-original-mask"]]);
        expect(result).toMatchObject({ status: "success", image: { dataUrl: "blob:composited", sourceTaskId: taskId, imageName: "original-knitwear", imageVersion: 2 } });
    });

    test("failed frozen-input restoration retains raw output and never reports a composited success", async () => {
        const initial = log({ sceneId: "local-restyle", referenceImages: { primary }, selection: { sourceId: primary.id, mask: { ...primary, id: "mask" } } });
        const result = await recoverSceneTaskResult(initial, original, { ...context, sceneId: initial.sceneId,
            queryTask: async () => task(), storeImage: async () => stored,
            restoreInput: async () => { throw new Error("原始字节已改变"); },
            composite: async () => { throw new Error("must not composite unavailable inputs"); },
        });
        expect(result).toMatchObject({ status: "failed", taskId, recoveryAllowed: true, uncompositedImage: { sourceTaskId: taskId } });
        expect(result.image).toBeUndefined();
        expect(result.error).toContain("原始字节已改变");
    });
});
