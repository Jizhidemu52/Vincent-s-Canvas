import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { syncAssetToCompanyDatabase } from "@/services/api/company-assets";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    ownerId: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "ownerId" | "createdAt" | "updatedAt"> & { ownerId?: string }) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const ASSET_STORE_KEY = "wireless-canvas:asset_store";

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(
            (parsed.state.assets || []).map(async (storedAsset) => {
                const ownerId = assetOwnerId(storedAsset);
                const asset = { ...storedAsset, ownerId, metadata: { ...storedAsset.metadata, designerId: ownerId } } as Asset;
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey)
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
                const image = await uploadImage(asset.data.dataUrl);
                return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
            }),
        );
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const ownerId = asset.ownerId || currentAssetOwnerId();
                const created = { ...asset, id, ownerId, createdAt: now, updatedAt: now, metadata: { ...asset.metadata, designerId: ownerId } } as Asset;
                set((state) => ({ assets: [created, ...state.assets] }));
                const user = useUserStore.getState().user;
                if (user) {
                    void syncAssetToCompanyDatabase(created, user)
                        .then((result) => {
                            if (!result.synced) return;
                            set((state) => ({
                                assets: state.assets.map((item) =>
                                    item.id === id
                                        ? {
                                              ...item,
                                              metadata: { ...item.metadata, companyDatabaseStatus: "synced", companyDatabaseSyncedAt: new Date().toISOString() },
                                          }
                                        : item,
                                ),
                            }));
                        })
                        .catch((error) => {
                            set((state) => ({
                                assets: state.assets.map((item) =>
                                    item.id === id
                                        ? {
                                              ...item,
                                              metadata: { ...item.metadata, companyDatabaseStatus: "failed", companyDatabaseError: error instanceof Error ? error.message : "同步失败" },
                                          }
                                        : item,
                                ),
                            }));
                        });
                }
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id && canCurrentUserManageAsset(asset) ? ({ ...asset, ...patch, ownerId: asset.ownerId, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id || !canCurrentUserManageAsset(asset));
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);

export function assetOwnerId(asset: Pick<Asset, "ownerId" | "metadata">) {
    const metadataOwner = asset.metadata?.designerId;
    return asset.ownerId || (typeof metadataOwner === "string" && metadataOwner.trim() ? metadataOwner : currentAssetOwnerId());
}

export function canUserAccessAsset(asset: Asset, user: LocalUser | null) {
    if (!user) return false;
    return user.role === "admin" || assetOwnerId(asset) === user.id;
}

function canCurrentUserManageAsset(asset: Asset) {
    return canUserAccessAsset(asset, useUserStore.getState().user);
}

function currentAssetOwnerId() {
    return useUserStore.getState().user?.id || "unassigned";
}
