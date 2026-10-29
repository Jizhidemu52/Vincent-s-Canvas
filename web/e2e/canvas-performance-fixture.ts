import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { BrowserContext, Page } from "@playwright/test";
import { MockCanvasApi, expect } from "./fixtures";

export const PERFORMANCE_SCENE = { version: 1, nodeCount: 500, imageCount: 100, connectionCount: 500, original: [1024, 768], thumbnail: [256, 192], seed: 20261029 };
export const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const crcTable = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    return crc >>> 0;
});
function pngChunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
}
/** Distinct seeded raster textile-like patterns, not one shared SVG or URL. */
export function performanceRaster(index: number, width: number, height: number) {
    const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const pixels = Buffer.alloc(height * (width * 3 + 1));
    let seed = (PERFORMANCE_SCENE.seed + index * 9973) >>> 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const at = y * (width * 3 + 1) + 1 + x * 3;
        const texture = (seed >>> 28) + ((Math.floor(x / 18) + Math.floor(y / 18)) % 2) * 40;
        pixels[at] = (index * 17 + x * 160 / width + texture) & 255;
        pixels[at + 1] = (index * 29 + y * 160 / height + texture) & 255;
        pixels[at + 2] = (index * 43 + (x + y) * 80 / width + texture) & 255;
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

export async function preparePerformanceScene(context: BrowserContext, api: MockCanvasApi, origin = `http://127.0.0.1:${process.env.CANVAS_PERF_PORT || "5201"}`) {
    const images = new Map<string, { original: Buffer; thumbnail: Buffer }>();
    let bytes = 0;
    const hashes: string[] = [];
    const imageHashes = new Map<string, { original: string; thumbnail: string }>();
    for (let index = 0; index < 100; index++) {
        const id = `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const original = performanceRaster(index, 1024, 768), thumbnail = performanceRaster(index, 256, 192);
        images.set(id, { original, thumbnail }); bytes += original.length + thumbnail.length;
        hashes.push(createHash("sha256").update(original).digest("hex"));
        imageHashes.set(id, { original: hashes.at(-1)!, thumbnail: createHash("sha256").update(thumbnail).digest("hex") });
    }
    const requests: Array<{ id: string; kind: string; edge: number; bytes: number }> = [];
    await context.route(/\/api\/assets\/[0-9a-f-]+\/(content|thumb)(\?.*)?$/, route => {
        const url = new URL(route.request().url()), id = url.pathname.split("/")[3]!;
        if (url.origin !== origin) return route.fallback();
        const image = images.get(id);
        if (!image) return route.fallback();
        const edge = url.pathname.endsWith("/thumb") ? Number(url.searchParams.get("w")) : 1024;
        const buffer = edge <= 256 ? image.thumbnail : image.original;
        requests.push({ id, kind: url.pathname.endsWith("/thumb") ? "thumbnail" : "original", edge, bytes: buffer.length });
        return route.fulfill({ status: 200, contentType: "image/png", body: buffer });
    });
    const ids = [...images.keys()];
    const nodes = Array.from({ length: 500 }, (_, index) => {
        const imageIndex = index % 5 === 4 ? (index - 4) / 5 : -1;
        return {
            id: `performance-node-${index}`, type: imageIndex >= 0 ? "image" : "text", title: `性能样本 ${index}`,
            position: { x: (index % 25) * 240, y: Math.floor(index / 25) * 220 }, width: 192, height: 144,
            metadata: imageIndex >= 0 ? { status: "idle", content: `/api/assets/${ids[imageIndex]}/content`, naturalWidth: 1024, naturalHeight: 768, mimeType: "image/png", bytes: images.get(ids[imageIndex]!)!.original.length }
                : { status: "idle", content: `可复现的设计节点 ${index}\n棉麻纹理、尺寸与工艺说明`, fontSize: 14 },
        };
    });
    const document = {
        id: PROJECT_ID, title: "隔离性能验收 500 节点 100 图", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
        nodes, connections: nodes.map((node, index) => ({ id: `perf-link-${index}`, fromNodeId: node.id, toNodeId: nodes[(index + 1) % nodes.length]!.id })),
        groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
        viewport: { x: 400, y: 160, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] },
    };
    api.documents.set(PROJECT_ID, { id: PROJECT_ID, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    return { requests, imageHashes, manifest: { ...PERFORMANCE_SCENE, compressedBytes: bytes, uniqueImageHashes: new Set(hashes).size, sha256: createHash("sha256").update(JSON.stringify({ document, imageHashes: hashes })).digest("hex") } };
}

/** Verify the rendered product images, independently of the extra decoder
 * warmup. This catches a routing mismatch falling back to fixtures.IMAGE. */
export async function inspectRenderedPerformanceImages(page: Page, selector = '[data-node-id] img') {
    return page.locator(selector).evaluateAll(async elements => Promise.all(elements.map(async element => {
        const image = element as HTMLImageElement;
        await image.decode();
        const bytes = await (await fetch(image.currentSrc)).arrayBuffer();
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        return { nodeId: image.closest('[data-node-id]')?.getAttribute('data-node-id'), src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight,
            sha256: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("") };
    })));
}

export async function openPerformanceScene(page: Page) {
    await page.goto(`/canvas/${PROJECT_ID}`);
    await expect(page.locator('[data-node-id="performance-node-0"]')).toBeVisible();
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    if (await skip.isVisible()) await skip.click();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(800);
}

/** The fixture explicitly retains 100 decoded distinct thumbnails (18.75MiB
 * RGBA minimum). UI image requests are reported separately; this is not a claim
 * that virtualization paints every original or that JS heap includes pixels. */
export async function decodePerformanceThumbnails(page: Page) {
    return page.evaluate(async () => {
        const images = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
            const image = new Image(); image.src = `/api/assets/40000000-0000-4000-8000-${String(index).padStart(12, "0")}/thumb?w=256`;
            await image.decode(); return image;
        }));
        (window as any).__performanceDecodedImages = images;
        return { count: images.length, decodedPixels: images.reduce((total, image) => total + image.naturalWidth * image.naturalHeight, 0), widths: [...new Set(images.map(image => image.naturalWidth))] };
    });
}
