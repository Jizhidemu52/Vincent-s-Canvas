import { imageThumbnailEdges, type ImageThumbnailEdge } from "./canvas/canvas-image-thumbnail";

export type ImageThumbnailRequest = { storageKey: string; edge: ImageThumbnailEdge; width: number; height: number };
export type ImageThumbnailLease = { url: string; release: () => void };
type Dependencies = {
    isCurrent: () => boolean;
    read: (key: string) => Promise<Blob | null>;
    write: (key: string, blob: Blob) => Promise<unknown>;
    remove: (key: string) => Promise<unknown>;
    generate: (request: ImageThumbnailRequest) => Promise<Blob | null>;
    schedule: (run: () => void) => void;
    createUrl: (blob: Blob) => string;
    revokeUrl: (url: string) => void;
};
const cacheKey = (storageKey: string, edge: number) => `thumbnail:v1:${storageKey}:${edge}`;

/** One decoder, bounded pending work, ref-counted URLs. No canvas metadata is modified. */
export function createImageThumbnailCache(deps: Dependencies, maxPending = 64) {
    const revisions = new Map<string, number>();
    const pending = new Map<string, { promise: Promise<Blob | null>; signals: Array<AbortSignal | undefined>; write?: Promise<unknown> }>();
    const urls = new Map<string, { url: string; references: number }>();
    const queue: Array<() => Promise<void>> = [];
    let running = false;
    const drain = () => {
        if (running || !queue.length) return;
        running = true;
        deps.schedule(() => {
            const task = queue.shift()!;
            void task().finally(() => { running = false; drain(); });
        });
    };
    const clearUrls = () => {
        for (const item of urls.values()) deps.revokeUrl(item.url);
        urls.clear();
    };
    return {
        async acquire(request: ImageThumbnailRequest, signal?: AbortSignal): Promise<ImageThumbnailLease | null> {
            if (!deps.isCurrent()) { clearUrls(); return null; }
            if (signal?.aborted) return null;
            const key = cacheKey(request.storageKey, request.edge);
            const revision = revisions.get(request.storageKey) || 0;
            const current = () => deps.isCurrent() && (revisions.get(request.storageKey) || 0) === revision;
            let entry = urls.get(key);
            if (!entry) {
                let job = pending.get(key);
                if (!job) {
                    if (queue.length >= maxPending) return null;
                    const signals = [signal];
                    const interested = () => signals.some((item) => !item?.aborted);
                    const work = new Promise<Blob | null>((resolve) => {
                        queue.push(async () => {
                            try {
                                if (!current() || !interested()) return resolve(null);
                                // Cache failure must never make an original image unavailable.
                                const cached = await deps.read(key).catch(() => null);
                                if (!current() || !interested()) return resolve(null);
                                const blob = cached || await deps.generate(request);
                                if (!current()) return resolve(null);
                                if (blob && !cached) {
                                    job!.write = deps.write(key, blob).catch(() => undefined);
                                    await job!.write;
                                }
                                resolve(current() ? blob : null);
                            } catch { resolve(null); }
                        });
                    });
                    job = { promise: work, signals };
                    pending.set(key, job);
                    void work.finally(() => { if (pending.get(key)?.promise === work) pending.delete(key); });
                    drain();
                } else job.signals.push(signal);
                const blob = await job.promise;
                if (!current()) { if (!deps.isCurrent()) clearUrls(); return null; }
                if (!blob || signal?.aborted) return null;
                entry = urls.get(key);
                if (!entry) { entry = { url: deps.createUrl(blob), references: 0 }; urls.set(key, entry); }
            }
            entry.references += 1;
            const leased = entry;
            let released = false;
            return { url: entry.url, release: () => {
                if (released) return;
                released = true;
                leased.references -= 1;
                if (leased.references === 0 && urls.get(key) === leased) {
                    deps.revokeUrl(leased.url);
                    urls.delete(key);
                }
            } };
        },
        async invalidate(storageKey: string) {
            revisions.set(storageKey, (revisions.get(storageKey) || 0) + 1);
            const keys = imageThumbnailEdges.map((edge) => cacheKey(storageKey, edge));
            // Only an already-started cache write needs draining. Never hold an
            // original replacement/deletion behind queued background decoders.
            await Promise.all(keys.map((key) => pending.get(key)?.write));
            await Promise.all(keys.map(async (key) => {
                const entry = urls.get(key);
                if (entry) { deps.revokeUrl(entry.url); urls.delete(key); }
                await deps.remove(key).catch(() => undefined);
            }));
        },
        releaseAll: clearUrls,
    };
}
