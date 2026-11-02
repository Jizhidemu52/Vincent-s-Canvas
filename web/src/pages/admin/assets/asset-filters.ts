import type { AssetListQuery } from "@/services/api/server-assets";

export const assetFilterKeys = ["assetView", "assetQ", "assetOwner", "assetProject", "assetTag", "assetFrom", "assetTo", "assetSort", "assetKind"] as const;
export type AssetFilterKey = typeof assetFilterKeys[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function calendarDate(value: string | null) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

export function readAssetFilters(params: URLSearchParams) {
    const view = params.get("assetView") === "list" ? "list" : "wall";
    const owner = params.get("assetOwner"), project = params.get("assetProject");
    let from = calendarDate(params.get("assetFrom")), to = calendarDate(params.get("assetTo"));
    if (!from || !to || from > to) { from = undefined; to = undefined; }
    const kind = params.get("assetKind");
    const query: AssetListQuery = {
        kind: view === "wall" ? "image" : ["image", "video", "text", "other"].includes(kind || "") ? kind as AssetListQuery["kind"] : undefined,
        q: params.get("assetQ")?.trim().slice(0, 200) || undefined,
        ownerUserId: owner && uuid.test(owner) ? owner : undefined,
        projectId: project && uuid.test(project) ? project : undefined,
        tag: params.get("assetTag")?.trim().slice(0, 100) || undefined,
        sort: params.get("assetSort") === "oldest" ? "oldest" : "newest",
        createdFrom: from ? new Date(`${from}T00:00:00+08:00`).toISOString() : undefined,
        createdBefore: to ? new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86_400_000).toISOString() : undefined,
    };
    return { view, from, to, query };
}

/** Preserve the active admin tab and unrelated URL state. Never persist asset records here. */
export function patchAssetFilters(params: URLSearchParams, patch: Partial<Record<AssetFilterKey, string | undefined>>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value); else next.delete(key);
    }
    return next;
}

export function clearAssetFilters(params: URLSearchParams) {
    const next = new URLSearchParams(params);
    assetFilterKeys.forEach(key => next.delete(key));
    return next;
}
