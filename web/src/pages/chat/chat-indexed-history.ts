type Store = { getItem<T>(key: string): Promise<T | null>; setItem<T>(key: string, value: T): Promise<T> };
type Session = { id: string };
type Index = { version: 2; sessions: Array<{ id: string; recordKey?: string }> };

/** Old snapshots remain untouched; only changed conversations get new, media-free records. */
export function createChatIndexedHistory<T extends Session>(store: Store, serialize: (session: T) => Promise<T>) {
    const writes = new Map<string, Promise<void>>();
    const loaded = new Map<string, { references: Map<string, T>; entries: Index["sessions"] }>();
    const indexKey = (key: string) => `${key}:index:v2`;
    return {
        async load(key: string, readLegacy: () => string | null): Promise<T[]> {
            await writes.get(key);
            const index = await store.getItem<Index>(indexKey(key));
            if (index && (index.version !== 2 || !Array.isArray(index.sessions))) throw new Error("聊天记录索引格式不正确，未覆盖原记录");
            let old: T[] = [];
            if (!index || index.sessions.some((entry) => !entry.recordKey)) {
                const stored = await store.getItem<T[]>(key);
                const legacy = stored === null ? readLegacy() : null;
                const value: unknown = stored ?? (legacy ? JSON.parse(legacy) : []);
                if (!Array.isArray(value)) throw new Error("已保存的聊天记录格式不正确");
                old = value;
            }
            const entries: Index["sessions"] = index?.sessions || old.map(({ id }) => ({ id }));
            if (entries.some((entry) => typeof entry.id !== "string" || !entry.id || (entry.recordKey && !entry.recordKey.startsWith(`${key}:session:`))) || new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("聊天记录索引无效，未覆盖原记录");
            const sessions = await Promise.all(entries.map(async (entry) => {
                const value = entry.recordKey ? await store.getItem<T>(entry.recordKey) : old.find((item) => item.id === entry.id);
                if (!value || value.id !== entry.id) throw new Error("聊天记录缺失，未覆盖原记录");
                return value;
            }));
            loaded.set(key, { references: new Map(sessions.map((session) => [session.id, session])), entries });
            return sessions;
        },
        save(key: string, sessions: T[]): Promise<void> {
            const next = (writes.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
                const previous = loaded.get(key);
                const entries: Index["sessions"] = [];
                for (const session of sessions) {
                    const entry = previous?.entries.find((item) => item.id === session.id);
                    if (entry && previous?.references.get(session.id) === session) { entries.push(entry); continue; }
                    const recordKey = `${key}:session:${encodeURIComponent(session.id)}`;
                    const saved = await serialize(session);
                    await store.setItem(recordKey, saved);
                    entries.push({ id: session.id, recordKey });
                }
                await store.setItem(indexKey(key), { version: 2, sessions: entries } satisfies Index);
                loaded.set(key, { references: new Map(sessions.map((session) => [session.id, session])), entries });
            });
            writes.set(key, next);
            void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => undefined);
            return next;
        },
    };
}
