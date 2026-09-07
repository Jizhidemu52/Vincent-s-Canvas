import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

/** Probe local input before persisting/uploading it; do not invent dimensions on decode errors. */
export async function readReferenceMediaFile(file: File): Promise<ReferenceVideo | ReferenceAudio> {
    const kind = file.type.startsWith("video/") ? "video" : "audio";
    const url = URL.createObjectURL(file);
    try {
        const metadata = await new Promise<{ width?: number; height?: number; durationMs: number }>((resolve, reject) => {
            const media = document.createElement(kind);
            let finished = false;
            const finish = (error?: Error) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                const durationMs = media.duration * 1000;
                const dimensions = media instanceof HTMLVideoElement ? { width: media.videoWidth, height: media.videoHeight } : {};
                media.onloadedmetadata = null;
                media.onerror = null;
                media.removeAttribute("src");
                media.load();
                if (error || !Number.isFinite(durationMs) || durationMs <= 0) reject(error || new Error(`${file.name} 无法读取有效时长`));
                else resolve({ ...dimensions, durationMs });
            };
            const timer = window.setTimeout(() => finish(new Error(`${file.name} 读取超时，请确认格式为 MP4/MOV 或 WAV/MP3`)), 15000);
            media.preload = "metadata";
            media.onloadedmetadata = () => finish();
            media.onerror = () => finish(new Error(`${file.name} 无法解码，请使用 MP4/MOV 或 WAV/MP3`));
            media.src = url;
        });
        return { id: crypto.randomUUID(), name: file.name, type: file.type, url: "", bytes: file.size, ...metadata };
    } finally {
        URL.revokeObjectURL(url);
    }
}
