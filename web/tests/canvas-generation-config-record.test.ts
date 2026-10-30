import { describe, expect, test } from "bun:test";
import { buildGenerationConfig } from "@/pages/canvas/canvas-project-utils";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const global = { ...defaultConfig, model: "global-model", imageModel: "global-image", videoModel: "global-video", audioModel: "global-audio", size: "1:1", quality: "1k", imageOptions: "global-options", systemPrompt: "global-system" };
const node: CanvasNodeData = {
    id: "result", type: CanvasNodeType.Image, title: "result", position: { x: 0, y: 0 }, width: 100, height: 100,
    metadata: { generationRecord: {
        version: 1, id: "run", sourceNodeId: "source", createdAt: "2026-10-30T00:00:00Z", prompt: "compiled", inputPrompt: "input", references: [],
        parameters: { model: "recorded-model", size: "3:2", quality: "2k", imageOptions: "recorded-options", systemPrompt: "recorded-system", count: 1, generationType: "generation" },
    } },
};

describe("image generation config archive fallback", () => {
    test("uses recorded image parameters when a recovered node has no redundant metadata", () => {
        const before = structuredClone(node);
        expect(buildGenerationConfig(global, node, "image")).toMatchObject({ model: "recorded-model", size: "3:2", quality: "2k", imageOptions: "recorded-options", systemPrompt: "recorded-system", count: "1" });
        expect(node).toEqual(before);
    });

    test("draft parameters override the record, including intentionally empty options and system prompt", () => {
        const changed = { ...node, metadata: { ...node.metadata, model: "draft-model", size: "4:3", quality: "", imageOptions: "", systemPrompt: "" } };
        expect(buildGenerationConfig(global, changed, "image")).toMatchObject({ model: "draft-model", size: "4:3", quality: "", imageOptions: "", systemPrompt: "" });
    });

    test("does not apply image archive fallback to other media modes or nodes without records", () => {
        for (const mode of ["video", "audio"] as const) {
            expect(buildGenerationConfig(global, node, mode)).toMatchObject({ model: `global-${mode}`, size: "1:1", quality: "1k", imageOptions: "global-options", systemPrompt: "global-system" });
        }
        expect(buildGenerationConfig(global, { ...node, metadata: {} }, "image")).toMatchObject({ model: "global-image", size: "1:1", quality: "1k", imageOptions: "global-options", systemPrompt: "global-system" });
    });
});
