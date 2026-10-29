import { canvasDifferenceLayout, canvasDifferencePixels, compareContainRect } from "./canvas-image-pixels";
import type { CanvasImageTask, CanvasImageWorkerMessage } from "./canvas-image-worker";

const progress = (percent: number, label: string) => self.postMessage({ type: "progress", progress: { percent, label } } satisfies CanvasImageWorkerMessage);

async function execute(task: CanvasImageTask) {
    if (typeof OffscreenCanvas === "undefined") { const error = new Error("后台画布不可用"); error.name = "CanvasImageCapabilityError"; throw error; }
    if (task.kind === "difference") {
        progress(5, "正在后台解码对比原图");
        const decoded = await Promise.allSettled([task.before, task.after].map(source => source instanceof Blob ? createImageBitmap(source) : Promise.resolve(source)));
        const failure = decoded.find((item): item is PromiseRejectedResult => item.status === "rejected");
        if (failure) { decoded.forEach(item => { if (item.status === "fulfilled") item.value.close(); }); const error = new Error("此格式需要兼容解码"); error.name = "CanvasImageCapabilityError"; throw error; }
        const [beforeImage, afterImage] = decoded.map(item => (item as PromiseFulfilledResult<ImageBitmap>).value);
        try {
            const layout = canvasDifferenceLayout({ naturalWidth: beforeImage.width, naturalHeight: beforeImage.height }, { naturalWidth: afterImage.width, naturalHeight: afterImage.height });
            const canvas = new OffscreenCanvas(layout.width, layout.height);
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("无法创建后台差异画布");
            const read = (image: ImageBitmap) => {
                const rect = compareContainRect(image.width, image.height, layout.width, layout.height);
                context.clearRect(0, 0, layout.width, layout.height);
                context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
                return context.getImageData(0, 0, layout.width, layout.height);
            };
            progress(15, "正在后台读取改款前像素"); const before = read(beforeImage);
            progress(35, "正在后台读取改款后像素"); const after = read(afterImage);
            progress(55, "正在后台计算差异");
            before.data.set(canvasDifferencePixels(before.data, after.data));
            context.putImageData(before, 0, 0);
            progress(95, "正在显示差异图");
            return canvas.transferToImageBitmap();
        } finally { beforeImage.close(); afterImage.close(); }
    }
    progress(10, "正在后台解码原图");
    let bitmap: ImageBitmap;
    try { bitmap = task.source instanceof Blob ? await createImageBitmap(task.source) : task.source; }
    catch { const error = new Error("此格式需要兼容解码"); error.name = "CanvasImageCapabilityError"; throw error; }
    try {
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20_000_000) throw new Error("单张图片超过 2000 万像素或尺寸无效，请先缩小图片");
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建后台导出画布");
        if (task.mimeType === "image/jpeg") { context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); }
        context.drawImage(bitmap, 0, 0);
        progress(45, "正在后台编码图片，保留原像素尺寸");
        const blob = await canvas.convertToBlob({ type: task.mimeType, quality: 0.95 });
        if (blob.type !== task.mimeType) throw new Error("浏览器不支持所选导出格式");
        progress(100, "图片编码完成"); return blob;
    } finally { bitmap.close(); }
}

self.onmessage = async (event: MessageEvent<CanvasImageTask>) => {
    const task = event.data;
    try {
        const result = await execute(task);
        self.postMessage({ type: "result", result } satisfies CanvasImageWorkerMessage, { transfer: result instanceof Blob ? [] : [result] });
    } catch (error) {
        self.postMessage({ type: "error", message: error instanceof Error ? error.message : "图片处理失败", name: error instanceof Error ? error.name : "Error" } satisfies CanvasImageWorkerMessage);
    } finally {
        if (task.kind === "difference") { if (!(task.before instanceof Blob)) task.before.close(); if (!(task.after instanceof Blob)) task.after.close(); }
        else if (!(task.source instanceof Blob)) task.source.close();
    }
};
