import { readZip, type ZipOptions } from "@/lib/zip";
import { restoreCanvasExportMedia } from "@/lib/canvas/canvas-export-media";
import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";
import { setImageBlob } from "@/services/image-storage";
import { setMediaBlob } from "@/services/file-storage";
import { useCanvasStore, flushCanvasPersistence } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportFile } from "@/types/canvas-export";
import { decodeCanvasProject } from "@/lib/canvas/canvas-project-codec";

async function readCanvasBackup(file: Blob, options: ZipOptions) {
    try {
        const zip = await readZip(file, options);
        const manifest = zip.get("projects.json");
        if (!manifest) throw new Error("备份中缺少 projects.json");
        const data = JSON.parse(await manifest.text()) as CanvasExportFile;
        if (data?.app !== "wireless-canvas" || data.version !== 3 || !Array.isArray(data.projects) || !data.projects.length) throw new Error("画布备份格式不正确");
        for (const item of data.projects) {
            if (!item?.project || !Array.isArray(item.project.nodes) || !Array.isArray(item.project.connections) || !Array.isArray(item.files)) throw new Error("画布内容不完整");
            decodeCanvasProject(item.project);
            for (const asset of item.files) {
                if (typeof asset?.storageKey !== "string" || typeof asset.path !== "string" || typeof asset.mimeType !== "string" || !zip.has(asset.path)) throw new Error("画布备份缺少媒体文件或文件信息");
            }
        }
        return { zip, data };
    } catch (cause) {
        throw new Error("无法读取画布备份，请确认压缩包完整且由当前画布导出。", { cause });
    }
}

export async function importCanvasArchive(file: Blob, options: ZipOptions = {}): Promise<number> {
    // Validate every archive entry before writing any original image bytes.
    const { zip, data } = await readCanvasBackup(file, options);
    const urls = new Map<string, string>();
    const files = data.projects.flatMap(project => project.files);
    let completed = 0;
    options.onProgress?.({ phase: "preparing", completed, total: files.length, label: "正在保存原始媒体…" });
    const writes = await mapCanvasAsyncPool(files, 4, async (item): Promise<PromiseSettledResult<void>> => {
        try {
            const blob = zip.get(item.path)!;
            const typed = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            const url = await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typed) : setMediaBlob(item.storageKey, typed));
            urls.set(item.storageKey, url);
            options.onProgress?.({ phase: "preparing", completed: ++completed, total: files.length, label: "正在保存原始媒体…" });
            return { status: "fulfilled", value: undefined };
        } catch (reason) { return { status: "rejected", reason }; }
    });
    // Finish outstanding writes before callers unlock import/retry.
    const failed = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) {
        const quota = failed.reason instanceof Error && failed.reason.name === "QuotaExceededError";
        throw new Error(quota
            ? "浏览器存储空间不足，未完成导入。请释放空间后重试；原压缩包未修改。"
            : "画布媒体写入本机失败，请检查浏览器存储状态后重试；原压缩包未修改。", { cause: failed.reason });
    }
    let projects;
    try { projects = data.projects.map(item => decodeCanvasProject(restoreCanvasExportMedia(item.project, urls))); }
    catch (cause) { throw new Error("画布备份中的媒体引用不完整，无法导入。", { cause }); }
    try {
        options.onProgress?.({ phase: "preparing", completed: 0, total: data.projects.length, label: "正在持久保存画布…" });
        for (const project of projects) useCanvasStore.getState().importProject(project);
        await flushCanvasPersistence();
    } catch (cause) {
        throw new Error("画布写入本机失败，请保留当前页面并检查保存状态或导出备份。", { cause });
    }
    return projects.length;
}
