import { expect, test } from "bun:test";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

import { canvasImageExportSelection, createCanvasImagePdfExport, type CanvasImagePdfProgress } from "@/lib/canvas/canvas-image-pdf";
import { readZip } from "@/lib/zip";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const redWide = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64")], { type: "image/png" });
const blueTall = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAADAQMAAABoE/fBAAAAA1BMVEUAAP+KeNJXAAAAC0lEQVR4nGNgAAEAAAYAAf6MZ8gAAAAASUVORK5CYII=", "base64")], { type: "image/png" });
const tinyJpeg = new Blob([Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAf/2Q==", "base64")], { type: "image/jpeg" });

function node(id: string, title = "方案.png", metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, title, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 400, height: 400, metadata: { content: `test:${id}`, ...metadata } };
}

async function measureImage(blob: Blob) {
    // Tests use the real PNG/JPEG parser; browser decoding is exercised by the UI check.
    const pdf = await PDFDocument.create();
    const data = await blob.arrayBuffer();
    const image = blob.type === "image/jpeg" ? await pdf.embedJpg(data) : await pdf.embedPng(data);
    return { width: image.width, height: image.height };
}

test("merged PDF preserves selected order, source dimensions/aspect, title and node data", async () => {
    const nodes = [node("tall"), node("wide")];
    const before = JSON.stringify(nodes);
    const loaded: string[] = [];
    const progress: CanvasImagePdfProgress[] = [];
    const result = await createCanvasImagePdfExport({ nodes, setName: "秋冬/提案.pdf", mode: "merged", onProgress: (value) => progress.push(value) }, {
        loadImage: async (item) => { loaded.push(item.id); return item.id === "tall" ? blueTall : redWide; }, measureImage,
    });
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(pdf.getPages().map((page) => page.getSize())).toEqual([{ width: 0.75, height: 2.25 }, { width: 1.5, height: 0.75 }]);
    expect(pdf.getTitle()).toBe("秋冬_提案");
    expect(result.fileName).toBe("秋冬_提案.pdf");
    expect(result.blob.type).toBe("application/pdf");
    expect(loaded).toEqual(["tall", "wide"]);
    expect(progress.at(-1)?.completed).toBe(2);
    expect(JSON.stringify(nodes)).toBe(before);
});

test("separate PDF ZIP has exactly one page per file and safe unique ordered versioned names", async () => {
    const nodes = [node("first", "same.png", { imageName: "服装/正面", imageVersion: 3 }), node("second", "same.png", { imageName: "服装/正面", imageVersion: 3 })];
    const result = await createCanvasImagePdfExport({ nodes, setName: "单页图集", mode: "separate" }, { loadImage: async (item) => item.id === "first" ? redWide : blueTall, measureImage });
    const files = await readZip(result.blob);
    expect(result.fileName).toBe("单页图集.zip");
    expect([...files.keys()]).toEqual(["001_服装_正面_v3.pdf", "002_服装_正面_v3.pdf"]);
    const sizes = [];
    for (const blob of files.values()) {
        const pdf = await PDFDocument.load(await blob.arrayBuffer());
        expect(pdf.getPageCount()).toBe(1);
        sizes.push(pdf.getPage(0).getSize());
    }
    expect(sizes).toEqual([{ width: 1.5, height: 0.75 }, { width: 0.75, height: 2.25 }]);
});

test("100 selected images create exactly 100 pages without duplicates or skipped pages", async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => node(`page-${index}`));
    let active = 0;
    let maxActive = 0;
    const result = await createCanvasImagePdfExport({ nodes, setName: "百页方案", mode: "merged" }, {
        loadImage: async (item) => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return Number(item.id.slice(5)) % 2 ? blueTall : redWide; }, measureImage,
    });
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(pdf.getPageCount()).toBe(100);
    expect(maxActive).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 1.5, height: 0.75 });
    expect(pdf.getPage(99).getSize()).toEqual({ width: 0.75, height: 2.25 });
});

test("JPEG is embedded with its original bytes without PNG conversion", async () => {
    const result = await createCanvasImagePdfExport({ nodes: [node("jpeg")], setName: "JPEG", mode: "merged" }, { loadImage: async () => tinyJpeg, measureImage, convertImage: async () => { throw new Error("should not convert JPEG"); } });
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
    const xobjects = pdf.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const stream = pdf.context.lookup(xobjects.values()[0], PDFRawStream);
    expect(stream.dict.get(PDFName.of("Filter"))?.toString()).toBe("/DCTDecode");
    expect(stream.contents).toEqual(new Uint8Array(await tinyJpeg.arrayBuffer()));
});

test("other image formats use a PNG conversion, retaining actual image aspect", async () => {
    const webp = new Blob(["fake webp: browser decoder is injected"], { type: "image/webp" });
    let conversions = 0;
    const result = await createCanvasImagePdfExport({ nodes: [node("webp")], setName: "WebP", mode: "merged" }, {
        loadImage: async () => webp,
        measureImage: async () => ({ width: 1, height: 3 }),
        convertImage: async (blob) => { expect(blob).toBe(webp); conversions++; return blueTall; },
    });
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(conversions).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 0.75, height: 2.25 });
});

test("original image ZIP preserves bytes and does not measure or convert images", async () => {
    const result = await createCanvasImagePdfExport({ nodes: [node("one", "same.png"), node("two", "same.png")], setName: "原图", mode: "images" }, {
        loadImage: async (item) => item.id === "one" ? redWide : tinyJpeg,
        measureImage: async () => { throw new Error("must not decode original images"); },
        convertImage: async () => { throw new Error("must not convert original images"); },
    });
    const files = await readZip(result.blob);
    expect([...files.keys()]).toEqual(["001_same_v1.png", "002_same_v1.jpg"]);
    expect(new Uint8Array(await files.get("001_same_v1.png")!.arrayBuffer())).toEqual(new Uint8Array(await redWide.arrayBuffer()));
    expect(new Uint8Array(await files.get("002_same_v1.jpg")!.arrayBuffer())).toEqual(new Uint8Array(await tinyJpeg.arrayBuffer()));
});

test("failed image rejects the entire export at the named page without loading later images", async () => {
    const loaded: string[] = [];
    await expect(createCanvasImagePdfExport({ nodes: [node("one"), node("broken", "无法读取.png"), node("three")], setName: "失败", mode: "separate" }, {
        loadImage: async (item) => { loaded.push(item.id); if (item.id === "broken") throw new Error("原图不存在"); return redWide; }, measureImage,
    })).rejects.toThrow("第 2 张「无法读取_v1」导出失败：原图不存在。未下载任何文件。");
    expect(loaded).toEqual(["one", "broken"]);
});

test("original ZIP rejects HTML/JSON responses but accepts signature-verified octet-stream images", async () => {
    for (const blob of [new Blob(["<!doctype html><html>404</html>"], { type: "text/html" }), new Blob(['{"error":"expired"}'], { type: "image/png" }), new Blob(["not an image"], { type: "application/octet-stream" })]) {
        await expect(createCanvasImagePdfExport({ nodes: [node("bad")], setName: "set", mode: "images" }, { loadImage: async () => blob })).rejects.toThrow("未下载任何文件");
    }
    const octet = new Blob([redWide], { type: "application/octet-stream" });
    const result = await createCanvasImagePdfExport({ nodes: [node("valid")], setName: "set", mode: "images" }, { loadImage: async () => octet });
    expect([...(await readZip(result.blob)).keys()]).toEqual(["001_方案_v1.png"]);
});

test("rejects empty selections, duplicate IDs, blank set names and oversized individual images", async () => {
    const dependencies = { loadImage: async () => redWide, measureImage };
    await expect(createCanvasImagePdfExport({ nodes: [], setName: "set", mode: "merged" }, dependencies)).rejects.toThrow("至少选择");
    await expect(createCanvasImagePdfExport({ nodes: [node("a"), node("a")], setName: "set", mode: "merged" }, dependencies)).rejects.toThrow("重复图片");
    await expect(createCanvasImagePdfExport({ nodes: [node("a")], setName: " .pdf ", mode: "merged" }, dependencies)).rejects.toThrow("有效的图片集名称");
    await expect(createCanvasImagePdfExport({ nodes: [node("a")], setName: "set", mode: "merged" }, { ...dependencies, measureImage: async () => ({ width: 10_000, height: 10_000 }) })).rejects.toThrow("2000 万像素");
});

test("batch cover selection expands child order and all-images list does not repeat covers", () => {
    const first = node("a", "相同.png", { batchRootId: "root" });
    const second = node("b", "相同.png", { batchRootId: "root" });
    const root = node("root", "封面", { isBatchRoot: true, primaryImageId: "a", batchChildIds: ["b", "a", "missing"] });
    const standalone = node("single");
    const nodes = [root, first, second, standalone];
    expect(canvasImageExportSelection(nodes).map((item) => item.id)).toEqual(["b", "a", "single"]);
    expect(canvasImageExportSelection(nodes, ["single", "root", "a"]).map((item) => item.id)).toEqual(["single", "b", "a"]);
    expect(canvasImageExportSelection([node("old-root", "封面", { isBatchRoot: true, batchChildIds: ["missing"] })]).map((item) => item.id)).toEqual(["old-root"]);
});
