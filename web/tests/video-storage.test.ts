import { expect, test } from "bun:test";

import { storeGeneratedVideo } from "@/services/api/video";

test("persists server result bytes with actual media metadata and original asset identity", async () => {
    const stored = await storeGeneratedVideo({ url: "/api/assets/7075c394-1184-44cc-9077-068d78e8b36d/content" }, {
        fetch: (async (_url, init) => {
            expect(init?.credentials).toBe("include");
            return new Response(new Blob(["video"], { type: "video/mp4" }));
        }) as typeof fetch,
        saveBlob: async (blob) => ({ url: "blob:saved", storageKey: "video:stored", bytes: blob.size, mimeType: blob.type, width: 768, height: 768, durationMs: 4458 }),
    });
    expect(stored).toMatchObject({ storageKey: "video:stored", width: 768, height: 768, durationMs: 4458, serverAssetId: "7075c394-1184-44cc-9077-068d78e8b36d" });
});

test("does not save an error page or empty video response as a playable result", async () => {
    for (const response of [new Response("not found", { status: 404 }), new Response(""), new Response("error", { headers: { "content-type": "text/html" } })]) {
        let saves = 0;
        await expect(storeGeneratedVideo({ url: "/api/assets/missing/content" }, { fetch: (async () => response) as typeof fetch, saveBlob: async () => { saves++; throw new Error("must not save"); } })).rejects.toThrow();
        expect(saves).toBe(0);
    }
});

test("persists direct video blobs instead of leaving an unmanaged object URL", async () => {
    const blob = new Blob(["video"], { type: "video/mp4" });
    const calls: Array<{ size: number; prefix: string }> = [];

    const stored = await storeGeneratedVideo(
        { blob },
        {
            saveBlob: async (input, prefix) => {
                calls.push({ size: input.size, prefix });
                return { url: "blob:managed-video", storageKey: "video:test", bytes: input.size, mimeType: input.type };
            },
        },
    );

    expect(calls).toEqual([{ size: 5, prefix: "video" }]);
    expect(stored).toEqual({ url: "blob:managed-video", storageKey: "video:test", bytes: 5, mimeType: "video/mp4" });
});
