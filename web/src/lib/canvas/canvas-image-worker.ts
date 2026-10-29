export type CanvasImageProgress = { percent: number; label: string; fallback?: boolean };
export type CanvasImageTaskOptions = { signal?: AbortSignal; onProgress?: (progress: CanvasImageProgress) => void; timeoutMs?: number };
export type CanvasImageTask =
    | { kind: "difference"; before: Blob | ImageBitmap; after: Blob | ImageBitmap }
    | { kind: "encode"; source: Blob | ImageBitmap; mimeType: string };
export type CanvasImageWorkerMessage =
    | { type: "progress"; progress: CanvasImageProgress }
    | { type: "result"; result: Blob | ImageBitmap }
    | { type: "error"; message: string; name: string };
export const CANVAS_IMAGE_FALLBACK_MAX_PIXELS = 1_000_000;

export function checkCanvasImageAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }
export function imageWorkerSupported() { return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function"; }
export function requireCanvasImageFallback(width: number, height: number, options: CanvasImageTaskOptions) {
    checkCanvasImageAbort(options.signal);
    if (width * height > CANVAS_IMAGE_FALLBACK_MAX_PIXELS) throw new Error("当前浏览器无法后台处理此图片，兼容模式仅支持 100 万像素以内。请使用支持 Web Worker 与 OffscreenCanvas 的浏览器；未缩小或修改原图。");
    options.onProgress?.({ percent: 5, label: "后台处理不可用，正在以分段兼容模式处理（最多 100 万像素）", fallback: true });
}
export async function yieldCanvasImageTask(signal?: AbortSignal) {
    checkCanvasImageAbort(signal);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    checkCanvasImageAbort(signal);
}
function closeResult(result: Blob | ImageBitmap) { if (!(result instanceof Blob)) result.close(); }

/** One task owns one Worker: cancellation/timeout terminates computation, not just its UI. */
export function runCanvasImageTask(task: CanvasImageTask, { signal, onProgress, timeoutMs = 60_000 }: CanvasImageTaskOptions = {}): Promise<Blob | ImageBitmap> {
    const transfers = (task.kind === "difference" ? [task.before, task.after] : [task.source]).filter((source): source is ImageBitmap => !(source instanceof Blob));
    return new Promise((resolve, reject) => {
        let worker: Worker | undefined, settled = false, sent = false;
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
            if (!sent) transfers.forEach(bitmap => bitmap.close());
        };
        const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
        const abort = () => fail(signal?.reason || new DOMException("图片处理已取消", "AbortError"));
        const timer = setTimeout(() => fail(new DOMException("图片处理超时，请重试或减小图片", "TimeoutError")), timeoutMs);
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        try {
            worker = new Worker(new URL("./canvas-image.worker.ts", import.meta.url), { type: "module" });
            worker.onmessage = (event: MessageEvent<CanvasImageWorkerMessage>) => {
                const data = event.data;
                if (settled) { if (data.type === "result") closeResult(data.result); return; }
                if (data.type === "progress") { try { onProgress?.(data.progress); } catch (error) { fail(error); } }
                else if (data.type === "error") { const error = new Error(data.message); error.name = data.name; fail(error); }
                else if (data.type === "result") {
                    if (task.kind === "encode" ? !(data.result instanceof Blob) : typeof ImageBitmap === "undefined" || !(data.result instanceof ImageBitmap)) { fail(new Error("后台图片处理返回无效结果")); return; }
                    settled = true; cleanup(); resolve(data.result);
                }
            };
            worker.onerror = () => fail(new Error("后台图片处理失败，请重试"));
            worker.onmessageerror = () => fail(new Error("无法读取后台图片处理结果"));
            // Only fresh bitmaps are transferred. Immutable source Blobs are never detached or altered.
            worker.postMessage(task, transfers);
            sent = true;
        } catch (error) { fail(error); }
    });
}
