import type { Asset, AssetKind } from "@/stores/use-asset-store";

type AssetSearchEntry = { asset: Asset; text: string };

/** Normalize full text once when the library changes, not on each search keystroke. */
export function buildAssetSearchIndex(assets: Asset[]): AssetSearchEntry[] {
    return assets.map((asset) => ({
        asset,
        text: [
            asset.title, asset.source || "", asset.note || "",
            ...["prompt", "model", "module"].map((key) => typeof asset.metadata?.[key] === "string" ? asset.metadata[key] : ""),
            (asset.tags || []).join(" "),
            asset.kind === "text" ? asset.data.content : asset.data.mimeType,
        ].join(" ").toLowerCase(),
    }));
}

export function searchAssetIndex(index: AssetSearchEntry[], keyword: string, kind: AssetKind | "all") {
    const query = keyword.trim().toLowerCase();
    return index.filter((entry) => (kind === "all" || entry.asset.kind === kind) && (!query || entry.text.includes(query))).map((entry) => entry.asset);
}
