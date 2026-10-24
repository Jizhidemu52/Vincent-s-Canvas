import type { ServerAsset } from "@/services/api/server-assets";

export type DesignLibraryShareSource = {
    ownerId: string; title: string; prompt?: string; thought?: string; tags?: string[]; model?: string;
    assetId?: string; dataUrl?: string; storageKey?: string; filename?: string;
};
export type DesignLibraryShareDraft = {
    ownerId: string; asset: ServerAsset; title: string; thought: string; prompt: string; tags: string[]; model: string;
};

export function readDesignLibraryShareDraft(state: unknown, ownerId: string): DesignLibraryShareDraft | undefined {
    const draft = state && typeof state === "object" && "designLibraryDraft" in state ? state.designLibraryDraft as DesignLibraryShareDraft : undefined;
    if (!draft || !ownerId || draft.ownerId !== ownerId || draft.asset?.ownerUserId !== ownerId || draft.asset.kind !== "image"
        || draft.asset.status !== "ready" || typeof draft.asset.id !== "string" || !draft.asset.id
        || typeof draft.title !== "string" || typeof draft.thought !== "string" || typeof draft.prompt !== "string" || typeof draft.model !== "string"
        || !Array.isArray(draft.tags) || !draft.tags.every(tag => typeof tag === "string")) return undefined;
    return draft;
}
