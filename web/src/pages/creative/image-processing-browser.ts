import { editorPngBlob, editorSizeError } from "@/lib/canvas/image-editor-document";
import { compositeSelectedPixels, requireMatchingAspect, selectionHasPixels, type PixelImage } from "./image-processing";

export async function loadProcessingImage(url: string, maxSide?: number): Promise<HTMLCanvasElement> {
    if (!url) throw new Error("图片不可用，请重新上传");
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const value = new Image(); value.crossOrigin = "anonymous";
        value.onload = () => resolve(value); value.onerror = () => reject(new Error("无法读取图片，请检查文件或跨域权限")); value.src = url;
    });
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
    const [source, mask] = await Promise.all([loadProcessingImage(sourceUrl), loadProcessingImage(maskUrl)]);
    if (source.width !== mask.width || source.height !== mask.height) throw new Error("选区与当前原图不匹配，请重新涂选");
    const pixels = canvasPixels(mask);
    if (!selectionHasPixels(pixels)) throw new Error("选区为空，请先涂选修改区域");
    for (let offset = 0; offset < pixels.data.length; offset += 4) pixels.data.set([42, 119, 246, Math.round(pixels.data[offset + 3]! * .55)], offset);
    source.getContext("2d")!.drawImage(pixelsCanvas(pixels), 0, 0);
    return editorPngBlob(source);
}

export async function compositeSelectedImage(sourceUrl: string, generatedUrl: string, maskUrl: string) {
    const [original, generated, selection] = await Promise.all([loadProcessingImage(sourceUrl), loadProcessingImage(generatedUrl), loadProcessingImage(maskUrl)]);
    requireMatchingAspect(original, generated);
    const aligned = document.createElement("canvas"); aligned.width = original.width; aligned.height = original.height;
    const context = aligned.getContext("2d");
    if (!context) throw new Error("无法创建合成画布");
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
    context.drawImage(generated, 0, 0, aligned.width, aligned.height);
    return editorPngBlob(pixelsCanvas(compositeSelectedPixels(canvasPixels(original), canvasPixels(aligned), canvasPixels(selection))));
}
