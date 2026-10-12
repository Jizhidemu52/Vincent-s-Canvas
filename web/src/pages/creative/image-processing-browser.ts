import { editorSizeError } from "@/lib/canvas/image-editor-document";
import type { PixelImage } from "./image-processing";
import { processImageInWorker } from "./image-processing-client";

async function processingImage(url: string): Promise<HTMLImageElement> {
    if (!url) throw new Error("图片不可用，请重新上传");
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const value = new Image(); value.crossOrigin = "anonymous";
        value.onload = () => resolve(value); value.onerror = () => reject(new Error("无法读取图片，请检查文件或跨域权限")); value.src = url;
    });
}

export async function loadProcessingImage(url: string, maxSide?: number): Promise<HTMLCanvasElement> {
    const image = await processingImage(url);
    const ratio = maxSide ? Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight)) : 1;
    const width = Math.max(1, Math.round(image.naturalWidth * ratio)), height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const sizeError = editorSizeError({ width, height });
    if (sizeError) throw new Error(sizeError);
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法创建图片画布");
    context.drawImage(image, 0, 0, width, height);
    return canvas;
}

export function canvasPixels(canvas: HTMLCanvasElement): PixelImage {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法读取图片画布");
    return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function pixelsCanvas(image: PixelImage) {
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片画布");
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    return canvas;
}

export async function createSelectionGuide(sourceUrl: string, maskUrl: string) {
    try { return await processImageInWorker({ kind: "selection-guide-url", source: absoluteProcessingUrl(sourceUrl), selection: absoluteProcessingUrl(maskUrl) }); }
    catch (error) { if (!(error instanceof Error) || error.name !== "ImageDecodeFallback") throw error; }
    const [source, selection] = await processingBitmaps([sourceUrl, maskUrl]);
    try { return await processImageInWorker({ kind: "selection-guide-image", source, selection }); }
    finally { source.close(); selection.close(); }
}

export async function compositeSelectedImage(sourceUrl: string, generatedUrl: string, maskUrl: string) {
    try { return await processImageInWorker({ kind: "composite-url", source: absoluteProcessingUrl(sourceUrl), generated: absoluteProcessingUrl(generatedUrl), selection: absoluteProcessingUrl(maskUrl) }); }
    catch (error) { if (!(error instanceof Error) || error.name !== "ImageDecodeFallback") throw error; }
    const [source, generated, selection] = await processingBitmaps([sourceUrl, generatedUrl, maskUrl]);
    try { return await processImageInWorker({ kind: "composite-image", source, generated, selection }); }
    finally { source.close(); generated.close(); selection.close(); }
}

function absoluteProcessingUrl(url: string) {
    if (!url) throw new Error("图片不可用，请重新上传");
    return new URL(url, document.baseURI).href;
}

async function processingBitmaps(urls: string[]): Promise<ImageBitmap[]> {
    // Decode through the same HTML image path (including SVG/CORS/EXIF handling),
    // then transfer ownership; full-size canvas reads and PNG encoding stay off the UI thread.
    const loaded = await Promise.allSettled(urls.map(async url => {
        const image = await processingImage(url);
        const error = editorSizeError({ width: image.naturalWidth, height: image.naturalHeight });
        if (error) throw new Error(error);
        // HTML images can render viewBox-only SVGs using their resolved size;
        // ImageBitmap needs that size explicitly when intrinsic dimensions are absent.
        return createImageBitmap(image, { resizeWidth: image.naturalWidth, resizeHeight: image.naturalHeight });
    }));
    const failure = loaded.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
        for (const result of loaded) if (result.status === "fulfilled") result.value.close();
        throw failure.reason;
    }
    return loaded.map(result => (result as PromiseFulfilledResult<ImageBitmap>).value);
}
