/** Collect the complete filtered result, independently of the pages scrolled into view. */
export async function collectAssetPages<T extends { id: string }>(
    readPage: (cursor?: string) => Promise<{ assets: T[]; hasMore: boolean; nextCursor: string | null }>,
    checkOwner: () => void,
    onProgress: (count: number) => void = () => {},
): Promise<T[]> {
    const assets = new Map<string, T>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
        checkOwner();
        const page = await readPage(cursor);
        checkOwner();
        page.assets.forEach(asset => assets.set(asset.id, asset));
        onProgress(assets.size);
        if (!page.hasMore) return [...assets.values()];
        if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error("素材分页未能继续，导出已停止，请刷新后重试");
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
    } while (cursor);
    return [...assets.values()];
}
