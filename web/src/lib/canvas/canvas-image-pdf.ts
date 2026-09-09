import { canvasImageDownloadFileName, canvasImageExportStem } from "@/lib/canvas/canvas-image-filename";
import { createZip } from "@/lib/zip";
import { resolveImageUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type CanvasImagePdfMode = "merged" | "separate" | "images";
export type CanvasImagePdfProgress = { completed: number; total: number; label: string };
export type CanvasImagePdfOptions = {
    nodes: readonly CanvasNodeData[];
    setName: string;
    mode: CanvasImagePdfMode;
    onProgress?: (progress: CanvasImagePdfProgress) => void;
};

type ImageSize = { width: number; height: number };
type PdfDependencies = {
    loadImage?: (node: CanvasNodeData) => Promise<Blob>;
    measureImage?: (blob: Blob) => Promise<ImageSize>;
    convertImage?: (blob: Blob) => Promise<Blob>;
};

// Bound both encoded data and decoded pixel memory. Images are loaded and flushed sequentially.
export const CANVAS_IMAGE_PDF_LIMITS = { images: 200, sourceBytes: 256 * 1024 * 1024, imagePixels: 20_000_000 };
const pointsPerPixel = 72 / 96;

export function isCanvasPdfImage(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image && Boolean(node.metadata?.storageKey || node.metadata?.content);
}

/** Batch roots are covers, not additional pages; expand them in their explicit child order. */
export function canvasImageExportSelection(nodes: readonly CanvasNodeData[], selectedIds?: readonly string[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const result = new Map<string, CanvasNodeData>();
    const visited = new Set<string>();
    const add = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const node = byId.get(id);
        if (!node) return;
        const children = node.metadata?.isBatchRoot ? (node.metadata.batchChildIds || []).filter((childId) => childId !== id && byId.has(childId) && isCanvasPdfImage(byId.get(childId)!)) : [];
        if (children.length) children.forEach(add);
        else if (isCanvasPdfImage(node)) result.set(id, node);
    };
    (selectedIds || nodes.map((node) => node.id)).forEach(add);
    return [...result.values()];
}

/** Builds the entire result before the caller downloads anything; failed pages are never omitted. */
export async function createCanvasImagePdfExport(options: CanvasImagePdfOptions, dependencies: PdfDependencies = {}) {
    const { nodes, mode, onProgress } = options;
    if (!nodes.length) throw new Error("请至少选择一张图片");
    if (nodes.length > CANVAS_IMAGE_PDF_LIMITS.images) throw new Error(`单次最多导出 ${CANVAS_IMAGE_PDF_LIMITS.images} 张图片，请分批导出`);
    if (nodes.some((node) => !isCanvasPdfImage(node))) throw new Error("选择中存在不可导出的图片，请重新选择");
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("选择中存在重复图片，请重新选择");
    if (mode !== "merged" && mode !== "separate" && mode !== "images") throw new Error("请选择有效的导出方式");
    const setName = options.setName.trim().replace(/\.(pdf|zip)$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 100);
    if (!setName) throw new Error("请填写有效的图片集名称");

    onProgress?.({ completed: 0, total: nodes.length, label: "正在准备图片集导出" });
    // This heavyweight dependency must remain outside the initial canvas bundle.
    const PDFDocument = mode === "images" ? null : (await import("pdf-lib")).PDFDocument;
    const loadImage = dependencies.loadImage || loadCanvasPdfImage;
    const measureImage = dependencies.measureImage || measureImageBlob;
    const convertImage = dependencies.convertImage || convertImageToPng;
    const merged = mode === "merged" ? await PDFDocument!.create() : null;
    const files: { name: string; data: Blob }[] = [];
    let sourceBytes = 0;

    for (const [index, node] of nodes.entries()) {
        const imageName = canvasImageExportStem(node);
        try {
            onProgress?.({ completed: index, total: nodes.length, label: `正在读取 ${index + 1}/${nodes.length}：${imageName}` });
            let blob = await loadImage(node);
            if (!blob.size) throw new Error("原图内容为空");
            const imageMime = await validateImageBlob(blob);
            sourceBytes += blob.size;
            if (sourceBytes > CANVAS_IMAGE_PDF_LIMITS.sourceBytes) throw new Error("原图总大小超过 256 MB，请减少图片或分批导出");
            if (mode === "images") {
                const fileName = canvasImageDownloadFileName({ ...node, metadata: { ...node.metadata, mimeType: imageMime } });
                files.push({ name: `${String(index + 1).padStart(3, "0")}_${fileName}`, data: blob });
                onProgress?.({ completed: index + 1, total: nodes.length, label: `已读取 ${index + 1}/${nodes.length} 张原图` });
                await new Promise((resolve) => setTimeout(resolve, 0));
                continue;
            }
            const dimensions = await measureImage(blob);
            const pixels = dimensions.width * dimensions.height;
            if (!Number.isFinite(pixels) || dimensions.width <= 0 || dimensions.height <= 0) throw new Error("无法读取原图尺寸");
            if (pixels > CANVAS_IMAGE_PDF_LIMITS.imagePixels) throw new Error("单张图片超过 2000 万像素，请先缩小图片");

            const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
            const isJpeg = signature[0] === 0xff && signature[1] === 0xd8;
            const isPng = signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47;
            if (!isJpeg && !isPng) blob = await convertImage(blob);
            if (blob.size > CANVAS_IMAGE_PDF_LIMITS.sourceBytes) throw new Error("转换后的图片过大，请先缩小图片");

            const pdf = merged || await PDFDocument!.create();
            const bytes = await blob.arrayBuffer();
            const image = isJpeg ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
            // 96 px = 72 pt. Very long images are uniformly reduced to the PDF 200-inch page limit.
            const scale = Math.min(pointsPerPixel, 14_400 / Math.max(image.width, image.height));
            const width = image.width * scale;
            const height = image.height * scale;
            pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
            await pdf.flush();
            if (!merged) {
                pdf.setTitle(`${setName} — ${imageName}`);
                files.push({ name: `${String(index + 1).padStart(3, "0")}_${imageName}.pdf`, data: new Blob([new Uint8Array(await pdf.save())], { type: "application/pdf" }) });
            }
            onProgress?.({ completed: index + 1, total: nodes.length, label: `已处理 ${index + 1}/${nodes.length} 张图片` });
            await new Promise((resolve) => setTimeout(resolve, 0));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`第 ${index + 1} 张「${imageName}」导出失败：${reason}。未下载任何文件。`);
        }
    }

    onProgress?.({ completed: nodes.length, total: nodes.length, label: mode === "merged" ? "正在生成 PDF 文件" : "正在打包文件" });
    if (merged) {
        merged.setTitle(setName);
        return { blob: new Blob([new Uint8Array(await merged.save())], { type: "application/pdf" }), fileName: `${setName}.pdf`, imageCount: nodes.length };
    }
    return { blob: await createZip(files), fileName: `${setName}.zip`, imageCount: nodes.length };
}

async function loadCanvasPdfImage(node: CanvasNodeData) {
    const url = await resolveImageUrl(node.metadata?.storageKey, node.metadata?.content || "");
    if (!url) throw new Error("找不到原图，请重新打开画布后重试");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`原图读取失败（${response.status}）`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > CANVAS_IMAGE_PDF_LIMITS.sourceBytes) throw new Error("原图超过 256 MB");
    return response.blob();
}

async function validateImageBlob(blob: Blob) {
    const type = blob.type.split(";")[0].toLowerCase();
    const bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
    const text = new TextDecoder().decode(bytes).trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|[\[{])/i.test(text)) throw new Error("原图地址返回了网页或错误数据，不是图片");
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    const signatures: [boolean, string][] = [
        [bytes[0] === 0xff && bytes[1] === 0xd8, "image/jpeg"],
        [bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, "image/png"],
        [/^GIF8[79]a/.test(text), "image/gif"],
        [/^RIFF[\s\S]{4}WEBP/.test(text), "image/webp"],
        [text.startsWith("BM"), "image/bmp"],
        [text.startsWith("II*\0") || text.startsWith("MM\0*"), "image/tiff"],
        [/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text), "image/svg+xml"],
        [String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" && /^(?:avif|avis|heic|heix|heif|mif1|msf1)$/.test(brand), brand.startsWith("avi") ? "image/avif" : "image/heif"],
    ];
    const detectedType = signatures.find(([matches]) => matches)?.[1];
    if (type.startsWith("image/")) return detectedType || type;
    if ((type && type !== "application/octet-stream") || !detectedType) throw new Error("原图内容或文件类型无效");
    return detectedType;
}

async function withBrowserImage<T>(blob: Blob, read: (image: HTMLImageElement) => T | Promise<T>): Promise<T> {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("浏览器无法读取此图片格式"));
            timer = setTimeout(() => reject(new Error("读取原图超时，请重试")), 30_000);
            image.src = url;
        });
        return await read(image);
    } finally {
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        image.src = "";
        URL.revokeObjectURL(url);
    }
}

function measureImageBlob(blob: Blob) {
    return withBrowserImage(blob, (image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
}

function convertImageToPng(blob: Blob) {
    return withBrowserImage(blob, async (image) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        try {
            const context = canvas.getContext("2d");
            if (!context) throw new Error("无法转换图片格式");
            context.drawImage(image, 0, 0);
            return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("图片格式转换失败")), "image/png"));
        } finally {
            canvas.width = 0;
            canvas.height = 0;
        }
    });
}
