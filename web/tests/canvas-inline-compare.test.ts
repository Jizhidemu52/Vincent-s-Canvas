import { describe, expect, test } from "bun:test";
import { canvasCompareSource } from "@/lib/canvas/canvas-image-compare-source";
import { clampInlineComparePercent, inlineComparePercentFromClientX, inlineCompareSources } from "@/lib/canvas/canvas-inline-compare";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";
import { collectCanvasExportMedia, restoreCanvasExportMedia } from "@/lib/canvas/canvas-export-media";
import { collectImageStorageKeys } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const imageNode = (metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id: "result", type: CanvasNodeType.Image, title: "改款结果", position: { x: 0, y: 0 }, width: 300, height: 200, metadata });

describe("inline image comparison provenance", () => {
    test("only an explicit single valid snapshot can activate comparison automatically", () => {
        expect(inlineCompareSources(imageNode({ compareSources: [{ type: "image", content: "blob:before", storageKey: "image:before", label: "原款" }] }))).toEqual({ sources: [{ type: "image", content: "blob:before", storageKey: "image:before", label: "原款" }], automatic: true });
        expect(inlineCompareSources(imageNode({ compareSources: [{ type: "image", content: "", storageKey: "image:before" }] })).automatic).toBe(true);
    });

    test("multiple snapshots require selection even when some images have missing source data", () => {
        const sources = [{ type: "image" as const, content: "blob:shape" }, { type: "image" as const, content: "blob:pattern" }];
        expect(inlineCompareSources(imageNode({ compareSources: sources }))).toEqual({ sources, automatic: false });
        expect(inlineCompareSources(imageNode({ compareSources: [sources[0], { type: "image", content: "" }] }))).toEqual({ sources: [sources[0]], automatic: false });
    });

    test("a source-less image never guesses from its filename or version", () => {
        expect(inlineCompareSources(imageNode({ imageName: "shirt", imageVersion: 2, originalFileName: "shirt.png", content: "blob:after" }))).toEqual({ sources: [], automatic: false });
        expect(inlineCompareSources(imageNode({ compareSources: [{ type: "image", content: "" }] }))).toEqual({ sources: [], automatic: false });
        expect(inlineCompareSources({ ...imageNode({ references: ["blob:before"] }), type: CanvasNodeType.Config })).toEqual({ sources: [], automatic: false });
    });

    test("legacy reference strings are candidates, never automatic proof of a unique original", () => {
        const result = inlineCompareSources(imageNode({ references: ["image:old-key", "/api/assets/old/content", "data:image/png;base64,AQID"] }));
        expect(result.automatic).toBe(false);
        expect(result.sources).toEqual([
            { type: "image", content: "", storageKey: "image:old-key" },
            { type: "image", content: "/api/assets/old/content" },
            { type: "image", content: "data:image/png;base64,AQID" },
        ]);
        expect(inlineCompareSources(imageNode({ references: ["image:only-survivor"] })).automatic).toBe(false);
    });

    test("an explicit empty snapshot list does not fall back to older unrelated references", () => {
        expect(inlineCompareSources(imageNode({ compareSources: [], references: ["image:old-generation"] }))).toEqual({ sources: [], automatic: false });
    });

    test("persistent image keys avoid copying duplicate base64 into the document", () => {
        expect(canvasCompareSource({ storageKey: "image:immutable", dataUrl: "data:image/png;base64,AQID", originalFileName: "shirt.png" })).toEqual({ type: "image", content: "", storageKey: "image:immutable", label: "shirt.png" });
        expect(canvasCompareSource({ storageKey: "image:immutable", content: "data:image/png;base64,AQID", url: "/api/assets/original/content" })).toEqual({ type: "image", content: "/api/assets/original/content", storageKey: "image:immutable" });
        expect(canvasCompareSource({ storageKey: "image:immutable", content: "blob:immutable" })).toEqual({ type: "image", content: "blob:immutable", storageKey: "image:immutable" });
    });

    test("a data URL remains intact when it is the only original-image byte source", () => {
        expect(canvasCompareSource({ dataUrl: "data:image/png;base64,AQID", title: "原始款" })).toEqual({ type: "image", content: "data:image/png;base64,AQID", label: "原始款" });
        expect(canvasCompareSource({})).toEqual({ type: "image", content: "" });
    });

    test("source mutation after generation cannot rewrite a saved comparison snapshot", () => {
        const input = { content: "blob:original", storageKey: "image:original", title: "原图" };
        const snapshot = canvasCompareSource(input);
        input.content = "blob:changed";
        input.storageKey = "image:changed";
        input.title = "重命名";
        expect(snapshot).toEqual({ type: "image", content: "blob:original", storageKey: "image:original", label: "原图" });
    });

    test("comparison snapshots protect original image keys and use existing cloud-media conversion", async () => {
        const source = imageNode({ content: "blob:after", storageKey: "image:after", compareSources: [canvasCompareSource({ storageKey: "image:before", dataUrl: "data:image/png;base64,AQID" })] });
        expect([...collectImageStorageKeys(source)].sort()).toEqual(["image:after", "image:before"]);
        const converted = await portableCanvasMedia(source, async input => `/api/assets/${input.storageKey === "image:before" ? "before" : "after"}/content`);
        expect(converted.metadata?.compareSources).toEqual([{ type: "image", content: "/api/assets/before/content" }]);
        expect(converted.metadata?.content).toBe("/api/assets/after/content");
        expect(source.metadata?.compareSources?.[0]?.storageKey).toBe("image:before");
        expect(JSON.stringify(converted)).not.toContain('"storageKey"');
    });

    test("cloud snapshot images survive export and import using their saved original bytes", async () => {
        const originalId = "b631dfe3-5dc6-44e6-8a13-000000000001";
        const originalKey = `image:archive-${originalId}`;
        const before = imageNode({ compareSources: [{ type: "image", content: `/api/assets/${originalId}/content` }] });
        const blob = new Blob([new Uint8Array([0, 1, 255])], { type: "image/png" });
        const exported = await collectCanvasExportMedia(before, { fetchBlob: async () => blob });
        expect(exported.blobs.get(originalKey)).toBe(blob);
        const imported = restoreCanvasExportMedia(exported.document, new Map([[originalKey, "blob:restored-original"]]));
        expect(imported.metadata?.compareSources).toEqual([{ type: "image", content: "blob:restored-original", storageKey: originalKey }]);
        expect([...collectImageStorageKeys(imported)]).toEqual([originalKey]);
    });
});

describe("inline image comparison pointer coordinates", () => {
    test.each([[-25, 0], [0, 0], [12.5, 12.5], [50, 50], [100, 100], [125, 100], [Number.NaN, 50]])("clamps %s to %s percent", (input, expected) => {
        expect(clampInlineComparePercent(input)).toBe(expected);
    });

    test("uses actual screen bounds so zoomed canvas nodes preserve the pointer ratio", () => {
        expect(inlineComparePercentFromClientX(175, { left: 100, width: 300 })).toBe(25);
        expect(inlineComparePercentFromClientX(137.5, { left: 100, width: 150 })).toBe(25);
        expect(inlineComparePercentFromClientX(250, { left: 100, width: 300 })).toBe(50);
        expect(inlineComparePercentFromClientX(20, { left: 100, width: 300 })).toBe(0);
        expect(inlineComparePercentFromClientX(500, { left: 100, width: 300 })).toBe(100);
    });

    test("unmeasurable bounds or non-finite pointer data return a safe midpoint", () => {
        expect(inlineComparePercentFromClientX(100, { left: 100, width: 0 })).toBe(50);
        expect(inlineComparePercentFromClientX(100, { left: 100, width: -20 })).toBe(50);
        expect(inlineComparePercentFromClientX(Number.NaN, { left: 100, width: 300 })).toBe(50);
    });
});
