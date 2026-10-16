import { expect, test } from "bun:test";
import { createImageThumbnailCache, type ImageThumbnailRequest } from "@/lib/image-thumbnail-cache";

const request: ImageThumbnailRequest = { storageKey: "image:source", edge: 512, width: 4000, height: 3000 };
const blob = new Blob(["thumbnail"], { type: "image/webp" });
const key = "thumbnail:v1:image:source:512";

function harness(options: { limit?: number; generate?: (request: ImageThumbnailRequest) => Promise<Blob | null> } = {}) {
    const stored = new Map<string, Blob>();
    const scheduled: Array<() => void> = [];
    const revoked: string[] = [];
    const generated: string[] = [];
    let current = true;
    let urlCount = 0;
    const cache = createImageThumbnailCache({
        isCurrent: () => current,
        read: async (key) => stored.get(key) || null,
        write: async (key, value) => { stored.set(key, value); },
        remove: async (key) => { stored.delete(key); },
        generate: async (value) => { generated.push(value.storageKey); return options.generate ? options.generate(value) : blob; },
        schedule: (run) => scheduled.push(run),
        createUrl: () => `blob:thumbnail-${++urlCount}`,
        revokeUrl: (url) => { revoked.push(url); },
    }, options.limit);
    const flush = async (steps = 30) => {
        for (let i = 0; i < steps; i++) { scheduled.shift()?.(); await Promise.resolve(); }
    };
    return { cache, stored, generated, scheduled, revoked, flush, switchEmployee: () => { current = false; } };
}

test("thumbnail generation is deferred, deduplicated and its URL is ref-counted", async () => {
    const h = harness();
    const first = h.cache.acquire(request);
    const second = h.cache.acquire(request);
    expect(h.generated).toEqual([]);
    expect(h.scheduled.length).toBe(1);
    await h.flush();
    const a = await first;
    const b = await second;
    expect(h.generated).toEqual([request.storageKey]);
    expect(h.stored.get(key)).toBe(blob);
    expect(a?.url).toBe(b?.url);
    a?.release();
    expect(h.revoked).toEqual([]);
    b?.release();
    b?.release();
    expect(h.revoked).toEqual(["blob:thumbnail-1"]);
});

test("cached previews do not decode originals and released previews can be reacquired", async () => {
    const h = harness();
    h.stored.set(key, blob);
    const first = h.cache.acquire(request);
    await h.flush();
    (await first)?.release();
    const second = h.cache.acquire(request);
    await h.flush();
    expect((await second)?.url).toBe("blob:thumbnail-2");
    expect(h.generated).toEqual([]);
});

test("one decoder runs at a time and pending work has a hard bound", async () => {
    let finish!: (blob: Blob) => void;
    const h = harness({ limit: 2, generate: () => new Promise((resolve) => { finish = resolve; }) });
    const first = h.cache.acquire(request);
    await h.flush();
    const second = h.cache.acquire({ ...request, storageKey: "image:2" });
    const third = h.cache.acquire({ ...request, storageKey: "image:3" });
    expect(await h.cache.acquire({ ...request, storageKey: "image:4" })).toBeNull();
    expect(h.generated).toEqual(["image:source"]);
    finish(blob);
    await h.flush();
    expect(h.generated).toEqual(["image:source", "image:2"]);
    finish(blob);
    await h.flush();
    finish(blob);
    await h.flush();
    (await first)?.release(); (await second)?.release(); (await third)?.release();
});

test("unmounted queued previews are skipped while a surviving duplicate still works", async () => {
    const h = harness();
    const abort = new AbortController();
    const canceled = h.cache.acquire(request, abort.signal);
    abort.abort();
    await h.flush();
    expect(await canceled).toBeNull();
    expect(h.generated).toEqual([]);
    const abort2 = new AbortController();
    const canceled2 = h.cache.acquire(request, abort2.signal);
    const kept = h.cache.acquire(request);
    abort2.abort();
    await h.flush();
    expect(await canceled2).toBeNull();
    expect((await kept)?.url).toBe("blob:thumbnail-1");
});

test("sixty canceled queued previews free admission for sixty requests at the next zoom tier", async () => {
    const h = harness();
    const controllers = Array.from({ length: 60 }, () => new AbortController());
    let canceledSettled = 0;
    const canceled = controllers.map((controller, index) => h.cache.acquire({ ...request, storageKey: `image:${index}`, edge: 256 }, controller.signal).then((result) => { canceledSettled++; return result; }));
    controllers.forEach((controller) => controller.abort());
    const next = controllers.map((_, index) => h.cache.acquire({ ...request, storageKey: `image:${index}`, edge: 512 }));

    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(canceledSettled).toBe(60);
    expect(h.scheduled).toHaveLength(1);
    expect(h.generated).toEqual([]);
    await h.flush(2000);
    const leases = await Promise.all(next);
    expect(await Promise.all(canceled)).toEqual(Array(60).fill(null));
    expect(leases.filter(Boolean)).toHaveLength(60);
    expect(new Set(leases.map((lease) => lease?.url)).size).toBe(60);
    expect(h.generated).toHaveLength(60);
    expect([...h.stored.keys()].every((storedKey) => storedKey.endsWith(":512"))).toBe(true);
    leases.forEach((lease) => lease?.release());
    expect(h.revoked).toHaveLength(60);
    expect(h.scheduled).toHaveLength(0);
});

test("queue pruning retains a shared job while any consumer is still interested", async () => {
    const h = harness({ limit: 1 });
    const firstController = new AbortController();
    const canceled = h.cache.acquire(request, firstController.signal);
    const kept = h.cache.acquire(request);
    firstController.abort();

    expect(await h.cache.acquire({ ...request, storageKey: "image:over-budget" })).toBeNull();
    await h.flush();
    expect(await canceled).toBeNull();
    expect((await kept)?.url).toBe("blob:thumbnail-1");
    expect(h.generated).toEqual([request.storageKey]);
    (await kept)?.release();
    expect(h.revoked).toEqual(["blob:thumbnail-1"]);
});

test("reacquiring a canceled key creates a live shared job without stale cleanup removing it", async () => {
    const h = harness({ limit: 1 });
    const controller = new AbortController();
    let canceledSettled = false;
    const canceled = h.cache.acquire(request, controller.signal).then((result) => { canceledSettled = true; return result; });
    controller.abort();
    const first = h.cache.acquire(request);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(canceledSettled).toBe(true);
    const second = h.cache.acquire(request);

    await h.flush();
    expect(await canceled).toBeNull();
    const a = await first;
    const b = await second;
    expect(a?.url).toBe("blob:thumbnail-1");
    expect(b?.url).toBe(a?.url);
    expect(h.generated).toEqual([request.storageKey]);
    a?.release();
    expect(h.revoked).toEqual([]);
    b?.release();
    expect(h.revoked).toEqual(["blob:thumbnail-1"]);
});

test("a scheduled drain safely settles an entirely canceled queue", async () => {
    const h = harness();
    const controller = new AbortController();
    const canceled = h.cache.acquire(request, controller.signal);
    controller.abort();
    await h.flush();
    expect(await canceled).toBeNull();
    expect(h.generated).toEqual([]);
    expect(h.scheduled).toHaveLength(0);
    const fresh = h.cache.acquire(request);
    await h.flush();
    expect((await fresh)?.url).toBe("blob:thumbnail-1");
    (await fresh)?.release();
});

test("canceling queued work in one cache instance cannot cancel another instance's same key", async () => {
    const firstCache = harness();
    const secondCache = harness();
    const controller = new AbortController();
    const canceled = firstCache.cache.acquire(request, controller.signal);
    const other = secondCache.cache.acquire(request);
    controller.abort();
    const fresh = firstCache.cache.acquire({ ...request, edge: 256 });
    await firstCache.flush();
    await secondCache.flush();
    expect(await canceled).toBeNull();
    expect(await fresh).not.toBeNull();
    const otherLease = await other;
    expect(otherLease?.url).toBe("blob:thumbnail-1");
    expect(secondCache.generated).toEqual([request.storageKey]);
    (await fresh)?.release();
    expect(secondCache.revoked).toEqual([]);
    otherLease?.release();
    expect(secondCache.revoked).toEqual(["blob:thumbnail-1"]);
});

test("pruning queued zoom requests does not start another decoder while one is running", async () => {
    let finish!: (value: Blob) => void;
    const h = harness({ generate: (value) => value.storageKey === "image:running" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(blob) });
    const running = h.cache.acquire({ ...request, storageKey: "image:running" });
    await h.flush();
    const controllers = Array.from({ length: 60 }, () => new AbortController());
    const canceled = controllers.map((controller, index) => h.cache.acquire({ ...request, storageKey: `image:${index}`, edge: 256 }, controller.signal));
    controllers.forEach((controller) => controller.abort());
    const next = controllers.map((_, index) => h.cache.acquire({ ...request, storageKey: `image:${index}`, edge: 512 }));
    await h.flush();
    expect(h.generated).toEqual(["image:running"]);
    finish(blob);
    await h.flush(2000);
    const leases = await Promise.all(next);
    expect(leases.filter(Boolean)).toHaveLength(60);
    expect(await Promise.all(canceled)).toEqual(Array(60).fill(null));
    expect(h.generated).toHaveLength(61);
    (await running)?.release();
    leases.forEach((lease) => lease?.release());
});

test("an employee switch during generation does not store or expose the thumbnail", async () => {
    let finish!: (blob: Blob) => void;
    const h = harness({ generate: () => new Promise((resolve) => { finish = resolve; }) });
    const result = h.cache.acquire(request);
    await h.flush();
    h.switchEmployee();
    finish(blob);
    await h.flush();
    expect(await result).toBeNull();
    expect(h.stored.size).toBe(0);
    expect(await h.cache.acquire(request)).toBeNull();
});

test("replacing an original invalidates in-flight derivatives and persisted tiers", async () => {
    let finish!: (blob: Blob) => void;
    const h = harness({ generate: () => new Promise((resolve) => { finish = resolve; }) });
    h.stored.set("thumbnail:v1:image:source:256", blob);
    const result = h.cache.acquire(request);
    await h.flush();
    const invalidation = h.cache.invalidate(request.storageKey);
    await invalidation;
    expect(h.stored.size).toBe(0);
    finish(blob);
    await h.flush();
    await invalidation;
    expect(await result).toBeNull();
    expect(h.stored.size).toBe(0);
});

test("invalidating a queued preview does not wait for background scheduling", async () => {
    const h = harness();
    const result = h.cache.acquire(request);
    await h.cache.invalidate(request.storageKey);
    expect(h.generated).toEqual([]);
    await h.flush();
    expect(await result).toBeNull();
});

test("unsupported or failed decoders are disposable failures, not original-image failures", async () => {
    const h = harness({ generate: async () => { throw new Error("decoder unavailable"); } });
    const result = h.cache.acquire(request);
    await h.flush();
    expect(await result).toBeNull();
    expect(h.stored.size).toBe(0);
});

test("identity changes revoke already-issued thumbnail URLs", async () => {
    const h = harness();
    const result = h.cache.acquire(request);
    await h.flush();
    await result;
    h.switchEmployee();
    expect(await h.cache.acquire(request)).toBeNull();
    expect(h.revoked).toEqual(["blob:thumbnail-1"]);
});
