import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as objectUrlCache from "@/lib/object-url-cache";
import { createDedupedAsyncResolver } from "@/lib/deduped-async-resolver";

function compiled(path: string) {
    return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
    }).outputText;
}
const metadataCode = compiled("../src/lib/image-utils.ts");
const storageCode = compiled("../src/services/image-storage.ts");
type Metadata = { width: number; height: number; mimeType: string };

/** Per-instance browser APIs avoid global mocks leaking into other test suites. */
function metadataHarness() {
    const images: FakeImage[] = [];
    const timers = new Map<number, { run: () => void; delay: number }>();
    let timerId = 0;
    class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 0;
        naturalHeight = 0;
        src = "";
        constructor() { images.push(this); }
        load(width: number, height: number) { this.naturalWidth = width; this.naturalHeight = height; this.onload?.(); }
    }
    const module = { exports: {} as { readImageMeta: (url: string) => Promise<Metadata> } };
    new Function("module", "exports", "Image", "setTimeout", "clearTimeout", metadataCode)(
        module, module.exports, FakeImage,
        (run: () => void, delay: number) => { timers.set(++timerId, { run, delay }); return timerId; },
        (id: number) => timers.delete(id),
    );
    return { ...module.exports, images, timers };
}

test("image metadata uses decoded dimensions and clears the load handlers and timeout", async () => {
    const h = metadataHarness();
    const reading = h.readImageMeta("data:image/webp;base64,cGljdHVyZQ==");
    h.images[0]!.load(1200, 800);
    expect(await reading).toEqual({ width: 1200, height: 800, mimeType: "image/webp" });
    expect(h.timers.size).toBe(0);
    expect(h.images[0]!.onload).toBeNull();
    expect(h.images[0]!.onerror).toBeNull();
});

test("a decoder error and a zero-size decode reject instead of inventing 1024px dimensions", async () => {
    for (const trigger of [(image: ReturnType<typeof metadataHarness>["images"][number]) => image.onerror?.(), (image: ReturnType<typeof metadataHarness>["images"][number]) => image.load(0, 0)]) {
        const h = metadataHarness();
        const reading = h.readImageMeta("blob:broken-png");
        trigger(h.images[0]!);
        await expect(reading).rejects.toThrow(/图片/);
        expect(h.timers.size).toBe(0);
        expect(h.images[0]!.src).toBe("");
    }
});

test("slow decoding has a bounded timeout which rejects and ignores a late load", async () => {
    const h = metadataHarness();
    const reading = h.readImageMeta("blob:slow-image");
    const lateLoad = h.images[0]!.onload!;
    const timeout = [...h.timers.values()][0]!;
    expect(timeout.delay).toBeGreaterThan(3000);
    expect(timeout.delay).toBeLessThanOrEqual(60_000);
    timeout.run();
    h.images[0]!.naturalWidth = 10;
    h.images[0]!.naturalHeight = 10;
    lateLoad();
    await expect(reading).rejects.toThrow("图片读取超时");
    expect(h.timers.size).toBe(0);
});

test("metadata accepts browser-decoded SVG and animated image formats without re-encoding", async () => {
    for (const mimeType of ["image/svg+xml", "image/gif", "image/avif", "image/webp", "image/jpeg"]) {
        const h = metadataHarness();
        const reading = h.readImageMeta(`data:${mimeType};base64,cGljdHVyZQ==`);
        h.images[0]!.load(640, 480);
        expect(await reading).toEqual({ width: 640, height: 480, mimeType });
    }
});

function storageHarness(options: { decode?: () => Promise<Metadata>; response?: Response; failSave?: boolean; failSource?: boolean; failCleanup?: boolean } = {}) {
    const stored = new Map<string, Blob>();
    const sources = new Map<string, string>();
    const urls = new Map<string, Blob>();
    const revoked: string[] = [];
    const events: string[] = [];
    let sequence = 0;
    const URL = {
        createObjectURL(blob: Blob) { const url = `blob:test-${++sequence}`; urls.set(url, blob); events.push("url"); return url; },
        revokeObjectURL(url: string) { revoked.push(url); urls.delete(url); },
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/workspace-storage": { createWorkspaceStorage: () => ({
            assertAccess() {}, assertIdentity() {},
            async setItem(key: string, value: Blob) { events.push("save"); stored.set(key, value); if (options.failSave) throw new Error("storage write failed"); return value; },
            async getItem(key: string) { return stored.get(key) || null; },
            async removeItem(key: string) { if (options.failCleanup) throw new Error("storage unavailable"); stored.delete(key); },
        }) },
        "./canvas-media-links": {
            async rememberMediaSource(key: string, url: string) { events.push("source"); sources.set(key, url); if (options.failSource) throw new Error("source write failed"); },
            async forgetMediaSource(key: string) { sources.delete(key); },
        },
        "nanoid": { nanoid: () => `test-${++sequence}` },
        "@/lib/image-utils": { async readImageMeta() { events.push("decode"); return options.decode ? options.decode() : { width: 30, height: 20, mimeType: "image/png" }; } },
        "@/lib/deduped-async-resolver": { createDedupedAsyncResolver },
        "@/lib/object-url-cache": objectUrlCache,
        "./image-thumbnails": { async invalidateImageThumbnails() {} },
    };
    const module = { exports: {} as typeof import("@/services/image-storage") };
    new Function("require", "module", "exports", "URL", "fetch", storageCode)(
        (name: string) => dependencies[name], module, module.exports, URL,
        async () => options.response || new Response(new Blob(["remote-image-bytes"], { type: "image/png" })),
    );
    return { ...module.exports, stored, sources, urls, revoked, events };
}

test("empty files and empty URL responses are rejected before allocating or persisting images", async () => {
    for (const input of [new File([], "empty.png", { type: "image/png" }), "/api/assets/empty/content"]) {
        const h = storageHarness({ response: new Response("") });
        await expect(h.uploadImage(input)).rejects.toThrow("图片文件为空");
        expect(h.events).toEqual([]);
        expect(h.stored.size).toBe(0);
        expect(h.urls.size).toBe(0);
    }
});

test("HTTP errors are rejected before decoding or storing their response bodies", async () => {
    const h = storageHarness({ response: new Response("not an image", { status: 404 }) });
    await expect(h.uploadImage("/api/assets/missing/content")).rejects.toThrow("404");
    expect(h.events).toEqual([]);
    expect(h.stored.size).toBe(0);
});

test("a corrupt PNG never reaches persistence, media links, or the object URL cache", async () => {
    const h = storageHarness({ decode: async () => { throw new Error("图片无法读取"); } });
    await expect(h.uploadImage(new File([new Uint8Array(16)], "broken.png", { type: "image/png" }))).rejects.toThrow("图片无法读取");
    expect(h.events).toEqual(["url", "decode"]);
    expect(h.stored.size).toBe(0);
    expect(h.sources.size).toBe(0);
    expect(h.urls.size).toBe(0);
    expect(h.revoked).toEqual(["blob:test-2"]);
    expect(await h.resolveImageUrl("image:test-1", "fallback")).toBe("fallback");
});

test("valid originals are decoded before persistence and retain exact bytes and original filename", async () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]) {
        const h = storageHarness();
        const input = new File([new Uint8Array([0, 255, 120, 9, 13, 10])], "原图.png", { type: mimeType });
        const uploaded = await h.uploadImage(input);
        expect(h.events).toEqual(["url", "decode", "save"]);
        expect(h.stored.get(uploaded.storageKey)).toBe(input);
        expect(new Uint8Array(await (await h.getImageBlob(uploaded.storageKey))!.arrayBuffer())).toEqual(new Uint8Array(await input.arrayBuffer()));
        expect(uploaded).toMatchObject({ originalFileName: "原图.png", width: 30, height: 20, bytes: 6, mimeType });
        expect(await h.resolveImageUrl(uploaded.storageKey)).toBe(uploaded.url);
        expect(h.revoked).toEqual([]);
    }
});

test("an in-flight decode has no persisted image and is saved only once decoding finishes", async () => {
    const gate = Promise.withResolvers<Metadata>();
    const h = storageHarness({ decode: () => gate.promise });
    const uploading = h.uploadImage(new Blob(["image"]));
    expect(h.stored.size).toBe(0);
    expect(h.events).toEqual(["url", "decode"]);
    gate.resolve({ width: 10, height: 5, mimeType: "image/png" });
    await uploading;
    expect(h.events).toEqual(["url", "decode", "save"]);
});

test("failed blob and source writes roll back partial storage and revoke their unpublished URL", async () => {
    for (const options of [{ failSave: true }, { failSource: true }]) {
        const h = storageHarness(options);
        await expect(h.uploadImage("/api/assets/result/content")).rejects.toThrow(/write failed/);
        expect(h.stored.size).toBe(0);
        expect(h.sources.size).toBe(0);
        expect(h.urls.size).toBe(0);
        expect(h.revoked).toHaveLength(1);
        expect(await h.resolveImageUrl("image:test-1", "fallback")).toBe("fallback");
    }
});

test("a failed rollback reports the storage problem instead of silently promising cleanup", async () => {
    const h = storageHarness({ failSave: true, failCleanup: true });
    await expect(h.uploadImage(new Blob(["image"])) ).rejects.toThrow("本地临时数据清理失败");
    expect(h.urls.size).toBe(0);
});
