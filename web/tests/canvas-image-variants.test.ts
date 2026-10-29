import { afterEach, expect, test } from "bun:test";

import { downloadCanvasImageVariant, hasCanvasImageVariants, loadCanvasImageVariants } from "@/lib/canvas/canvas-export";
import { fetchServerAssetVariants, type ServerAssetVariant, type ServerAssetVariants } from "@/services/api/server-assets";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const primaryId = "00000000-0000-4000-8000-000000000001";
const originalId = "00000000-0000-4000-8000-000000000002";
const exportId = "00000000-0000-4000-8000-000000000003";
const variant = (assetId: string, mimeType = "image/png"): ServerAssetVariant => ({ assetId, url: `/api/assets/${assetId}/content`, mimeType, filename: "result.png" });
const variants: ServerAssetVariants = { primary: variant(primaryId), original: variant(originalId), export: variant(exportId, "image/webp"), maskComposited: true };
const node = (metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id: "image", title: "款号.jpg", type: CanvasNodeType.Image, width: 50, height: 50, position: { x: 0, y: 0 }, metadata: { content: "blob:display", mimeType: "image/png", imageVersion: 2, ...metadata } });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("restored local image resolves variants through its durable media source", async () => {
    const queried: string[] = [];
    const result = await loadCanvasImageVariants(node({ storageKey: "image:restored" }), {
        readMediaSource: async key => { expect(key).toBe("image:restored"); return variant(primaryId).url; },
        fetchVariants: async id => { queried.push(id); return variants; },
    });
    expect(result).toBe(variants);
    expect(queried).toEqual([primaryId]);
});

test("a direct current server URL resolves variants without consulting local storage", async () => {
    expect(await loadCanvasImageVariants(node({ content: variant(primaryId).url }), {
        readMediaSource: async () => { throw new Error("must not read storage"); },
        fetchVariants: async id => { expect(id).toBe(primaryId); return variants; },
    })).toBe(variants);
});

test("creative edits do not reuse the old task result or a stale server URL", async () => {
    const edited = node({ storageKey: "image:edited", content: variant(originalId).url, imageTask: { taskId: "old-task", requestId: "old-request", ownerId: "owner", projectId: "project", resultIndex: 0 } });
    expect(await loadCanvasImageVariants(edited, {
        readMediaSource: async () => null,
        fetchVariants: async () => { throw new Error("must not query old variants"); },
    })).toBeNull();
});

test("ordinary local images do not request server variants", async () => {
    expect(await loadCanvasImageVariants(node(), { fetchVariants: async () => { throw new Error("must not query"); } })).toBeNull();
});

test("permission and source-storage failures propagate without fallback", async () => {
    await expect(loadCanvasImageVariants(node({ storageKey: "image:private" }), {
        readMediaSource: async () => variant(primaryId).url,
        fetchVariants: async () => { throw new Error("无权查看此素材"); },
    })).rejects.toThrow("无权查看此素材");
    await expect(loadCanvasImageVariants(node({ storageKey: "image:private", content: variant(primaryId).url }), {
        readMediaSource: async () => { throw new Error("员工会话已变化"); },
    })).rejects.toThrow("员工会话已变化");
});

test("a choice is offered only when different server variants actually exist", () => {
    expect(hasCanvasImageVariants(variants)).toBe(true);
    expect(hasCanvasImageVariants({ primary: variants.primary, original: variants.primary, maskComposited: false })).toBe(false);
    expect(hasCanvasImageVariants({ primary: variants.primary, original: variants.primary, export: variants.primary, maskComposited: false })).toBe(false);
    expect(hasCanvasImageVariants({ primary: variants.primary, original: variants.primary, export: variants.export, maskComposited: false })).toBe(true);
});

test("strict PNG, provider original and WebP copy save the exact fetched bytes without re-encoding", async () => {
    for (const kind of ["primary", "original", "export"] as const) {
        const selected = variants[kind]!;
        const blob = new Blob([new Uint8Array([1, 2, 3, 255])], { type: selected.mimeType });
        const saves: { blob: Blob; name: string }[] = [];
        await downloadCanvasImageVariant(node(), selected, kind, {
            fetchBlob: async id => { expect(id).toBe(selected.assetId); return blob; },
            save: (saved, name) => { saves.push({ blob: saved, name }); },
        });
        expect(saves).toHaveLength(1);
        expect(saves[0]!.blob).toBe(blob);
        expect(saves[0]!.name).toBe(kind === "primary" ? "款号_v2.png" : kind === "original" ? "款号_v2_渠道原件.png" : "款号_v2_格式副本.webp");
    }
});

test("download filename follows received MIME and keeps the image name and version", async () => {
    let filename = "";
    await downloadCanvasImageVariant(node({ imageName: "新名字", imageVersion: 4 }), variant(exportId, "image/webp"), "export", {
        fetchBlob: async () => new Blob(["png"], { type: "image/png" }),
        save: (_blob, name) => { filename = name; },
    });
    expect(filename).toBe("新名字_v4_格式副本.png");
});

test("download failures, empty bytes and non-image responses are never saved", async () => {
    let saves = 0;
    const save = () => { saves += 1; };
    await expect(downloadCanvasImageVariant(node(), variants.original, "original", { fetchBlob: async () => { throw new Error("素材下载失败（403）"); }, save })).rejects.toThrow("403");
    await expect(downloadCanvasImageVariant(node(), variants.original, "original", { fetchBlob: async () => new Blob(), save })).rejects.toThrow("图片内容为空");
    await expect(downloadCanvasImageVariant(node(), variants.original, "original", { fetchBlob: async () => new Blob(["denied"], { type: "text/html" }), save })).rejects.toThrow("不是图片");
    expect(saves).toBe(0);
});

test("cancelling an original variant forwards cancellation and never saves a stale response", async () => {
    const controller = new AbortController(); let saves = 0;
    await expect(downloadCanvasImageVariant(node(), variants.original, "original", {
        fetchBlob: async (_id, signal) => { expect(signal).toBeDefined(); controller.abort(); expect(signal?.aborted).toBe(true); return new Blob(["source"], { type: "image/png" }); },
        save: () => { saves++; },
    }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(saves).toBe(0);
});

test("variants API accepts the standard success envelope and the existing demo response", async () => {
    for (const payload of [{ code: 0, data: variants, msg: "ok" }, variants]) {
        globalThis.fetch = (async (path, init) => {
            expect(path).toBe(`/api/assets/${primaryId}/variants`);
            expect(init?.credentials).toBe("include");
            return Response.json(payload);
        }) as typeof fetch;
        expect(await fetchServerAssetVariants(primaryId)).toEqual(variants);
    }
});

test("variants API refuses HTTP and business authorization errors", async () => {
    globalThis.fetch = (async () => Response.json({ code: 403, data: null, msg: "无权读取" }, { status: 403 })) as typeof fetch;
    await expect(fetchServerAssetVariants(primaryId)).rejects.toThrow("无权读取");
    globalThis.fetch = (async () => Response.json({ code: 403, data: variants, msg: "无权读取" })) as typeof fetch;
    await expect(fetchServerAssetVariants(primaryId)).rejects.toThrow("无权读取");
});
