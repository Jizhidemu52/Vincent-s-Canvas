import { afterEach, expect, test } from "bun:test";
import { collectReferencePage, normalizePageUrl, referenceReturnPath } from "../src/pages/reference-import/collect";
import { ReferenceRequestError, scanReferencePage } from "../src/services/api/reference-import";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const candidates = ["one", "two", "three"].map(id => ({ id, name: `${id}.png`, sourceImage: `https://example.com/${id}.png` }));
const scan = { scanId: "scan-1", pageUrl: "https://example.com/gallery", pageTitle: "Gallery", candidates, expiresAt: "2026-09-18T09:00:00Z", warnings: [] };
const image = (id: string) => ({ id, name: id, mime: "image/png", base64: png, sourcePage: scan.pageUrl, sourceImage: `https://example.com/${id}.png`, pageTitle: scan.pageTitle });
const success = (data: unknown) => Response.json({ code: 0, data, msg: "" });
const failure = (status: number) => Response.json({ code: status, data: null, msg: `failure-${status}` }, { status });

function context(controller = new AbortController()) {
    const images: string[] = [];
    const failures: string[] = [];
    const progress: number[] = [];
    const options = {
        url: scan.pageUrl, ownerId: "employee-1", signal: controller.signal, getOwner: () => "employee-1",
        onScan: () => {}, onImage: (value: { payload: { id: string } }) => { images.push(value.payload.id); },
        onFailure: (name: string, reason: string) => { failures.push(`${name}: ${reason}`); },
        onProgress: (completed: number) => { progress.push(completed); },
    };
    return { options, images, failures, progress };
}

test("only complete HTTP(S) URLs without credentials are accepted", () => {
    expect(normalizePageUrl(" https://example.com/a?x=1#part ")).toBe("https://example.com/a?x=1");
    expect(normalizePageUrl("http://example.com/a")).toBe("http://example.com/a");
    for (const url of ["example.com", "file:///a", "javascript:alert(1)", "https://user:pass@example.com"]) expect(() => normalizePageUrl(url)).toThrow();
});

test("return navigation is limited to canvas routes", () => {
    expect(referenceReturnPath("?returnTo=%2Fcanvas%2Fabc")).toBe("/canvas/abc");
    for (const path of ["https://evil.test", "//evil.test", "/assets", "/canvas\\evil", "/canvas/\n", "/canvas/../admin", "/canvas/%2e%2e/admin"]) expect(referenceReturnPath(`?returnTo=${encodeURIComponent(path)}`)).toBe("/assets");
});

test("collection uses same-origin credentialed APIs with owner header and only URL or opaque IDs", async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (path, init) => {
        calls.push({ path: String(path), init: init! });
        const body = JSON.parse(String(init!.body));
        return success(String(path).endsWith("/scan") ? scan : image(body.imageId));
    }) as typeof fetch;
    const ctx = context();
    await collectReferencePage(ctx.options);
    expect(ctx.images).toEqual(["one", "two", "three"]);
    expect(ctx.progress).toEqual([1, 2, 3]);
    expect(calls.map(value => value.path)).toEqual(["/api/reference-import/scan", ...Array(3).fill("/api/reference-import/image")]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: scan.pageUrl });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ scanId: "scan-1", imageId: "one" });
    for (const call of calls) {
        expect(call.init.credentials).toBe("include");
        expect(new Headers(call.init.headers).get("X-Canvas-Owner-Id")).toBe("employee-1");
        expect(call.init.signal).toBe(ctx.options.signal);
    }
});

test("one image failure remains visible while later candidates can succeed", async () => {
    globalThis.fetch = (async (path, init) => {
        const body = JSON.parse(String(init!.body));
        return String(path).endsWith("/scan") ? success(scan) : body.imageId === "two" ? failure(422) : success(image(body.imageId));
    }) as typeof fetch;
    const ctx = context();
    await collectReferencePage(ctx.options);
    expect(ctx.images).toEqual(["one", "three"]);
    expect(ctx.failures).toEqual(["two.png: failure-422"]);
});

for (const status of [401, 403]) test(`${status} immediately stops remaining requests`, async () => {
    let calls = 0;
    globalThis.fetch = (async (path, init) => {
        calls++;
        const body = JSON.parse(String(init!.body));
        return String(path).endsWith("/scan") ? success(scan) : body.imageId === "two" ? failure(status) : success(image(body.imageId));
    }) as typeof fetch;
    const ctx = context();
    await expect(collectReferencePage(ctx.options)).rejects.toBeInstanceOf(ReferenceRequestError);
    expect(calls).toBe(3);
    expect(ctx.images).toEqual(["one"]);
});

test("owner changes during an image request prevent its draft and all later requests", async () => {
    let owner = "employee-1";
    let calls = 0;
    globalThis.fetch = (async (path) => {
        calls++;
        if (String(path).endsWith("/scan")) return success(scan);
        owner = "employee-2";
        return success(image("one"));
    }) as typeof fetch;
    const ctx = context(); ctx.options.getOwner = () => owner;
    await expect(collectReferencePage(ctx.options)).rejects.toThrow("员工身份已变化");
    expect(ctx.images).toEqual([]);
    expect(calls).toBe(2);
});

test("cancel ignores a late image response even if the transport does not honor abort", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async (path) => {
        calls++;
        if (String(path).endsWith("/scan")) return success(scan);
        controller.abort();
        return success(image("one"));
    }) as typeof fetch;
    const ctx = context(controller);
    await expect(collectReferencePage(ctx.options)).rejects.toThrow();
    expect(ctx.images).toEqual([]);
    expect(ctx.failures).toEqual([]);
    expect(calls).toBe(2);
});

test("untrusted candidate count is capped to twenty and invalid bytes are rejected", async () => {
    let calls = 0;
    globalThis.fetch = (async (path) => {
        calls++;
        return String(path).endsWith("/scan") ? success({ ...scan, candidates: Array(25).fill(candidates[0]) }) : success({ ...image("one"), base64: "!!!!" });
    }) as typeof fetch;
    const ctx = context();
    await collectReferencePage(ctx.options);
    expect(calls).toBe(21);
    expect(ctx.images).toEqual([]);
    expect(ctx.failures).toHaveLength(20);
});

test("page total above 30 MiB does not create an oversized draft", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const base64 = Buffer.from(bytes).toString("base64");
    globalThis.fetch = (async (path) => String(path).endsWith("/scan") ? success({ ...scan, candidates: Array(4).fill(candidates[0]) }) : success({ ...image("one"), base64 })) as typeof fetch;
    const ctx = context();
    await collectReferencePage(ctx.options);
    expect(ctx.images).toHaveLength(3);
    expect(ctx.failures[0]).toContain("30 MiB");
});

test("malformed API responses and missing identity do not produce scan data", async () => {
    globalThis.fetch = (async () => new Response("bad response")) as typeof fetch;
    await expect(scanReferencePage(scan.pageUrl, "employee-1", new AbortController().signal)).rejects.toThrow("请求失败");
    await expect(scanReferencePage(scan.pageUrl, "", new AbortController().signal)).rejects.toThrow("登录");
});
