import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import { canvasImageDownloadFileName, imageMimeFromFileName } from "@/lib/canvas/canvas-image-filename";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "无线画布") {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) return;
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    const data: CanvasExportFile = { app: "wireless-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export function downloadCanvasContent(content: string, fileName: string) {
    saveAs(content, fileName);
}

export async function downloadCanvasImage(node: CanvasNodeData) {
    let blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
    if (!blob) {
        const response = await fetch(node.metadata?.content || "");
        if (!response.ok) throw new Error("无法读取图片，请重新打开画布后再试");
        blob = await response.blob();
    }
    const fileName = canvasImageDownloadFileName(node);
    const result = await prepareCanvasImageDownload(blob, fileName);
    saveAs(result, fileName);
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

async function encodeImageBlob(blob: Blob, mimeType: string) {
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法转换图片格式");
        if (mimeType === "image/jpeg") { context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); }
        context.drawImage(image, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("图片格式转换失败")), mimeType, 0.95));
    } finally { URL.revokeObjectURL(url); }
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
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
