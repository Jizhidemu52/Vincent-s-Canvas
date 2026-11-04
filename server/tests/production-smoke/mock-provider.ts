import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const SMOKE_PROVIDER_KEY = "canvas-smoke-local-only-no-paid-key";
export const SMOKE_CHAT_REPLY = "Release smoke chat completed through the local provider.";
export const SMOKE_PROJECT_PATTERN = /^(?:ci-release|canvas-staging)-[a-z0-9][a-z0-9-]{0,80}$/;

export function createSmokeMedia() {
    const width = 1024, height = 1024;
    const pixels = Buffer.alloc(width * height * 3);
    let random = 0x6d2b79f5;
    for (let index = 0; index < pixels.length; index++) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        pixels[index] = random & 255;
    }
    const encode = (arguments_: string[], input?: Uint8Array) => {
        const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...arguments_], {
            input, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true,
        });
        if (result.error || result.status !== 0) throw new Error(`Smoke media encoding failed: ${result.error?.message || String(result.stderr)}`);
        return result.stdout;
    };
    const image = encode(["-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], pixels);
    const video = encode(["-f", "lavfi", "-i", "color=c=blue:s=320x240:r=12:d=1", "-an", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
    if (image.byteLength <= 1024 * 1024 || video.byteLength < 1000) throw new Error("Smoke fixtures did not meet real-media requirements");
    return { image, video, imageSha256: createHash("sha256").update(image).digest("hex"), width, height };
}

/** Test-only HTTP upstream. It never proxies or fetches a URL supplied by clients. */
export function createSmokeProvider(project: string, origin: string, media = createSmokeMedia(), imageDelayMs = 0) {
    if (!SMOKE_PROJECT_PATTERN.test(project)) throw new Error("Mock provider is restricted to isolated release/staging projects");
    const endpoint = new URL(origin);
    if (endpoint.protocol !== "http:" || !["mock-provider", "127.0.0.1", "localhost"].includes(endpoint.hostname)) throw new Error("Mock provider origin must be local");
    const calls: Array<{ sequence: number; method: string; path: string; model: string | null; kind: string }> = [];
    const videos = new Set<string>();
    return async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/health") return Response.json({ kind: "canvas-local-smoke-provider", project, paid: false });
        if (request.method === "GET" && path === "/__smoke/receipt") return Response.json({ schema: 1, project, paid: false, calls, image: { bytes: media.image.byteLength, sha256: media.imageSha256, width: media.width, height: media.height }, videoBytes: media.video.byteLength });
        if (request.method === "GET" && ["/fixtures/upload.png", "/fixtures/result.png"].includes(path)) return new Response(Uint8Array.from(media.image).buffer, { headers: { "content-type": "image/png" } });
        if (request.method === "GET" && path === "/fixtures/result.mp4") return new Response(Uint8Array.from(media.video).buffer, { headers: { "content-type": "video/mp4" } });
        if (request.headers.get("authorization") !== `Bearer ${SMOKE_PROVIDER_KEY}`) return Response.json({ error: "Only the synthetic smoke key is accepted" }, { status: 403 });
        if (request.method === "POST" && ["/v1/images/generations", "/v1/chat/completions", "/v1/responses", "/v1/videos/generations"].includes(path)) {
            const body = await request.json() as { model?: string };
            const kind = path.includes("/images/") ? "image" : path.includes("/videos/") ? "video" : "chat";
            const expected = { image: "gpt-image-2", video: "MiniMax-H3", chat: "gpt-6-astra" }[kind];
            if (body.model !== expected) return Response.json({ error: "Unexpected smoke model" }, { status: 400 });
            calls.push({ sequence: calls.length + 1, method: request.method, path, model: body.model, kind });
            if (kind === "image") {
                // The formal browser smoke reloads an in-flight task, not only
                // an already-completed canvas. Unit tests keep the default zero.
                if (imageDelayMs) await new Promise(resolve => setTimeout(resolve, imageDelayMs));
                return Response.json({ data: [{ b64_json: media.image.toString("base64") }] });
            }
            if (kind === "chat") return path === "/v1/responses"
                ? Response.json({ id: "smoke-chat-response", status: "completed", output: [{ type: "message", id: "smoke-chat-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: SMOKE_CHAT_REPLY, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } })
                : Response.json({ id: "smoke-chat-response", choices: [{ index: 0, message: { role: "assistant", content: SMOKE_CHAT_REPLY }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
            const taskId = `smoke-video-${videos.size + 1}`;
            videos.add(taskId);
            return Response.json({ data: [{ task_id: taskId }] });
        }
        if (request.method === "GET" && path.startsWith("/v1/tasks/") && videos.has(path.split("/").at(-1)!)) {
            calls.push({ sequence: calls.length + 1, method: "GET", path, model: null, kind: "video-poll" });
            return Response.json({ data: { status: "completed", result: { videos: [{ url: [`${endpoint.origin}/fixtures/result.mp4`] }] } } });
        }
        return Response.json({ error: "No mock route; external forwarding is prohibited" }, { status: 404 });
    };
}

if (import.meta.main) {
    const port = Number(process.env.PORT || "4180");
    const project = process.env.CANVAS_SMOKE_PROJECT || "";
    const handler = createSmokeProvider(project, `http://mock-provider:${port}`, createSmokeMedia(), 10_000);
    Bun.serve({ hostname: process.env.HOST || "0.0.0.0", port, fetch: handler });
    console.log(JSON.stringify({ kind: "canvas-local-smoke-provider", project, port, paid: false }));
}
