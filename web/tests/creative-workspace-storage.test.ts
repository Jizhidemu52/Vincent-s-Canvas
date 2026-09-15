import { describe, expect, test } from "bun:test";
import { createSceneForm } from "@/pages/creative/scene-form-model";
import { sceneParameters, serializeSceneDraft, serializeSceneLog, type SceneImage, type SceneLog } from "@/pages/creative/use-scene-workspace";

const config = { model: "image-model", imageModel: "image-model", size: "1024x1024", quality: "auto", count: "2" };
const primary: SceneImage = { id: "garment", name: "服装.png", type: "image/png", mimeType: "image/png", dataUrl: "blob:garment", url: "blob:garment", storageKey: "image:garment", width: 1200, height: 1800, bytes: 2400 };
const secondary: SceneImage = { ...primary, id: "palette", name: "色彩.jpg", type: "image/jpeg", mimeType: "image/jpeg", dataUrl: "blob:palette", storageKey: "image:palette" };

describe("creative workspace persistence", () => {
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
