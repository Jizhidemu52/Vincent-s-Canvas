import { saveAs } from "file-saver";

import { createZip, type ZipOptions } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { readMediaSource, serverMediaId } from "@/services/canvas-media-links";
import { fetchServerAssetContent, fetchServerAssetVariants, type ServerAssetVariant, type ServerAssetVariants } from "@/services/api/server-assets";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import { canvasImageDownloadFileName, canvasImageExportStem, imageMimeFromFileName } from "@/lib/canvas/canvas-image-filename";
import { encodeImageBlob, prepareCanvasImageFormat, type CanvasImageDownloadFormat } from "@/lib/canvas/canvas-image-encoding";
import { collectCanvasExportMedia } from "@/lib/canvas/canvas-export-media";
import { exportModelMetadata } from "@/lib/model-display";
import { encodeCanvasProject } from "./canvas-project-codec";
import { mapCanvasAsyncPool } from "./canvas-async-pool";
import { checkCanvasImageAbort, type CanvasImageTaskOptions } from "./canvas-image-worker";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "无线画布", options: ZipOptions = {}) {
    saveAs(await createCanvasProjectsArchive(projects, {}, options), `${safeFileName(fileName)}.zip`);
}

export async function createCanvasProjectsArchive(projects: CanvasProject[], sources: {
    getImageBlob?: typeof getImageBlob;
    getMediaBlob?: typeof getMediaBlob;
    fetchBlob?: (path: string) => Promise<Blob>;
    origin?: string;
} = {}, options: ZipOptions = {}) {
    options.onProgress?.({ phase: "preparing", completed: 0, total: projects.length, label: "正在收集画布与原始媒体…" });
    const prepared = await collectCanvasExportMedia(projects.map(encodeCanvasProject), sources);
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await mapCanvasAsyncPool(prepared.document, 4, async (project) => {
            const files: CanvasExportAsset[] = [];
            await mapCanvasAsyncPool(collectStorageKeys(project), 4, async (storageKey) => {
                    const blob = prepared.blobs.get(storageKey) || (storageKey.startsWith("image:") ? await (sources.getImageBlob || getImageBlob)(storageKey) : await (sources.getMediaBlob || getMediaBlob)(storageKey));
                    if (!blob) throw new Error("画布原始媒体缺失，未生成不完整的备份");
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                });
            return { project, files };
        });

    const data: CanvasExportFile = { app: "wireless-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    return createZip([{ name: "projects.json", data: JSON.stringify(exportModelMetadata(data)) }, ...zipFiles], options);
}

export function downloadCanvasContent(content: string, fileName: string) {
    saveAs(content, fileName);
}

export async function downloadCanvasImage(node: CanvasNodeData, format: CanvasImageDownloadFormat = "original", options: CanvasImageTaskOptions = {}) {
    checkCanvasImageAbort(options.signal);
    options.onProgress?.({ percent: 0, label: "正在读取原图" });
    let blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
    if (!blob) {
        const response = await fetch(node.metadata?.content || "", { signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]) });
        if (!response.ok) throw new Error("无法读取图片，请重新打开画布后再试");
        blob = await response.blob();
    }
    const result = await prepareCanvasImageFormat(blob, format, undefined, options);
    const fileName = format === "original"
        ? canvasImageDownloadFileName({ ...node, metadata: { ...node.metadata, mimeType: result.mimeType } })
        : `${canvasImageExportStem(node)}.${format}`;
    checkCanvasImageAbort(options.signal);
    saveAs(result.blob, fileName);
}

/** Resolve only the current media, never a task ID left over after a local edit. */
export async function loadCanvasImageVariants(node: CanvasNodeData, sources: {
    readMediaSource?: typeof readMediaSource;
    fetchVariants?: typeof fetchServerAssetVariants;
} = {}) {
    const source = node.metadata?.storageKey
        ? await (sources.readMediaSource || readMediaSource)(node.metadata.storageKey)
        : node.metadata?.content;
    const assetId = serverMediaId(source || "");
    return assetId ? (sources.fetchVariants || fetchServerAssetVariants)(assetId) : null;
}

export function hasCanvasImageVariants(variants: ServerAssetVariants) {
    return variants.original.assetId !== variants.primary.assetId || Boolean(variants.export && variants.export.assetId !== variants.primary.assetId);
}

/** Server variants already have the intended encoding. Preserve their exact bytes. */
export async function downloadCanvasImageVariant(node: CanvasNodeData, variant: ServerAssetVariant, kind: "primary" | "original" | "export", sources: {
    fetchBlob?: typeof fetchServerAssetContent;
    save?: (blob: Blob, filename: string) => void;
} = {}, options: CanvasImageTaskOptions = {}) {
    checkCanvasImageAbort(options.signal);
    options.onProgress?.({ percent: 0, label: "正在读取已保存的图片原件" });
    const blob = await (sources.fetchBlob || fetchServerAssetContent)(variant.assetId, AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]));
    checkCanvasImageAbort(options.signal);
    if (!blob.size) throw new Error("图片内容为空，无法下载");
    const mimeType = blob.type.split(";")[0]?.trim() || variant.mimeType;
    if (!mimeType.startsWith("image/")) throw new Error("下载的内容不是图片，未保存文件");
    const fileName = canvasImageDownloadFileName({ ...node, metadata: { ...node.metadata, mimeType } });
    const suffix = kind === "original" ? "_渠道原件" : kind === "export" ? "_格式副本" : "";
    (sources.save || saveAs)(blob, fileName.replace(/(\.[^.]+)$/, `${suffix}$1`));
}

export async function prepareCanvasImageDownload(blob: Blob, fileName: string, encode = encodeImageBlob) {
    if (!blob.size) throw new Error("图片内容为空，无法下载");
    const targetType = imageMimeFromFileName(fileName);
    if (!targetType || blob.type === targetType) return blob;
    // A generated PNG inherited from a JPG must be encoded as JPG, not just relabelled.
    if (!["image/png", "image/jpeg", "image/webp"].includes(targetType)) throw new Error(`当前图片格式与原文件名不一致，浏览器无法导出 ${targetType}；未修改原文件名。`);
    const result = await encode(blob, targetType);
    if (result.type !== targetType) throw new Error("浏览器不支持所需图片格式，未修改原文件名");
    return result;
}

function collectStorageKeys(value: unknown, keys = new Set<string>(), field = "") {
    if (typeof value === "string" && value.startsWith("canvas-archive:")) keys.add(value.slice("canvas-archive:".length));
    if (typeof value === "string" && ["references", "referenceUrls", "sourceUrls", "resultUrls"].includes(field) && /^(image|video|audio|file|media):/.test(value)) keys.add(value);
    if (!value || typeof value !== "object") return [...keys];
    if (Array.isArray(value)) { value.forEach(item => collectStorageKeys(item, keys, field)); return [...keys]; }
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.entries(value).forEach(([name, item]) => collectStorageKeys(item, keys, name));
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
