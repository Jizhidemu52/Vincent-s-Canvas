type AssetPreviewSource =
    | { kind: "image"; coverUrl?: string; data: { dataUrl: string; storageKey?: string } }
    | { kind: "video"; coverUrl?: string; data: { url: string; storageKey?: string } };

type AssetPreviewResolvers = {
    resolveImage: (storageKey: string, fallback: string) => Promise<string>;
    resolveMedia: (storageKey: string, fallback: string) => Promise<string>;
};

function assetPreviewFallback(asset: AssetPreviewSource) {
    return asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : asset.data.url);
}

/** A persisted Blob URL is invalid after refresh and must be recovered from browser storage. */
export function needsCanvasAssetPreviewResolution(asset: AssetPreviewSource) {
    const fallback = assetPreviewFallback(asset);
    return Boolean(asset.data.storageKey && (!fallback || fallback.startsWith("blob:")));
}

/** Resolves persisted Blob URLs only for media currently entering the DOM. */
export async function resolveCanvasAssetPreview(asset: AssetPreviewSource, resolvers: AssetPreviewResolvers) {
    const fallback = assetPreviewFallback(asset);
    if (!needsCanvasAssetPreviewResolution(asset)) return fallback;
    return asset.kind === "image" ? resolvers.resolveImage(asset.data.storageKey!, fallback) : resolvers.resolveMedia(asset.data.storageKey!, fallback);
}
