import { executeZipTask } from "./zip-codec";
import type { ZipTask, ZipWorkerMessage } from "./zip";

self.onmessage = async (event: MessageEvent<ZipTask>) => {
    const post = (message: ZipWorkerMessage) => self.postMessage(message);
    try {
        const result = await executeZipTask(event.data, progress => post({ type: "progress", progress }));
        post({ type: "result", result });
    } catch (error) {
        post({ type: "error", message: error instanceof Error ? error.message : "压缩文件处理失败", name: error instanceof Error ? error.name : undefined });
    }
};
