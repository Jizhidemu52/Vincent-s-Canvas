import { expect, test } from "bun:test";

import { needsCanvasAssetPreviewResolution, resolveCanvasAssetPreview } from "@/lib/canvas/canvas-asset-preview";

test("resolves a stored image preview only when its tile asks for it", async () => {
    const calls: string[] = [];
    const preview = await resolveCanvasAssetPreview(
        { kind: "image", coverUrl: "blob:stale", data: { dataUrl: "blob:stale", storageKey: "image:one" } },
        {
            resolveImage: async (key, fallback) => {
                calls.push(`${key}:${fallback}`);
                return "blob:fresh-image";
            },
            resolveMedia: async () => "",
        },
    );

    expect(preview).toBe("blob:fresh-image");
    expect(calls).toEqual(["image:one:blob:stale"]);
});

test("keeps a remote preview URL without opening local storage", async () => {
    let imageCalls = 0;
    const preview = await resolveCanvasAssetPreview(
        { kind: "image", coverUrl: "https://cdn.example.com/image.png", data: { dataUrl: "https://cdn.example.com/image.png" } },
        {
            resolveImage: async () => {
                imageCalls += 1;
                return "";
            },
            resolveMedia: async () => "",
        },
    );

    expect(preview).toBe("https://cdn.example.com/image.png");
    expect(imageCalls).toBe(0);
});

test("keeps a durable server URL out of local storage resolution", async () => {
    const asset = {
        kind: "video" as const,
        coverUrl: "/api/assets/video-1/content",
        data: { url: "/api/assets/video-1/content", storageKey: "video-1" },
    };
    let mediaCalls = 0;

    expect(needsCanvasAssetPreviewResolution(asset)).toBe(false);
    await expect(resolveCanvasAssetPreview(asset, {
        resolveImage: async () => "",
        resolveMedia: async () => {
            mediaCalls += 1;
            return "blob:should-not-be-used";
        },
    })).resolves.toBe("/api/assets/video-1/content");
    expect(mediaCalls).toBe(0);
});
