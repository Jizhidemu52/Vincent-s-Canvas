/**
 * Shares a pending asynchronous lookup for the same key. It deliberately only
 * deduplicates work in flight; callers retain ownership of their longer-lived
 * cache and invalidation policy.
 */
export function createDedupedAsyncResolver<T, Args extends unknown[] = []>(resolve: (key: string, ...args: Args) => Promise<T>) {
    const pending = new Map<string, Promise<T>>();

    return (key: string, ...args: Args) => {
        const existing = pending.get(key);
        if (existing) return existing;

        const next = resolve(key, ...args).finally(() => pending.delete(key));
        pending.set(key, next);
        return next;
    };
}
