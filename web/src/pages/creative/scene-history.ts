import type { SceneLog } from "./use-scene-workspace";

type Storage = { getItem<T>(key: string): Promise<T | null>; setItem<T>(key: string, value: T): Promise<unknown> };
export type SceneLogSummary = Pick<SceneLog, "id" | "ownerId" | "sceneId" | "createdAt" | "successCount" | "failCount" | "operation"> & { hasSelection: boolean; unresolvedCount?: number };
type Index = { version: 1; entries: SceneLogSummary[] };
const writes = new Map<string, Promise<unknown>>();
export const SCENE_HISTORY_PAGE_SIZE = 20;

export function summarizeSceneLog(log: SceneLog): SceneLogSummary {
    return { id: log.id, ownerId: log.ownerId, sceneId: log.sceneId, createdAt: log.createdAt, successCount: log.successCount, failCount: log.failCount, operation: log.operation, hasSelection: Boolean(log.selection), unresolvedCount: log.results.filter(result => result.status === "pending" || result.failureKind === "uncertain").length };
}

/** Old arrays are preserved. Only the first indexed read touches them, never each new save. */
export function createSceneHistory(storage: Storage, ownerId: string, sceneId: string) {
    const scope = `${encodeURIComponent(ownerId)}:${encodeURIComponent(sceneId)}`;
    const indexKey = `history-index:${scope}`;
    const recordKey = (id: string) => `history-record:${scope}:${encodeURIComponent(id)}`;
    const owns = (log: Pick<SceneLog, "ownerId" | "sceneId">) => log.ownerId === ownerId && log.sceneId === sceneId;
    function ordered<T>(run: () => Promise<T>): Promise<T> {
        const next = (writes.get(indexKey) || Promise.resolve()).catch(() => undefined).then(run);
        writes.set(indexKey, next);
        void next.finally(() => { if (writes.get(indexKey) === next) writes.delete(indexKey); }).catch(() => undefined);
        return next;
    }
    async function readIndex(): Promise<Index> {
        const index = await storage.getItem<Index>(indexKey);
        if (index?.version === 1) return { ...index, entries: index.entries.filter(owns) };
        const previous = await storage.getItem<SceneLog[]>(`history:${scope}`) || [];
        const entries: SceneLogSummary[] = [];
        const ids = new Set<string>();
        for (const log of previous) {
            if (!owns(log) || ids.has(log.id)) continue;
            await storage.setItem(recordKey(log.id), log);
            ids.add(log.id);
            entries.push(summarizeSceneLog(log));
        }
        entries.sort((a, b) => b.createdAt - a.createdAt);
        const created: Index = { version: 1, entries };
        await storage.setItem(indexKey, created);
        return created;
    }
    return {
        pending() { return ordered(async () => (await readIndex()).entries.filter(entry => entry.unresolvedCount)); },
        page(offset = 0, limit = SCENE_HISTORY_PAGE_SIZE) {
            return ordered(async () => {
                const index = await readIndex();
                const end = offset + limit;
                return { entries: index.entries.slice(offset, end), total: index.entries.length, hasMore: end < index.entries.length };
            });
        },
        async read(id: string) {
            await writes.get(indexKey);
            const log = await storage.getItem<SceneLog>(recordKey(id));
            if (!log || !owns(log)) throw new Error("这条记录不存在或不属于当前场景");
            return log;
        },
        save(log: SceneLog) {
            if (!owns(log)) return Promise.reject(new Error("不能保存其他账号或场景的记录"));
            return ordered(async () => {
                const index = await readIndex();
                await storage.setItem(recordKey(log.id), log);
                const entries = [summarizeSceneLog(log), ...index.entries.filter(item => item.id !== log.id)].sort((a, b) => b.createdAt - a.createdAt);
                await storage.setItem(indexKey, { version: 1, entries } satisfies Index);
            });
        },
    };
}
