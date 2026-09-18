export const CHANNEL = "canvas-reference-import/v1";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export function canvasOrigin(input) {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("请填写不带路径、查询参数和凭据的画布网站地址");
    const host = url.hostname;
    const octets = host.split(".").map(Number);
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && octets.every(value => value >= 0 && value <= 255);
    const local = host === "localhost" || host === "[::1]" || (ipv4 && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)));
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("非本机/私有 IPv4 内网地址必须使用 HTTPS");
    return url.origin;
}
export function cleanUrl(input) {
    try { const url = new URL(input); if (!["https:", "http:"].includes(url.protocol)) return ""; url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href.slice(0, 2048); } catch { return ""; }
}
export function sniffMime(bytes) {
    const text = (a, b) => String.fromCharCode(...bytes.slice(a, b));
    if (bytes.length >= 8 && bytes[0] === 137 && text(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (["GIF87a", "GIF89a"].includes(text(0, 6))) return "image/gif";
    if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
    throw new Error("不是支持的 PNG / JPEG / WebP / GIF 原图");
}
export async function readImage(response, signal, remainingBytes = MAX_IMAGE_BYTES) {
    if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
    const limit = Math.min(MAX_IMAGE_BYTES, remainingBytes);
    if (Number(response.headers.get("content-length")) > limit) throw new Error("图片超过单张或本批剩余大小限制");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("图片响应没有可读取内容");
    const chunks = []; let size = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > limit) throw new Error("图片超过单张 10 MiB 或本批总量 30 MiB");
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, mime: sniffMime(bytes) };
}

// Runs inside the target tab's isolated world. Never reads cookies or calls APIs.
export async function deliverToReview(origin, nonce, type, image, requestId) {
    if (location.origin !== origin || location.pathname !== "/reference-import") throw new Error("画布审核标签页已跳转，请重新发送");
    return new Promise(resolve => {
        const finish = result => { clearTimeout(timer); window.removeEventListener("message", receive); resolve(result); };
        const receive = event => {
            const data = event.data;
            if (event.source === window && event.origin === origin && data?.channel === "canvas-reference-import/v1" && data.nonce === nonce && data.type === "ack" && data.requestId === requestId) finish({ ok: data.ok === true, error: typeof data.error === "string" ? data.error.slice(0, 300) : "" });
        };
        const timer = setTimeout(() => finish({ ok: false, error: "审核页未响应，请先在画布网站登录，再回到扩展重新发送" }), 2000);
        window.addEventListener("message", receive);
        window.postMessage({ channel: "canvas-reference-import/v1", nonce, type, image, requestId }, origin);
    });
}
