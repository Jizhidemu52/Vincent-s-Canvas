import type { ServerAsset } from "@/services/api/server-assets";

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assetMediaUrls(id: string) {
    if (!assetIdPattern.test(id)) return null;
    const root = `/api/assets/${id}`;
    return { content: `${root}/content`, thumbnail: `${root}/thumb?w=256`, preview: `${root}/thumb?w=1024` };
}

export function assetTitle(asset: Pick<ServerAsset, "metadata" | "filename">) {
    return typeof asset.metadata.title === "string" && asset.metadata.title.trim() ? asset.metadata.title : asset.filename;
}

/** Only our authenticated asset thumbnail route may load automatically. Remote media remains an explicit link. */
export function recordMediaLink(value: string, origin?: string) {
    if (!value || value !== value.trim() || /[\u0000-\u0020\\]/.test(value)) return null;
    let path = value, external: string | undefined;
    if (/^https?:\/\//i.test(value)) {
        let parsed: URL;
        try { parsed = new URL(value); } catch { return null; }
        if (parsed.username || parsed.password) return null;
        external = parsed.href;
        path = origin && parsed.origin === origin ? parsed.pathname + parsed.search + parsed.hash : "";
    }
    const match = /^\/api\/assets\/([0-9a-f-]{36})\/content(?:[?#].*)?$/i.exec(path);
    const media = match ? assetMediaUrls(match[1]) : null;
    return media ? { href: media.content, media } : external ? { href: external, media: null } : null;
}

export const resultStatusLabels: Record<string, string> = {
    unused: "未标记", candidate: "候选", project: "已入项目", editing: "编辑中", downloaded: "已下载", adopted: "已采用", delivered: "已交付", pending: "待定", rejected: "已驳回",
};
