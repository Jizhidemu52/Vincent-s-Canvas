import { afterEach, expect, test } from "bun:test";
import { fetchServerAssetPlayback } from "../src/services/api/server-assets";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout; });
const assetId = "7075c394-1184-44cc-9077-068d78e8b36d";

test("playback waits for a 202 then returns a private MP4 blob and measured metadata", async () => {
    const calls: string[] = [];
    let pending = 0;
    globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => originalSetTimeout(callback, ms === 3000 ? 1 : ms, ...args)) as typeof setTimeout;
    globalThis.fetch = (async (url, init) => {
        calls.push(String(url));
        expect(init?.credentials).toBe("include");
        expect(init?.cache).toBe("no-store");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return calls.length === 1 ? new Response(null, { status: 202, headers: { "Retry-After": "3" } }) : new Response("synthetic-video", { status: 206, headers: { "Content-Type": "video/mp4", "X-Canvas-Media-Width": "1248", "X-Canvas-Media-Height": "1664", "X-Canvas-Media-Duration-Ms": "6048" } });
    }) as typeof fetch;
    const result = await fetchServerAssetPlayback(assetId, { onPending: () => pending++ });
    expect(await result.blob.text()).toBe("synthetic-video");
    expect(result).toMatchObject({ width: 1248, height: 1664, durationMs: 6048 });
    expect(calls).toEqual([`/api/assets/${assetId}/playback`, `/api/assets/${assetId}/playback`]);
    expect(pending).toBe(1);
});

test("pending playback times out and does not keep polling or request generation", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(null, { status: 202 }); }) as typeof fetch;
    await expect(fetchServerAssetPlayback(assetId, { timeoutMs: 20 })).rejects.toThrow("准备超时");
    await new Promise(resolve => originalSetTimeout(resolve, 25));
    expect(calls).toBe(1);
});

test("abort stops pending playback without treating it as generation failure", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(null, { status: 202 }); }) as typeof fetch;
    await expect(fetchServerAssetPlayback(assetId, { signal: controller.signal, onPending: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
});

test.each([404, 422, 503])("terminal playback HTTP %i is surfaced without automatic retries", async status => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: "PLAYBACK_ERROR", message: "原件保留，兼容预览不可用" }, { status }); }) as typeof fetch;
    await expect(fetchServerAssetPlayback(assetId)).rejects.toMatchObject({ status, message: "原件保留，兼容预览不可用" });
    expect(calls).toBe(1);
});

test("playback rejects non-MP4 bytes and leaves missing metadata unknown", async () => {
    globalThis.fetch = (async () => new Response("video", { headers: { "Content-Type": "video/mp4" } })) as typeof fetch;
    const result = await fetchServerAssetPlayback(assetId);
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
    globalThis.fetch = (async () => new Response("html", { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    await expect(fetchServerAssetPlayback(assetId)).rejects.toThrow("格式");
});

test("a caller cannot extend the playback deadline beyond 150 seconds", async () => {
    const scheduled: number[] = [];
    globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => { scheduled.push(ms!); return originalSetTimeout(callback, ms === 150_000 ? 1 : ms, ...args); }) as typeof setTimeout;
    globalThis.fetch = (async (_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))) as typeof fetch;
    await expect(fetchServerAssetPlayback(assetId, { timeoutMs: 300_000 })).rejects.toThrow("准备超时");
    expect(scheduled[0]).toBe(150_000);
});
