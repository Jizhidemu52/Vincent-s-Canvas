import { expect, test } from "bun:test";

import { needsCanvasNodeMediaPreviewResolution, resolveCanvasNodeMediaPreview } from "@/lib/canvas/canvas-node-media-preview";

test("defers a persisted image node preview until the node is mounted", async () => {
    const calls: string[] = [];
    const source = { type: "image" as const, content: "blob:stale-image", storageKey: "image:node-1" };

    expect(needsCanvasNodeMediaPreviewResolution(source)).toBe(true);
    await expect(
        resolveCanvasNodeMediaPreview(source, {
            resolveImage: async (key, fallback) => {
                calls.push(`${key}:${fallback}`);
                return "blob:live-image";
            },
            resolveMedia: async () => "",
        }),
    ).resolves.toBe("blob:live-image");
    expect(calls).toEqual(["image:node-1:blob:stale-image"]);
});

test("leaves durable remote node media alone", async () => {
    const source = { type: "video" as const, content: "/api/assets/video-1/content", storageKey: "video:node-1" };
    let mediaCalls = 0;

    expect(needsCanvasNodeMediaPreviewResolution(source)).toBe(false);
    await expect(
        resolveCanvasNodeMediaPreview(source, {
            resolveImage: async () => "",
            resolveMedia: async () => {
                mediaCalls += 1;
                return "blob:should-not-load";
            },
        }),
    ).resolves.toBe("/api/assets/video-1/content");
    expect(mediaCalls).toBe(0);
});

test("does not resolve non-media node content", async () => {
    const source = { type: "text" as const, content: "brief", storageKey: "image:unused" };

    expect(needsCanvasNodeMediaPreviewResolution(source)).toBe(false);
    await expect(
        resolveCanvasNodeMediaPreview(source, {
            resolveImage: async () => "blob:should-not-load",
            resolveMedia: async () => "blob:should-not-load",
        }),
    ).resolves.toBe("brief");
});
