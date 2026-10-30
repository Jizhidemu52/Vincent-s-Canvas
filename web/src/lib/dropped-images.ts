export const INTERNAL_IMAGE_DRAG = "application/x-inchoice-reference-sort";
const MAX_REMOTE_BYTES = 20 * 1024 * 1024;
export const EXTERNAL_IMAGE_UNAVAILABLE = "没有读到可用的图片文件。请先在企业微信中打开原图，再拖入；也可以复制图片后粘贴，或保存到桌面再拖入。";
type DropData = Pick<DataTransfer, "files" | "items" | "types" | "getData">;
export type ImageDropSnapshot = { files: File[]; urls: string[]; expectedFiles: boolean };

/** During dragover browsers intentionally hide file bytes; inspect types only. */
export function isExternalImageDrag(data: DropData) {
    const types = Array.from(data.types || []);
    if (types.includes(INTERNAL_IMAGE_DRAG)) return false;
    return types.some(type => ["Files", "text/html", "text/uri-list", "DownloadURL"].includes(type))
        || Array.from(data.items || []).some(item => item.kind === "file");
}

/** Capture synchronously: DataTransfer becomes protected after the drop handler returns. */
export function snapshotImageDrop(data: DropData): ImageDropSnapshot {
    const files = Array.from(data.files || []);
    if (!files.length) for (const item of Array.from(data.items || [])) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
    }
    // Files and items/HTML are alternate views of the same drag, never duplicate them.
    if (files.length) return { files, urls: [], expectedFiles: true };
    const urls: string[] = [];
    const html = data.getData("text/html");
    if (html && html.length < MAX_REMOTE_BYTES * 1.4) {
        // Template content is inert: no attached images, scripts or network requests.
        const template = document.createElement("template");
        template.innerHTML = html;
        for (const image of template.content.querySelectorAll("img[src]")) {
            const source = image.getAttribute("src");
            if (source) urls.push(source);
        }
    }
    if (!urls.length) {
        const list = data.getData("text/uri-list");
        urls.push(...list.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith("#")));
    }
    if (!urls.length) {
        const download = data.getData("DownloadURL");
        const match = /^image\/[^:]+:[^:]*:(.+)$/s.exec(download);
        if (match) urls.push(match[1]!);
    }
    return { files, urls: [...new Set(urls)], expectedFiles: Array.from(data.types || []).includes("Files") };
}

export async function normalizeDroppedFile(file: File) {
    return (await import("./dropped-image-reader")).normalizeDroppedFile(file);
}
export async function readImageDrop(snapshot: ImageDropSnapshot, options: Parameters<typeof import("./dropped-image-reader").readImageDrop>[1] = {}) {
    return (await import("./dropped-image-reader")).readImageDrop(snapshot, options);
}
