import type { PixelImage } from "./image-processing";
import type { ImageProcessingTask, ImageWorkerTask, RecolorResult, SelectionImageTask, SelectionUrlTask } from "./image-processing-task";

export function processImageInWorker(task: Extract<ImageProcessingTask, { kind: "recolor" }>, signal?: AbortSignal): Promise<RecolorResult>;
export function processImageInWorker(task: ImageProcessingTask, signal?: AbortSignal): Promise<PixelImage>;
export function processImageInWorker(task: SelectionImageTask | SelectionUrlTask, signal?: AbortSignal): Promise<Blob>;
export function processImageInWorker(task: ImageWorkerTask, signal?: AbortSignal): Promise<PixelImage | Blob> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("图片处理已取消", "AbortError")); return; }
        let worker: Worker | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { clearTimeout(timer); worker?.terminate(); signal?.removeEventListener("abort", abort); };
        const fail = (error: unknown) => { cleanup(); reject(error); };
        const abort = () => fail(new DOMException("图片处理已取消", "AbortError"));
        try {
            worker = new Worker(new URL("./image-processing.worker.ts", import.meta.url), { type: "module" });
            worker.onmessage = (event: MessageEvent<{ result?: PixelImage | Blob; error?: string; errorName?: string }>) => {
                cleanup();
                if (event.data.error || !event.data.result) {
                    const error = new Error(event.data.error || "图片处理没有返回结果");
                    if (event.data.errorName === "ImageDecodeFallback") error.name = event.data.errorName;
                    reject(error);
                }
                else resolve(event.data.result);
            };
            worker.onerror = () => fail(new Error("图片处理进程失败，请重试"));
            worker.onmessageerror = () => fail(new Error("无法读取图片处理结果，请重试"));
            signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => fail(new Error("图片处理超时，请重试或减小图片尺寸")), 60_000);
            // Structured cloning preserves the original buffers for pixel picking and subsequent saves.
            // Each preview owns its worker, so abort terminates obsolete CPU work instead of queueing it.
            const transfer = task.kind === "selection-guide-image" ? [task.source, task.selection]
                : task.kind === "composite-image" ? [task.source, task.generated, task.selection] : [];
            worker.postMessage(task, transfer);
        } catch (error) { fail(error); }
    });
}
