import { expect, test } from "bun:test";
import { compareAssetCreatedAt, filterLocalAssets, patchAssetProjection, uploadAssetBatch } from "@/pages/assets/asset-library-state";
import type { Asset } from "@/stores/use-asset-store";
import type { ServerAsset } from "@/services/api/server-assets";

test("asset local filters use exact tags, project and exclusive date boundary", () => {
    const assets = [1, 2, 3].map(n => ({ id: String(n), tags: n === 2 ? ['服装细节'] : ['服装'], metadata: { projectId: 'p' }, createdAt: `2026-10-0${n}T00:00:00Z` } as Asset));
    expect(filterLocalAssets(assets, { tag: '服装', projectId: 'p', createdFrom: '2026-10-01T00:00:00Z', createdBefore: '2026-10-03T00:00:00Z' }).map(asset => asset.id)).toEqual(['1']);
});

test("merged asset sorting preserves PostgreSQL microseconds beside browser millisecond timestamps", () => {
    expect(compareAssetCreatedAt('2026-10-01T00:00:00.000001Z', '2026-10-01T00:00:00.000Z')).toBeGreaterThan(0);
    expect(compareAssetCreatedAt('2026-10-01T00:00:00.000001Z', '2026-10-01T00:00:00.000002Z')).toBeLessThan(0);
});

test("download projection updates only its loaded asset and preserves cursor and unrelated page references", () => {
    const first = { assets: [{ id: 'a' } as ServerAsset], nextCursor: 'cursor-a', hasMore: true };
    const second = { assets: [{ id: 'b' } as ServerAsset], nextCursor: null, hasMore: false };
    const data = { pages: [first, second], pageParams: [undefined, 'cursor-a'] };
    const updated = patchAssetProjection(data, 'b', { resultStatus: 'downloaded', downloadCount: 1, firstDownloadedAt: 'today', eventCount: 1, usabilityScore: 1 })!;
    expect(updated.pages[0]).toBe(first); expect(updated.pageParams).toBe(data.pageParams);
    expect(updated.pages[1]!.assets[0]!.downloadCount).toBe(1); expect(second.assets[0]!.downloadCount).toBeUndefined();
});

test("batch upload stays within three concurrent files and isolates failures with stable retry references", async () => {
    const jobs = Array.from({ length: 7 }, (_, i) => ({ file: new File(['x'], `${i}.png`), clientReferenceId: `upload-${i}` }));
    let inFlight = 0, max = 0;
    const progress: number[] = [];
    const result = await uploadAssetBatch(jobs, async job => {
        inFlight++; max = Math.max(max, inFlight); await new Promise(resolve => setTimeout(resolve, 2)); inFlight--;
        if (job.clientReferenceId === 'upload-2') throw new Error('上传中断');
    }, value => progress.push(value));
    expect(max).toBe(3); expect(result.succeeded).toBe(6); expect(result.failed).toEqual([{ ...jobs[2]!, error: '上传中断' }]);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const retried = await uploadAssetBatch(result.failed, async job => { expect(job.clientReferenceId).toBe('upload-2'); }, () => {});
    expect(retried).toEqual({ succeeded: 1, failed: [] });
});
