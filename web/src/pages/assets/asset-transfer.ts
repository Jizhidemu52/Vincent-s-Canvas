import { uiText } from "@/lib/i18n";
import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { exportModelMetadata } from "@/lib/model-display";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "wireless-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], options?: { readRemote: (asset: Asset) => Promise<Blob>; checkOwner: () => void }) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    const exportedAssets: Asset[] = [];
    for (const asset of assets) {
            options?.checkOwner();
            if (asset.kind === "text") {
                const blob = options ? await options.readRemote(asset) : new Blob([asset.data.content], { type: "text/plain" });
                options?.checkOwner();
                if (!blob) throw new Error(uiText("素材原文件不可用，导出已停止"));
                const content = await blob.text();
                options?.checkOwner();
                const storageKey = `text:export-${asset.id}`, path = `files/${safeFileName(storageKey)}.txt`;
                files.push({ storageKey, path, mimeType: blob.type || "text/plain", bytes: blob.size });
                zipFiles.push({ name: path, data: blob });
                exportedAssets.push({ ...asset, data: { ...asset.data, content } });
                continue;
            }
            const storageKey = asset.data.storageKey || `${asset.kind}:export-${asset.id}`;
            const blob = asset.data.storageKey
                ? await (asset.kind === "image" ? getImageBlob(storageKey) : getMediaBlob(storageKey))
                : await options?.readRemote(asset);
            options?.checkOwner();
            if (!blob) throw new Error(uiText("素材原文件不可用，导出已停止"));
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
            exportedAssets.push({ ...asset, data: { ...asset.data, storageKey } } as Asset);
    }

    const data: AssetExportFile = { app: "wireless-canvas", version: 1, exportedAt: new Date().toISOString(), assets: exportedAssets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(exportModelMetadata(data), null, 2) }, ...zipFiles]);
    options?.checkOwner();
    saveAs(zip, uiText("我的素材.zip"));
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
        }),
    );
    return data.assets;
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}
