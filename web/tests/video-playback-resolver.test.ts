import { expect, test } from "bun:test";
import { createVideoPlaybackResolver, resolveVideoPlaybackAssetId, validVideoPlaybackAssetId } from "../src/hooks/use-video-playback";
import type { ServerAssetPlayback } from "../src/services/api/server-assets";

const assetId = "7075c394-1184-44cc-9077-068d78e8b36d";
function harness(fetch: (id: string, signal: AbortSignal) => Promise<ServerAssetPlayback>) {
    let owner: string | null = "employee-a:designer";
    const listeners = new Set<() => void>(), created: Blob[] = [], revoked: string[] = [];
    const acquire = createVideoPlaybackResolver({ owner: () => owner, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, fetch,
        createUrl: blob => { created.push(blob); return `blob:preview-${created.length}`; }, revokeUrl: url => { revoked.push(url); } });
    return { acquire, created, revoked, listeners, changeOwner(next: string | null) { owner = next; for (const listener of [...listeners]) listener(); } };
}

test("playback accepts only explicit UUID identities, never a URL or malformed id", () => {
    expect(validVideoPlaybackAssetId(assetId)).toBe(assetId);
    for (const value of [undefined, "", "../other", `/api/assets/${assetId}/content`, `https://example.test/api/assets/${assetId}/content`, "------------------------------------"]) expect(validVideoPlaybackAssetId(value)).toBeNull();
});

test("historical canvas provenance uses only the stored upload mapping and never guesses a source URL", async () => {
    const keys: string[] = [];
    const read = async (key: string) => { keys.push(key); return `/api/assets/${assetId}/content`; };
    expect(await resolveVideoPlaybackAssetId({ assetId }, read)).toBe(assetId);
    expect(keys).toEqual([]);
    expect(await resolveVideoPlaybackAssetId({ storageKey: "video:original" }, read)).toBe(assetId);
    expect(keys).toEqual(["video:original"]);
    expect(await resolveVideoPlaybackAssetId({ originalUrl: `/api/assets/${assetId}/content` } as never, read)).toBeNull();
    expect(await resolveVideoPlaybackAssetId({ storageKey: "video:local-only" }, async () => null)).toBeNull();
});

test("simultaneous views share one pending request but release their display blob independently", async () => {
    let finish!: (value: ServerAssetPlayback) => void;
    let calls = 0;
    const h = harness(async id => { expect(id).toBe(assetId); calls++; return new Promise(resolve => { finish = resolve; }); });
    const first = h.acquire(assetId, new AbortController().signal);
    const second = h.acquire(assetId, new AbortController().signal);
    finish({ blob: new Blob(["compatibility"]), width: 1248, height: 1664, durationMs: 6048 });
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a.playbackUrl).toBe(b.playbackUrl);
    expect(a).toMatchObject({ width: 1248, height: 1664, durationMs: 6048 });
    a.release(); expect(h.revoked).toEqual([]);
    b.release(); b.release(); expect(h.revoked).toEqual([a.playbackUrl]);
    expect(h.listeners.size).toBe(0);
});

test("cancelling one view preserves another view; the last cancellation aborts the pending request", async () => {
    let signal!: AbortSignal;
    const h = harness(async (_id, next) => { signal = next; return new Promise(() => {}); });
    const a = new AbortController(), b = new AbortController();
    const first = h.acquire(assetId, a.signal), second = h.acquire(assetId, b.signal);
    const firstRejected = first.catch(error => error), secondRejected = second.catch(error => error);
    a.abort(); expect(await firstRejected).toMatchObject({ name: "AbortError" }); expect(signal.aborted).toBe(false);
    b.abort(); expect(await secondRejected).toMatchObject({ name: "AbortError" }); expect(signal.aborted).toBe(true);
    expect(h.created).toEqual([]); expect(h.listeners.size).toBe(0);
});

test("account or role changes cancel pending work and cannot publish the previous owner's bytes", async () => {
    let finish!: (value: ServerAssetPlayback) => void;
    const h = harness(async () => new Promise(resolve => { finish = resolve; }));
    const pending = h.acquire(assetId, new AbortController().signal);
    const rejected = pending.catch(error => error);
    h.changeOwner("employee-b:designer");
    finish({ blob: new Blob(["private-owner-a"]) });
    expect(await rejected).toMatchObject({ name: "AbortError" }); await Promise.resolve();
    expect(h.created).toEqual([]);
    expect(h.listeners.size).toBe(0);
});

test("a completed preview is revoked on an identity change", async () => {
    const h = harness(async () => ({ blob: new Blob(["private"]) }));
    const preview = await h.acquire(assetId, new AbortController().signal);
    h.changeOwner("employee-a:viewer");
    expect(h.revoked).toEqual([preview.playbackUrl]);
    preview.release(); expect(h.revoked).toHaveLength(1);
});

test("new demand after completion rechecks the server rather than reusing an old authorized blob", async () => {
    let calls = 0;
    const h = harness(async () => { if (++calls === 2) throw Object.assign(new Error("无权访问"), { status: 404 }); return { blob: new Blob(["previously-visible"]) }; });
    const first = await h.acquire(assetId, new AbortController().signal);
    await expect(h.acquire(assetId, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(2);
    expect(h.created).toHaveLength(1);
    first.release(); expect(h.revoked).toEqual([first.playbackUrl]);
});

test("missing identity, pre-abort, and fake URL sources do not request server playback", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return { blob: new Blob(["never"]) }; });
    await expect(h.acquire(`/api/assets/${assetId}/content`, new AbortController().signal)).rejects.toThrow("标识");
    const controller = new AbortController(); controller.abort();
    await expect(h.acquire(assetId, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    h.changeOwner(null);
    await expect(h.acquire(assetId, new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
});
