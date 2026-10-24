import { describe, expect, test } from "bun:test";
import { scenePromptInput, cloneSceneForm, createSceneForm, setSceneColor } from "@/pages/creative/scene-form-model";
import type { StandardColorSelection } from "@/lib/standard-colors";
import { sceneParameters, serializeSceneDraft, serializeSceneLog, type SceneImage, type SceneLog } from "@/pages/creative/use-scene-workspace";

const config = { model: "image-model", imageModel: "image-model", size: "1024x1024", quality: "auto", count: "2" };
const primary: SceneImage = { id: "garment", name: "服装.png", type: "image/png", mimeType: "image/png", dataUrl: "blob:garment", url: "blob:garment", storageKey: "image:garment", width: 1200, height: 1800, bytes: 2400 };
const secondary: SceneImage = { ...primary, id: "palette", name: "色彩.jpg", type: "image/jpeg", mimeType: "image/jpeg", dataUrl: "blob:palette", storageKey: "image:palette" };

describe("creative workspace persistence", () => {
    test("standard color identity survives draft and history serialization independently of live edits", () => {
        const selection: StandardColorSelection = { id: "color-a", name: "17-1234 TCX", hex: "#123456", library: "PANTONE TCX", source: "公开色库", sourceUrl: "https://example.invalid/color-a", datasetVersion: "snapshot-1" };
        const form = setSceneColor({ ...createSceneForm("garment-colorway"), colorMode: "specific" as const }, 0, selection.hex, selection);
        const draft = serializeSceneDraft({ form, images: { primary }, config });
        const log: SceneLog = { id: "log-color", ownerId: "designer-1", sceneId: "garment-colorway", createdAt: 123, prompt: "Server final compiled prompt", form: cloneSceneForm(form), referenceImages: { primary }, config, images: [], results: [], durationMs: 0, successCount: 0, failCount: 0 };
        const stored = serializeSceneLog(log);
        form.colors[0] = "#ABCDEF";
        form.colorSelections![0]!.name = "CHANGED";
        expect(draft.form.colors[0]).toBe(selection.hex);
        expect(draft.form.colorSelections?.[0]).toEqual(selection);
        expect(stored.form.colorSelections?.[0]).toEqual(selection);
        expect(stored.form.colorSelections?.[0]).not.toBe(log.form.colorSelections?.[0]);
        const restored = { ...createSceneForm("garment-colorway"), ...JSON.parse(JSON.stringify(draft)).form };
        expect(scenePromptInput("garment-colorway", restored)).toEqual(scenePromptInput("garment-colorway", stored.form));
        expect(stored.prompt).toBe("Server final compiled prompt");
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
