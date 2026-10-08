import { fetchReferenceImage, ReferenceRequestError, scanReferencePage, type ReferenceScan } from "@/services/api/reference-import";
import { decodeReference, MAX_IMAGES, MAX_TOTAL_BYTES } from "./protocol";

export function normalizePageUrl(value: string): string {
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error("请输入完整的公开网页链接，例如 https://example.com/gallery"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("仅支持不含账号密码的 HTTP / HTTPS 网页链接");
    url.hash = "";
    return url.href;
}

export function referenceReturnPath(search: string): string {
    const path = new URLSearchParams(search).get("returnTo") || "";
    if (!path.startsWith("/canvas/") || /[\\\u0000-\u001f]/.test(path)) return "/assets";
    const normalized = new URL(path, "https://canvas.invalid");
    return normalized.pathname.startsWith("/canvas/") ? `${normalized.pathname}${normalized.search}${normalized.hash}` : "/assets";
}

export async function collectReferencePage(options: {
    url: string; ownerId: string; signal: AbortSignal; getOwner: () => string | undefined;
    onScan: (scan: ReferenceScan) => void;
    onImage: (image: ReturnType<typeof decodeReference>) => void;
    onFailure: (name: string, reason: string) => void;
    onProgress: (completed: number, total: number) => void;
}) {
    const { ownerId, signal } = options;
    const check = () => {
        signal.throwIfAborted();
        if (options.getOwner() !== ownerId) throw new ReferenceRequestError("员工身份已变化，本批采集已停止", 403);
    };
    check();
    const scan = await scanReferencePage(normalizePageUrl(options.url), ownerId, signal);
    check();
    options.onScan(scan);
    let totalBytes = 0;
    const candidates = scan.candidates.slice(0, MAX_IMAGES);
    for (const [index, candidate] of candidates.entries()) {
        check();
        try {
            const raw = await fetchReferenceImage(scan.scanId, candidate.id, ownerId, signal);
            check();
            const image = decodeReference(raw);
            if (totalBytes + image.file.size > MAX_TOTAL_BYTES) throw new Error("本批图片总大小超过 30 MiB，请减少图片后重试");
            totalBytes += image.file.size;
            options.onImage(image);
        } catch (error) {
            check();
            if (error instanceof ReferenceRequestError && [401, 403].includes(error.status)) throw error;
            options.onFailure(candidate.name, error instanceof Error ? error.message : "图片读取失败");
        }
        options.onProgress(index + 1, candidates.length);
    }
}
