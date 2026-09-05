import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { createCoalescedAsyncTask } from "@/lib/coalesced-async-task";
import { localForageStorage } from "@/lib/localforage-storage";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { uploadServerAsset } from "@/services/api/server-assets";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;
export type AssetInput = Omit<Asset, "id" | "ownerId" | "createdAt" | "updatedAt"> & { ownerId?: string };
type AssetServerReference = {
    kind: AssetKind;
    metadata?: Record<string, unknown>;
    data: TextAsset["data"] | ImageAsset["data"] | VideoAsset["data"];
};

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
    addAsset: (asset: AssetInput) => string;
    addAssets: (assets: AssetInput[]) => string[];
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    syncAssetToCompanyDatabase: (id: string) => Promise<string>;
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
                if (asset.kind === "video" && asset.data.storageKey) return asset;
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey) return asset;
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
        (set, get) => {
            const cleanupTask = createCoalescedAsyncTask(
                async (extras: unknown[]) => {
                    const shared = { assets: get().assets, projects: useCanvasStore.getState().projects, extra: extras };
                    await cleanupUnusedImages(shared);
                    await cleanupUnusedMedia(shared);
                },
                (callback) => window.setTimeout(callback, 0),
            );

            return {
                hydrated: false,
                assets: [],
                addAssets: (assets) => {
                    if (!assets.length) return [];
                    const createdEntries = assets.map(createStoredAsset);
                    set((state) => ({ assets: [...createdEntries.map((entry) => entry.asset), ...state.assets] }));
                    const user = useUserStore.getState().user;
                    if (user) {
                        for (const entry of createdEntries) {
                            if (!entry.needsServerSync) continue;
                            void get()
                                .syncAssetToCompanyDatabase(entry.asset.id)
                                .catch(() => undefined);
                        }
                    }
                    return createdEntries.map((entry) => entry.asset.id);
                },
                addAsset: (asset) => get().addAssets([asset])[0]!,
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
                syncAssetToCompanyDatabase: async (id) => {
                    const asset = get().assets.find((item) => item.id === id);
                    if (!asset) throw new Error("素材不存在，无法上传到公司数据库");
                    if (!canCurrentUserManageAsset(asset)) throw new Error("无权上传该素材到公司数据库");
                    const existingId = serverAssetIdFromAsset(asset);
                    if (existingId) {
                        setCompanyDatabaseState(set, id, { serverAssetId: existingId, companyDatabaseStatus: "synced", companyDatabaseSyncedAt: new Date().toISOString(), companyDatabaseError: undefined });
                        return existingId;
                    }
                    setCompanyDatabaseState(set, id, { companyDatabaseStatus: "syncing", companyDatabaseError: undefined });
                    try {
                        const serverAssetId = await syncAssetToServerStorage(asset);
                        setCompanyDatabaseState(set, id, { serverAssetId, companyDatabaseStatus: "synced", companyDatabaseSyncedAt: new Date().toISOString(), companyDatabaseError: undefined });
                        return serverAssetId;
                    } catch (error) {
                        setCompanyDatabaseState(set, id, { companyDatabaseStatus: "failed", companyDatabaseError: error instanceof Error ? error.message : "同步失败" });
                        throw error;
                    }
                },
                replaceAssets: (assets) => set({ assets }),
                cleanupImages: (extra) => cleanupTask.schedule(extra),
            };
        },
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
    if (typeof asset.metadata?.serverAssetId === "string" && asset.metadata.serverAssetId) return true;
    if (user.role === "super_admin") return true;
    if (user.role === "department_admin") return Boolean(user.departmentId) && asset.metadata?.departmentId === user.departmentId;
    return assetOwnerId(asset) === user.id;
}

function canCurrentUserManageAsset(asset: Asset) {
    return canUserAccessAsset(asset, useUserStore.getState().user);
}

function currentAssetOwnerId() {
    return useUserStore.getState().user?.id || "unassigned";
}

function createStoredAsset(asset: AssetInput) {
    const now = new Date().toISOString();
    const id = nanoid();
    const ownerId = asset.ownerId || currentAssetOwnerId();
    const metadata = { ...asset.metadata, designerId: ownerId };
    const existingServerAssetId = serverAssetIdFromAsset({ ...asset, metadata });
    return {
        asset: {
            ...asset,
            id,
            ownerId,
            createdAt: now,
            updatedAt: now,
            metadata: existingServerAssetId ? { ...metadata, serverAssetId: existingServerAssetId, companyDatabaseStatus: "synced", companyDatabaseSyncedAt: now, companyDatabaseError: undefined } : metadata,
        } as Asset,
        needsServerSync: !existingServerAssetId,
    };
}

async function syncAssetToServerStorage(asset: Asset) {
    const existingId = serverAssetIdFromAsset(asset);
    if (existingId) return existingId;
    const metadata = { ...asset.metadata, localAssetId: asset.id, title: asset.title, tags: asset.tags, source: asset.source || "local-cache", note: asset.note || "" };
    if (asset.kind === "text") {
        return uploadServerAsset(new File([asset.data.content], `${safeFilename(asset.title)}.txt`, { type: "text/plain;charset=utf-8" }), metadata, { clientReferenceId: asset.id });
    }
    const sourceUrl = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
    const response = await fetch(sourceUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`素材读取失败（${response.status}）`);
    const blob = await response.blob();
    const extension = asset.kind === "video" ? "mp4" : blob.type.includes("jpeg") ? "jpg" : "png";
    return uploadServerAsset(new File([blob], `${safeFilename(asset.title)}.${extension}`, { type: blob.type || asset.data.mimeType }), metadata, { clientReferenceId: asset.id });
}

function setCompanyDatabaseState(set: (partial: Partial<AssetStore> | ((state: AssetStore) => Partial<AssetStore>), replace?: false) => void, id: string, patch: Record<string, unknown>) {
    set((state) => ({
        assets: state.assets.map((item) => (item.id === id ? { ...item, metadata: { ...item.metadata, ...patch } } : item)),
    }));
}

export function serverAssetIdFromAsset(asset: AssetServerReference) {
    const explicit = typeof asset.metadata?.serverAssetId === "string" ? asset.metadata.serverAssetId : "";
    if (explicit) return explicit;
    const sourceUrl = "dataUrl" in asset.data ? asset.data.dataUrl : "url" in asset.data ? asset.data.url : "";
    return sourceUrl.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1] || "";
}

function safeFilename(value: string) {
    return (
        value
            .trim()
            .replace(/[^A-Za-z0-9\u4e00-\u9fff._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "asset"
    );
}
