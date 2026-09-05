import { describe, expect, test } from "bun:test";

import { serverAssetIdFromAsset, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

const serverAssetId = "4d8a1e21-3f1b-4e71-a0d7-8d1c0e4aa112";

function imageAsset(overrides: Partial<Asset> = {}): Asset {
    return {
        id: "asset-1",
        ownerId: "designer-1",
        kind: "image",
        title: "result",
        coverUrl: "/preview.png",
        tags: [],
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        data: { dataUrl: "/preview.png", width: 100, height: 100, bytes: 10, mimeType: "image/png" },
        ...overrides,
    } as Asset;
}

describe("asset server storage state", () => {
    test("recognizes a result that already has an explicit server asset id", () => {
        expect(serverAssetIdFromAsset(imageAsset({ metadata: { serverAssetId } }))).toBe(serverAssetId);
    });

    test("recognizes a server-backed image URL without scheduling another upload", () => {
        const asset = imageAsset({ data: { dataUrl: `/api/assets/${serverAssetId}/content`, width: 100, height: 100, bytes: 10, mimeType: "image/png" } });
        expect(serverAssetIdFromAsset(asset)).toBe(serverAssetId);
    });

    test("inserts a server-backed batch with one store update and marks every result synced", () => {
        const initialAssets = useAssetStore.getState().assets;
        const initialUser = useUserStore.getState().user;
        const first = imageAsset({ metadata: { serverAssetId } });
        const second = imageAsset({ data: { dataUrl: `/api/assets/${serverAssetId}/content`, width: 100, height: 100, bytes: 10, mimeType: "image/png" } });
        const toInput = ({ id: _id, ownerId: _ownerId, createdAt: _createdAt, updatedAt: _updatedAt, ...asset }: Asset) => asset;
        useUserStore.setState({ user: null });
        useAssetStore.setState({ assets: [] });
        let updates = 0;
        const unsubscribe = useAssetStore.subscribe(() => updates += 1);

        try {
            const ids = useAssetStore.getState().addAssets([toInput(first), toInput(second)]);
            const assets = useAssetStore.getState().assets;
            expect(ids).toHaveLength(2);
            expect(updates).toBe(1);
            expect(assets).toHaveLength(2);
            expect(assets.every((asset) => asset.metadata?.companyDatabaseStatus === "synced")).toBe(true);
        } finally {
            unsubscribe();
            useAssetStore.setState({ assets: initialAssets });
            useUserStore.setState({ user: initialUser });
        }
    });
});
