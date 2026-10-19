import { expect, test } from "bun:test";
import { assetCanvasNodes, assetCanvasViewport, selectAssetRange } from "@/pages/assets/asset-batch";
import { serverAssetToLocal } from "@/lib/server-asset-local";
import type { ServerAsset } from "@/services/api/server-assets";

test("Shift range keeps ordering and a rejected over-limit selection preserves the old selection", () => {
    const previous = new Set(["a"]);
    expect([...selectAssetRange(previous, ["a", "b", "c", "d"], "c", "a", true)]).toEqual(["a", "b", "c"]);
    expect([...selectAssetRange(new Set(["a", "b"]), ["a", "b"], "b", "a", false)]).toEqual(["a"]);
    const many = Array.from({ length: 51 }, (_, i) => String(i));
    expect(() => selectAssetRange(new Set(["0"]), many, "50", "0", true)).toThrow("50");
    expect([...previous]).toEqual(["a"]);
});
test("canvas insertion preserves originals while gallery previews use derivatives", () => {
    const asset = serverAssetToLocal({ id: "asset-a", ownerUserId: "u", filename: "图.png", kind: "image", mimeType: "image/png", byteSize: 100,
        metadata: { width: 1200, height: 800 }, createdAt: "2026-10-19", contentUrl: "/api/assets/asset-a/content", thumbnailUrl: "/api/assets/asset-a/thumb?w=256", previewUrl: "/api/assets/asset-a/thumb?w=1024" } as ServerAsset);
    expect(asset.coverUrl).toEndWith("thumb?w=256");
    const [node] = assetCanvasNodes([asset], 760);
    expect(node?.metadata?.content).toBe("/api/assets/asset-a/content");
    expect(node?.metadata?.naturalWidth).toBe(1200);
    expect(node!.width / node!.height).toBeCloseTo(1.5);
    expect(node?.position).toEqual({ x: 0, y: 760 });
});

test("new selection framing keeps all fifty nodes below toolbars and inside the available viewport", () => {
    const assets = Array.from({ length: 50 }, (_, index) => ({ id: String(index), title: `素材${index}`, kind: 'text' as const, data: { content: '完整正文' }, createdAt: '', updatedAt: '' }));
    const nodes = assetCanvasNodes(assets), viewport = assetCanvasViewport(nodes, { width: 1512, height: 1050 });
    for (const node of nodes) {
        expect(viewport.x + node.position.x * viewport.k).toBeGreaterThanOrEqual(360);
        expect(viewport.y + node.position.y * viewport.k).toBeGreaterThanOrEqual(120);
        expect(viewport.x + (node.position.x + node.width) * viewport.k).toBeLessThanOrEqual(1488);
        expect(viewport.y + (node.position.y + node.height) * viewport.k).toBeLessThanOrEqual(950);
    }
});
