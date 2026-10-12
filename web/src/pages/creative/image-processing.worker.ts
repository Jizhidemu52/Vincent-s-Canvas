import { editorSizeError } from "@/lib/canvas/image-editor-document";
import { compositeSelectedPixels, requireMatchingAspect, type PixelImage } from "./image-processing";
import { executeImageProcessingTask, type ImageWorkerTask, type SelectionImageTask, type SelectionUrlTask } from "./image-processing-task";

function imageCanvas(image: ImageBitmap) {
    const error = editorSizeError(image);
    if (error) throw new Error(error);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法创建图片处理画布");
    context.drawImage(image, 0, 0);
    return { canvas, context };
}

function pixelsCanvas(image: PixelImage) {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法创建图片处理画布");
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    return canvas;
}

async function selectionImage(task: SelectionImageTask) {
    try {
        if (task.source.width !== task.selection.width || task.source.height !== task.selection.height) throw new Error("选区与当前原图不匹配，请重新涂选");
        const source = imageCanvas(task.source), mask = imageCanvas(task.selection);
        const selection = mask.context.getImageData(0, 0, mask.canvas.width, mask.canvas.height);
        if (task.kind === "selection-guide-image") {
            const tinted = executeImageProcessingTask({ kind: "selection-guide", image: selection });
            source.context.drawImage(pixelsCanvas(tinted), 0, 0);
            return await source.canvas.convertToBlob({ type: "image/png" });
        }
        const generatedError = editorSizeError(task.generated);
        if (generatedError) throw new Error(generatedError);
        requireMatchingAspect(task.source, task.generated);
        const aligned = new OffscreenCanvas(task.source.width, task.source.height);
        const context = aligned.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("当前浏览器无法创建图片处理画布");
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
        context.drawImage(task.generated, 0, 0, aligned.width, aligned.height);
        const result = compositeSelectedPixels(source.context.getImageData(0, 0, aligned.width, aligned.height), context.getImageData(0, 0, aligned.width, aligned.height), selection);
        return await pixelsCanvas(result).convertToBlob({ type: "image/png" });
    } finally {
        task.source.close(); task.selection.close();
        if (task.kind === "composite-image") task.generated.close();
    }
}

async function selectionUrl(task: SelectionUrlTask) {
    const urls = task.kind === "composite-url" ? [task.source, task.selection, task.generated] : [task.source, task.selection];
    const loaded = await Promise.allSettled(urls.map(async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error("无法读取图片，请检查文件或跨域权限");
        const blob = await response.blob();
        try { return await createImageBitmap(blob); }
        catch {
            // Some HTML image formats (notably SVG) cannot be decoded from a Blob
            // by createImageBitmap. Preserve the established HTML image decode path.
            const error = new Error("图片格式需要浏览器解码"); error.name = "ImageDecodeFallback"; throw error;
        }
    }));
    const failure = loaded.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
        for (const result of loaded) if (result.status === "fulfilled") result.value.close();
        throw failure.reason;
    }
    const [source, selection, generated] = loaded.map(result => (result as PromiseFulfilledResult<ImageBitmap>).value);
    return selectionImage(task.kind === "composite-url" ? { kind: "composite-image", source, selection, generated } : { kind: "selection-guide-image", source, selection });
}

self.onmessage = async (event: MessageEvent<ImageWorkerTask>) => {
    try {
        const task = event.data;
        if (task.kind === "selection-guide-url" || task.kind === "composite-url") {
            self.postMessage({ result: await selectionUrl(task) });
            return;
        }
        if (task.kind === "selection-guide-image" || task.kind === "composite-image") {
            self.postMessage({ result: await selectionImage(task) });
            return;
        }
        const result = executeImageProcessingTask(task);
        self.postMessage({ result }, { transfer: [result.data.buffer as ArrayBuffer] });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : "图片处理失败", errorName: error instanceof Error ? error.name : undefined });
    }
};
