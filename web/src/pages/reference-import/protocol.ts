export const REFERENCE_CHANNEL = "canvas-reference-import/v1";
export const MAX_IMAGES = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export type ReferencePayload = { id: string; name: string; mime: string; base64: string; sourcePage: string; sourceImage: string; pageTitle: string };

export function cleanSourceUrl(value: unknown): string {
    if (typeof value !== "string" || value.length > 16384) return "";
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return "";
        url.username = ""; url.password = ""; url.search = ""; url.hash = "";
        return url.href.slice(0, 2048);
    } catch { return ""; }
}

export function isReferenceEnvelope(value: unknown, nonce: string): value is { channel: string; nonce: string; requestId: string; type: "hello" | "image"; image?: unknown } {
    if (!nonce || !value || typeof value !== "object") return false;
    const data = value as Record<string, unknown>;
    return data.channel === REFERENCE_CHANNEL && data.nonce === nonce && typeof data.requestId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(data.requestId) && (data.type === "hello" || data.type === "image");
}

export function imageMime(bytes: Uint8Array): string {
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    if (bytes.length >= 8 && bytes[0] === 137 && ascii(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
    if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    throw new Error("仅支持有效的 PNG / JPEG / WebP / GIF 图片");
}

export function decodeReference(value: unknown): { payload: ReferencePayload; file: File } {
    if (!value || typeof value !== "object") throw new Error("图片消息格式错误");
    const data = value as Record<string, unknown>;
    if (typeof data.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(data.id)) throw new Error("图片标识无效");
    if (typeof data.base64 !== "string" || !data.base64.length || data.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.base64)) throw new Error("图片编码无效或超过 10 MiB");
    const binary = atob(data.base64);
    if (binary.length > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 10 MiB");
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const mime = imageMime(bytes);
    if (data.mime !== mime) throw new Error("图片类型与原始字节不一致");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime];
    const name = (typeof data.name === "string" ? data.name : "reference").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 150).replace(/\.[^.]+$/, "") || "reference";
    const payload = { id: data.id, base64: data.base64, mime, name: `${name}.${extension}`, sourcePage: cleanSourceUrl(data.sourcePage), sourceImage: cleanSourceUrl(data.sourceImage), pageTitle: typeof data.pageTitle === "string" ? data.pageTitle.slice(0, 300) : "" };
    return { payload, file: new File([bytes], payload.name, { type: mime }) };
}
