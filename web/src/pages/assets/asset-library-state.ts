import { uiText } from "@/lib/i18n";
import type { Asset } from "@/stores/use-asset-store";
import type { AssetListQuery, AssetProjection, ServerAssetPage } from "@/services/api/server-assets";

export function compareAssetCreatedAt(a: string, b: string) {
    const milliseconds = Date.parse(a) - Date.parse(b);
    const microseconds = (value: string) => Number((/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1] || '').padEnd(6, '0').slice(3, 6));
    return milliseconds || microseconds(a) - microseconds(b);
}

export function filterLocalAssets(assets: Asset[], query: AssetListQuery) {
    return assets.filter(asset => (!query.tag || asset.tags?.includes(query.tag))
        && (!query.projectId || asset.metadata?.projectId === query.projectId)
        && (!query.createdFrom || Date.parse(asset.createdAt) >= Date.parse(query.createdFrom))
        && (!query.createdBefore || Date.parse(asset.createdAt) < Date.parse(query.createdBefore)));
}

export function patchAssetProjection<T extends { pages: ServerAssetPage[] }>(data: T | undefined, id: string, projection: AssetProjection): T | undefined {
    if (!data) return data;
    return { ...data, pages: data.pages.map(page => page.assets.some(asset => asset.id === id)
        ? { ...page, assets: page.assets.map(asset => asset.id === id ? { ...asset, ...projection } : asset) } : page) };
}

export type AssetUploadJob = { file: File; clientReferenceId: string; error?: string };
export async function uploadAssetBatch(jobs: AssetUploadJob[], upload: (job: AssetUploadJob) => Promise<unknown>, onProgress: (completed: number, total: number) => void) {
    const failed: AssetUploadJob[] = [];
    let next = 0, completed = 0, succeeded = 0;
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
        while (next < jobs.length) {
            const job = jobs[next++]!;
            try { await upload(job); succeeded++; }
            catch (error) { failed.push({ ...job, error: error instanceof Error ? error.message : uiText("上传失败") }); }
            onProgress(++completed, jobs.length);
        }
    }));
    return { succeeded, failed };
}
