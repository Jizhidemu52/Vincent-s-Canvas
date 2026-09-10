import localforage from "localforage";

type ChatSessionStore = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
};

/** Uses the existing app-state database, never localStorage or image-files GC. */
export function createChatSessionStorage(store: ChatSessionStore) {
    const writes = new Map<string, Promise<void>>();
    return {
        async load<T>(key: string, readLegacy: () => string | null): Promise<T[]> {
            await writes.get(key);
            const stored = await store.getItem<T[]>(key);
            if (stored !== null) {
                if (!Array.isArray(stored)) throw new Error("已保存的聊天记录格式不正确");
                return stored;
            }
            // Older snapshots contain text/metadata only. Preserve them as-is;
            // their discarded image bytes cannot be reconstructed.
            const legacy = readLegacy();
            const parsed: unknown = legacy ? JSON.parse(legacy) : [];
            if (!Array.isArray(parsed)) throw new Error("旧聊天记录格式不正确");
            return parsed as T[];
        },
        save<T>(key: string, sessions: T[]): Promise<void> {
            // Serialize each account's snapshots so a slow older write cannot
            // finish after and overwrite its newer conversation state.
            const next = (writes.get(key) || Promise.resolve())
                .catch(() => undefined)
                .then(async () => { await store.setItem(key, sessions); });
            writes.set(key, next);
            void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => undefined);
            return next;
        },
    };
}

export const chatSessionStorage = createChatSessionStorage(localforage.createInstance({
    name: "wireless-canvas",
    storeName: "app_state",
    driver: localforage.INDEXEDDB,
}));
