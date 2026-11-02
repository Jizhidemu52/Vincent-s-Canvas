import { expect, test } from "bun:test";
import { createServerImageThumbnailResolver } from "@/services/server-image-thumbnails";
import { fetchServerImageThumbnail, type ServerImageThumbnail } from "@/services/api/server-assets";

const url = "/api/assets/11111111-1111-4111-8111-111111111111/thumb?w=256";
function harness(fetch: (url: string, signal: AbortSignal) => Promise<ServerImageThumbnail>, timeoutMs = 1000, maxRequests = 12) {
    let owner: string | null = "employee-a";
    const listeners = new Set<() => void>(), created: Blob[] = [], revoked: string[] = [];
    const acquire = createServerImageThumbnailResolver({ owner: () => owner, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
        fetch, timeoutMs, maxRequests, createUrl: blob => { created.push(blob); return `blob:${owner}-${created.length}`; }, revokeUrl: value => { revoked.push(value); } });
    return { acquire, created, revoked, listeners, switchOwner(next: string | null) { owner = next; for (const listener of [...listeners]) listener(); } };
}

test("pending image preview resolves only the ready derivative and releases its owner-scoped URL once", async () => {
    let requests = 0;
    const derivative = new Blob(["small"], { type: "image/webp" });
    const h = harness(async request => { expect(request).toBe(url); return ++requests === 1 ? { status: "pending", retryAfterMs: 1 } : { status: "ready", blob: derivative }; });
    const lease = await h.acquire(url, new AbortController().signal);
    expect(requests).toBe(2); expect(h.created).toEqual([derivative]); expect(lease.url).toBe("blob:employee-a-1");
    lease.release(); lease.release(); expect(h.revoked).toEqual([lease.url]); expect(h.listeners.size).toBe(0);
});

test("failure is terminal with no original request or URL", async () => {
    let requests = 0;
    const h = harness(async () => { requests++; throw new Error("422"); });
    await expect(h.acquire(url, new AbortController().signal)).rejects.toThrow("422");
    expect(requests).toBe(1); expect(h.created).toEqual([]); expect(h.listeners.size).toBe(0);
});

test("pending retries have a finite request cap", async () => {
    let requests = 0;
    const h = harness(async () => { requests++; return { status: "pending", retryAfterMs: 1 }; }, 1000, 3);
    await expect(h.acquire(url, new AbortController().signal)).rejects.toThrow("超时");
    expect(requests).toBe(3); expect(h.listeners.size).toBe(0);
});

test("deadline cancels a hung fetch, including implementations that ignore AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    const h = harness((_url, nextSignal) => { signal = nextSignal; return new Promise(() => {}); }, 10);
    await expect(h.acquire(url, new AbortController().signal)).rejects.toThrow("超时");
    expect(signal!.aborted).toBe(true); expect(h.created).toEqual([]); expect(h.listeners.size).toBe(0);
});

test("unmount abort cancels pending backoff without making another request", async () => {
    let requests = 0;
    const h = harness(async () => { requests++; return { status: "pending", retryAfterMs: 500 }; });
    const controller = new AbortController(), pending = h.acquire(url, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(1); expect(h.created).toEqual([]); expect(h.listeners.size).toBe(0);
});

test("pre-aborted and unauthenticated demand never fetches", async () => {
    let requests = 0;
    const h = harness(async () => { requests++; return { status: "pending", retryAfterMs: 1 }; });
    const controller = new AbortController(); controller.abort();
    await expect(h.acquire(url, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    h.switchOwner(null);
    await expect(h.acquire(url, new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(0);
});

test("account switch aborts a pending result, and a later account receives its own lease", async () => {
    let finish: (value: ServerImageThumbnail) => void = () => {};
    let requests = 0;
    const h = harness(async () => ++requests === 1 ? new Promise(resolve => { finish = resolve; }) : { status: "ready", blob: new Blob(["new owner"]) });
    const old = h.acquire(url, new AbortController().signal);
    h.switchOwner("employee-b"); finish({ status: "ready", blob: new Blob(["old owner"]) });
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(h.created).toEqual([]);
    const current = await h.acquire(url, new AbortController().signal);
    expect(current.url).toBe("blob:employee-b-1");
    h.switchOwner("employee-c"); expect(h.revoked).toEqual([current.url]);
    current.release(); expect(h.revoked).toHaveLength(1);
});

test("a completed lease survives request cleanup for smooth tier upgrades, but not an account switch", async () => {
    const h = harness(async () => ({ status: "ready", blob: new Blob(["ready"]) }));
    const controller = new AbortController(), lease = await h.acquire(url, controller.signal);
    controller.abort(); expect(h.revoked).toEqual([]);
    h.switchOwner(null); expect(h.revoked).toEqual([lease.url]);
});

test("API opts in to pending protocol, validates media and never redirects to original content", async () => {
    const nativeFetch = globalThis.fetch;
    const requests: string[] = [];
    try {
        let response = new Response(null, { status: 202, headers: { "Retry-After": "2" } });
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { requests.push(String(input)); expect(init?.credentials).toBe("include"); expect(init?.signal).toBeInstanceOf(AbortSignal); return response; }) as typeof fetch;
        expect(await fetchServerImageThumbnail(url, new AbortController().signal)).toEqual({ status: "pending", retryAfterMs: 2000 });
        response = new Response("webp", { headers: { "Content-Type": "image/webp" } });
        expect((await fetchServerImageThumbnail(url, new AbortController().signal)).status).toBe("ready");
        response = new Response(null, { status: 422 });
        await expect(fetchServerImageThumbnail(url, new AbortController().signal)).rejects.toThrow("422");
        response = new Response("not an image", { headers: { "Content-Type": "text/html" } });
        await expect(fetchServerImageThumbnail(url, new AbortController().signal)).rejects.toThrow("不可用");
        await expect(fetchServerImageThumbnail(url.replace("/thumb?w=256", "/content"), new AbortController().signal)).rejects.toThrow("地址无效");
        expect(requests).toEqual(Array(4).fill(`${url}&pending=1`));
    } finally { globalThis.fetch = nativeFetch; }
});
