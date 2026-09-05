/**
 * Shares a pending asynchronous lookup for the same key. It deliberately only
 * deduplicates work in flight; callers retain ownership of their longer-lived
 * cache and invalidation policy.
 */
export function createDedupedAsyncResolver<T>(resolve: (key: string) => Promise<T>) {
    const pending = new Map<string, Promise<T>>();

    return (key: string) => {
        const existing = pending.get(key);
        if (existing) return existing;

        const next = resolve(key).finally(() => pending.delete(key));
        pending.set(key, next);
        return next;
    };
}
