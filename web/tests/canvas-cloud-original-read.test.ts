import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const original = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 255])], { type: "image/png" });
const cloud = "/api/assets/cloud-original/content";
const node = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({ id: "image", title: "原图", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 256, height: 256, metadata });

function reader(file: string, stored: Blob | null = null, storageError?: Error) {
    const url = new URL(`../src/lib/canvas/${file}.ts`, import.meta.url), requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
    const resolutions: Array<[string | undefined, string]> = [], fetches: string[] = [];
    const dependencies = {
        async getImageBlob() { if (storageError) throw storageError; return stored; },
        async resolveImageUrl(key?: string, fallback = "") { if (storageError) throw storageError; resolutions.push([key, fallback]); return fallback; },
    };
    class DecodedImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 256;
        naturalHeight = 256;
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    const module = { exports: {} as Record<string, Function> };
    new Function("require", "module", "exports", "fetch", "Image", code)(
        (id: string) => id === "@/services/image-storage" ? dependencies : requireModule(id), module, module.exports,
        async (source: string) => { fetches.push(source); if (source !== cloud) throw new Error("unexpected original source"); return new Response(original); }, DecodedImage,
    );
    return { api: module.exports, resolutions, fetches };
}

test("clipboard cloud originals preserve exact bytes without reading expired display URLs", async () => {
    for (const metadata of [{ serverAssetId: "cloud-original" }, { serverAssetId: "cloud-original", storageKey: "image:evicted", content: "blob:expired" }]) {
        const loaded = reader("canvas-image-clipboard");
        const result = await loaded.api.loadCanvasClipboardImage(node(metadata));
        expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
        expect(loaded.fetches).toEqual([cloud]);
        expect(loaded.resolutions).toEqual([[metadata.storageKey, cloud]]);
    }
});

test("clipboard never substitutes a local missing file with its unrelated display thumbnail", async () => {
    const loaded = reader("canvas-image-clipboard");
    await expect(loaded.api.loadCanvasClipboardImage(node({ storageKey: "image:missing", content: "data:image/png;base64,thumbnail" }))).rejects.toThrow("原图暂时无法读取");
    expect(loaded.resolutions).toEqual([["image:missing", ""]]);
    expect(loaded.fetches).toEqual([]);
});

test("local clipboard bytes stay authoritative and employee-storage failures cannot fall back to cloud", async () => {
    const metadata = { storageKey: "image:local", serverAssetId: "cloud-original", content: "blob:expired" };
    const loaded = reader("canvas-image-clipboard", original);
    expect(await loaded.api.loadCanvasClipboardImage(node(metadata))).toBe(original);
    expect(loaded.fetches).toEqual([]);
    expect(loaded.resolutions).toEqual([]);
    const denied = reader("canvas-image-clipboard", null, new Error("员工会话已变化"));
    await expect(denied.api.loadCanvasClipboardImage(node(metadata))).rejects.toThrow("员工会话已变化");
    expect(denied.fetches).toEqual([]);
});

test("explicit comparison decodes cloud-only and evicted originals from the durable source", async () => {
    for (const metadata of [{ serverAssetId: "cloud-original" }, { serverAssetId: "cloud-original", storageKey: "image:evicted", content: "blob:expired" }]) {
        const loaded = reader("canvas-image-compare");
        const result = await loaded.api.loadCanvasCompareImage(node(metadata));
        expect([result.naturalWidth, result.naturalHeight]).toEqual([256, 256]);
        expect(loaded.fetches).toEqual([cloud]);
        expect(loaded.resolutions).toEqual([[metadata.storageKey, cloud]]);
    }
});

test("aborted comparison never reads the original", async () => {
    const loaded = reader("canvas-image-compare");
    await expect(loaded.api.loadCanvasCompareImage(node({ serverAssetId: "cloud-original" }), AbortSignal.abort())).rejects.toThrow();
    expect(loaded.fetches).toEqual([]);
    expect(loaded.resolutions).toEqual([]);
});
