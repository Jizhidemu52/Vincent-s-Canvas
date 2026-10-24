import { afterEach, expect, test } from "bun:test";
import { loadSeamlessPreview } from "../src/pages/image/seamless-preview";

const originalFetch = globalThis.fetch;
const originalImage = globalThis.Image;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.Image = originalImage;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
});

function fixture(broken = false) {
    const created: string[] = [], revoked: string[] = [];
    URL.createObjectURL = () => { const url = `blob:preview-${created.length}`; created.push(url); return url; };
    URL.revokeObjectURL = url => { revoked.push(url); };
    globalThis.fetch = (async () => new Response(new Blob(["original"], { type: "image/webp" }))) as typeof fetch;
    globalThis.Image = class {
        naturalWidth = 1600;
        naturalHeight = 900;
        onload?: () => void;
        onerror?: () => void;
        set src(value: string) { if (value) queueMicrotask(() => broken ? this.onerror?.() : this.onload?.()); }
    } as unknown as typeof Image;
    return { created, revoked };
}

test("repeated history previews retain the server URL without creating persisted copies", async () => {
    const urls = fixture();
    for (let index = 0; index < 3; index++) {
        expect(await loadSeamlessPreview("/api/assets/result/content")).toEqual({ url: "/api/assets/result/content", width: 1600, height: 900, bytes: 8, mimeType: "image/webp" });
    }
    expect(urls.created).toHaveLength(3);
    expect(urls.revoked).toEqual(urls.created);
});

test("failed decoding releases temporary preview resources", async () => {
    const urls = fixture(true);
    await expect(loadSeamlessPreview("/api/assets/result/content")).rejects.toThrow("无法读取");
    expect(urls.revoked).toEqual(urls.created);
});

test("failed and empty responses never create preview URLs", async () => {
    const urls = fixture();
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    await expect(loadSeamlessPreview("/missing")).rejects.toThrow("404");
    globalThis.fetch = (async () => new Response(new Blob([]))) as typeof fetch;
    await expect(loadSeamlessPreview("/empty")).rejects.toThrow("为空");
    expect(urls.created).toEqual([]);
});
