export type ZipFile = { name: string; data: BlobPart };
export type ZipProgress = {
    phase: "preparing" | "packing" | "unpacking" | "complete";
    completed: number;
    total: number;
    label: string;
};
export type ZipOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress?: (progress: ZipProgress) => void;
};
export type ZipTask = { kind: "create"; files: ZipFile[] } | { kind: "read"; file: Blob };
export type ZipTaskResult = Blob | Map<string, Blob>;
export type ZipWorkerMessage =
    | { type: "progress"; progress: ZipProgress }
    | { type: "result"; result: ZipTaskResult }
    | { type: "error"; message: string; name?: string };

export async function createZip(files: ZipFile[], options: ZipOptions = {}): Promise<Blob> {
    return runZipTask({ kind: "create", files }, options) as Promise<Blob>;
}

export async function readZip(file: Blob, options: ZipOptions = {}): Promise<Map<string, Blob>> {
    return runZipTask({ kind: "read", file }, options) as Promise<Map<string, Blob>>;
}

function runZipTask(task: ZipTask, { signal, timeoutMs = 120_000, onProgress }: ZipOptions): Promise<ZipTaskResult> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        let settled = false;
        let worker: Worker | undefined;
        const localController = new AbortController();
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (worker) {
                worker.onmessage = null;
                worker.onerror = null;
                worker.onmessageerror = null;
                worker.terminate();
            }
            localController.abort();
        };
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const finish = (result: ZipTaskResult) => {
            if (settled) return;
            if (task.kind === "create" ? !(result instanceof Blob) : !(result instanceof Map)) {
                fail(new Error("压缩文件处理未返回有效结果，请重试"));
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        };
        const progress = (value: ZipProgress) => {
            if (settled) return;
            try { onProgress?.(value); }
            catch (error) { fail(error); }
        };
        const abort = () => fail(signal?.reason || new DOMException("压缩文件处理已取消", "AbortError"));
        const timer = setTimeout(() => fail(new DOMException("压缩文件处理超时，请重试或缩小备份范围", "TimeoutError")), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        try {
            if (typeof Worker === "undefined") {
                if (typeof window !== "undefined") throw new Error("当前浏览器不支持后台压缩，请使用支持 Web Worker 的浏览器");
                // CLI/SSR tests have no UI thread. fflate's asynchronous Node API is
                // an explicit non-browser path, never a silent browser fallback.
                void import("./zip-codec").then(({ executeZipTask }) => executeZipTask(task, progress, { asynchronous: true, signal: localController.signal })).then(finish, fail);
                return;
            }
            worker = new Worker(new URL("./zip.worker.ts", import.meta.url), { type: "module" });
            worker.onmessage = (event: MessageEvent<ZipWorkerMessage>) => {
                const data = event.data;
                if (data.type === "progress") progress(data.progress);
                else if (data.type === "result") finish(data.result);
                else if (data.type === "error") {
                    const error = new Error(data.message);
                    error.name = data.name || "Error";
                    fail(error);
                }
            };
            worker.onerror = () => fail(new Error("压缩文件处理进程失败，请重试"));
            worker.onmessageerror = () => fail(new Error("无法读取压缩文件处理结果，请重试"));
            // Blob structured cloning shares immutable source/output bytes. Do not
            // transfer caller-owned ArrayBuffers, which would detach original data.
            worker.postMessage(task);
        } catch (error) { fail(error); }
    });
}
