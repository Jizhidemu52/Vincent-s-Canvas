import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import * as filenames from "@/lib/canvas/canvas-image-filename";
import * as encoding from "@/lib/canvas/canvas-image-encoding";
import * as imageSource from "@/lib/canvas/canvas-image-source";
import * as worker from "@/lib/canvas/canvas-image-worker";
import { serverMediaId } from "@/services/canvas-media-links";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const assetId = "11111111-1111-4111-8111-111111111111";
const sourceUrl = `/api/assets/${assetId}/content`;
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 255, 0, 89]);
const node = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({ id: "image", type: CanvasNodeType.Image, title: "原图", width: 10, height: 10, position: { x: 0, y: 0 }, metadata });
const code = ts.transpileModule(readFileSync(new URL("../src/lib/canvas/canvas-export.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(read: (key: string) => Promise<Blob | null> = async () => null, fetchSource: typeof fetch = (async () => new Response(new Blob([bytes], { type: "image/png" }))) as typeof fetch) {
    const saves: { blob: Blob; filename: string }[] = [];
    const calls: { path: unknown; credentials: RequestCredentials | undefined }[] = [];
    const dependencies: Record<string, unknown> = {
        "file-saver": { saveAs: (blob: Blob, filename: string) => saves.push({ blob, filename }) },
        "@/services/image-storage": { getImageBlob: read },
        "@/services/canvas-media-links": { serverMediaId },
        "@/lib/canvas/canvas-image-filename": filenames,
        "@/lib/canvas/canvas-image-encoding": encoding,
        "@/lib/canvas/canvas-image-source": imageSource,
        "./canvas-image-source": imageSource,
        "./canvas-image-worker": worker,
    };
    const exported: Record<string, unknown> = {};
    new Function("require", "exports", "fetch", code)((name: string) => dependencies[name] || {}, exported, async (path: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ path, credentials: init?.credentials });
        return fetchSource(path, init);
    });
    return { download: exported.downloadCanvasImage as typeof import("@/lib/canvas/canvas-export").downloadCanvasImage, saves, calls };
}

test("direct original download uses a durable cloud ID for empty and expired display URLs", async () => {
    for (const metadata of [
        { serverAssetId: assetId },
        { content: "", serverAssetId: assetId },
        { content: "blob:expired", serverAssetId: assetId },
        { content: "blob:expired", serverAssetId: assetId, storageKey: "image:evicted" },
    ]) {
        const h = harness();
        await h.download(node(metadata));
        expect(h.calls).toEqual([{ path: sourceUrl, credentials: "include" }]);
        expect(h.saves).toHaveLength(1);
        expect(new Uint8Array(await h.saves[0].blob.arrayBuffer())).toEqual(bytes);
        expect(h.saves[0].filename).toBe("原图_v1.png");
    }
});

test("a valid local edited original is saved unchanged without reading its old remote source", async () => {
    const local = new Blob([bytes], { type: "image/png" });
    const h = harness(async key => { expect(key).toBe("image:edited"); return local; });
    await h.download(node({ content: sourceUrl, storageKey: "image:edited" }));
    expect(h.calls).toHaveLength(0);
    expect(h.saves[0].blob).toBe(local);
});

test("local employee-storage and remote authorization failures never produce a download", async () => {
    const local = harness(async () => { throw new Error("员工会话已变化"); });
    await expect(local.download(node({ content: "blob:expired", storageKey: "image:private", serverAssetId: assetId }))).rejects.toThrow("员工会话已变化");
    expect(local.calls).toHaveLength(0);
    expect(local.saves).toHaveLength(0);
    const remote = harness(undefined, (async () => new Response("forbidden", { status: 403 })) as typeof fetch);
    await expect(remote.download(node({ serverAssetId: assetId }))).rejects.toThrow("无法读取图片");
    expect(remote.saves).toHaveLength(0);
});
