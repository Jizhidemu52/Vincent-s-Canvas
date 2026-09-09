import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasAgentSnapshot } from "./canvas-agent-ops";

/** Read layout only on submission; moving the canvas must not re-render chat history. */
export function captureCanvasContextSnapshot(snapshot: CanvasAgentSnapshot): CanvasAgentSnapshot {
    if (typeof document === "undefined") return snapshot;
    const surface = document.querySelector("[data-canvas-viewport]");
    const rect = surface?.getBoundingClientRect();
    if (!surface || !rect) return snapshot;
    const overlays = surface.closest(".cw-workspace")?.querySelectorAll(".cw-agent-panel, .cw-create-panel, .cw-generator-mobile, .cw-project-card, .cw-account-card, .cw-dock") || [];
    return { ...snapshot, viewportSize: { width: rect.width, height: rect.height }, viewportOcclusions: Array.from(overlays).map((element) => {
        const overlay = element.getBoundingClientRect();
        return { x: overlay.left - rect.left, y: overlay.top - rect.top, width: overlay.width, height: overlay.height };
    }).filter((overlay) => overlay.width > 0 && overlay.height > 0) };
}

function waitForMedia(target: HTMLImageElement | HTMLVideoElement, event: string, start: () => void) {
    return new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error("画布媒体不可读取")); };
        const timeout = setTimeout(fail, 6000);
        const cleanup = () => { clearTimeout(timeout); target.removeEventListener(event, done); target.removeEventListener("error", fail); };
        target.addEventListener(event, done, { once: true });
        target.addEventListener("error", fail, { once: true });
        try { start(); } catch { fail(); }
    });
}

function capture(source: CanvasImageSource, width: number, height: number) {
    if (!width || !height) throw new Error("媒体没有有效尺寸");
    const scale = Math.min(1, 1280 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法读取画面");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
}

export async function readCanvasContextImage(node: CanvasNodeData) {
    const url = await resolveImageUrl(node.metadata?.storageKey, node.metadata?.content || "");
    if (!url) throw new Error("图片不存在");
    const image = new Image();
    image.crossOrigin = "anonymous";
    try {
        await waitForMedia(image, "load", () => { image.src = url; });
        return capture(image, image.naturalWidth, image.naturalHeight);
    } finally { image.removeAttribute("src"); }
}

export async function readCanvasContextVideo(node: CanvasNodeData) {
    const url = await resolveMediaUrl(node.metadata?.storageKey, node.metadata?.content || "");
    if (!url) throw new Error("视频不存在");
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    try {
        await waitForMedia(video, "loadeddata", () => { video.src = url; video.load(); });
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const times = duration > 0.2 ? [0, duration / 2, Math.max(0, duration - 0.1)] : [0];
        const frames = [];
        for (const seconds of times) {
            if (Math.abs(video.currentTime - seconds) > 0.01) await waitForMedia(video, "seeked", () => { video.currentTime = seconds; });
            frames.push({ seconds, dataUrl: capture(video, video.videoWidth, video.videoHeight) });
        }
        return frames;
    } finally { video.pause(); video.removeAttribute("src"); video.load(); }
}
