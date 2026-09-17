import { expect, test } from "bun:test";
import { isSupportedServerAsset, serverAssetToLocal } from "@/lib/server-asset-local";
import type { ServerAsset } from "@/services/api/server-assets";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";

const asset = (patch: Partial<ServerAsset> = {}): ServerAsset => ({ id: "server-1", ownerUserId: "employee-a", filename: "原图.png", kind: "image", mimeType: "image/png", byteSize: 1234, metadata: {}, createdAt: "2026-09-17", ...patch } as ServerAsset);

test("server image and video preserve dimensions without inventing a local storage key", async () => {
    for (const kind of ["image", "video"] as const) {
        const result = serverAssetToLocal(asset({ kind, metadata: { width: 1400, height: 2100, storageKey: "obsolete-local-key", tags: ["收藏"] } }));
        expect(result).toMatchObject({ ownerId: "employee-a", tags: ["收藏"], data: { width: 1400, height: 2100, bytes: 1234 } });
        expect(JSON.stringify(result)).not.toContain("storageKey");
        let uploads = 0;
        await portableCanvasMedia(result, async () => { uploads++; return "unexpected"; });
        expect(uploads).toBe(0);
    }
});
test("metadata dimensions accept finite numeric values and natural dimensions only", () => {
    expect(serverAssetToLocal(asset({ metadata: { width: "1400", height: -1, naturalWidth: 800, naturalHeight: 900 } })).data).toMatchObject({ width: 800, height: 900 });
    expect(serverAssetToLocal(asset({ metadata: { width: Infinity, height: NaN } })).data).toMatchObject({ width: 0, height: 0 });
});
test("text stays text and unsupported audio/other records cannot masquerade as images", () => {
    expect(serverAssetToLocal(asset({ kind: "text", metadata: { content: "保留文字" } })).data).toEqual({ content: "保留文字" });
    expect(isSupportedServerAsset(asset({ kind: "other", mimeType: "audio/wav" }))).toBe(false);
    expect(() => serverAssetToLocal(asset({ kind: "other" }))).toThrow();
});
