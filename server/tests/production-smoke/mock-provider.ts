import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const SMOKE_PROVIDER_KEY = "canvas-smoke-local-only-no-paid-key";
export const SMOKE_CHAT_REPLY = "Release smoke chat completed through the local provider.";
export const SMOKE_PROJECT_PATTERN = /^(?:ci-release|canvas-staging)-[a-z0-9][a-z0-9-]{0,80}$/;
export const SMOKE_VIDEO_SHA256 = "cd1b73171944a213925b013cc1a6ee0ef1533ff02cb7c82640733e866c0d85ad";
export const SMOKE_VIDEO_META = { width: 160, height: 224, frames: 24, durationMs: 1000 };
// Fixed synthetic blue-only HEVC Main10/hvc1/yuv420p10le fixture, encoded once
// locally. Production needs HEVC decoding + H264 encoding, not a HEVC encoder.
// Embedded here because both CI and staging copy this existing module exactly.
const smokeHevcMain10 = [
    "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAADcdtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAA",
    "AAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAM8XRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAA",
    "AAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAoAAAAOAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAA",
    "A+gAAAQAAAEAAAAADGltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAADAAAAAwAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFu",
    "ZGxlcgAAAAwUbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAL1HN0YmwAAAogc3RzZAAAAAAA",
    "AAABAAAKEGh2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAoADgAEgAAABIAAAAAAAAAAEVTGF2YzYyLjI4LjEwMSBsaWJ4MjY1AAAAAAAAAAAAAAAY//8A",
    "AAmMaHZjQwECIAAAAJAAAAAAADzwAPz9+voAAA8EoAABABhAAQwB//8CIAAAAwCQAAADAAADADyVmAmhAAEAKUIBAQIgAAADAJAAAAMAAAMAPKAUIDhNllZp",
    "JMrwFoCAAAADAIAAAAwEogABAAdEAcFytGJAJwABCRFOAQX///////////8MLKLeCbUXR9u7VaT+f8L8TngyNjUgKGJ1aWxkIDIxNikgLSA0LjIrMy0zZjQx",
    "MjBkOltXaW5kb3dzXVtHQ0MgMTUuMi4wXVs2NCBiaXRdIDEwYml0IC0gSC4yNjUvSEVWQyBjb2RlYyAtIENvcHlyaWdodCAyMDEzLTIwMTggKGMpIE11bHRp",
    "Y29yZXdhcmUsIEluYyAtIGh0dHA6Ly94MjY1Lm9yZyAtIG9wdGlvbnM6IGNwdWlkPTExMTEwMzkgZnJhbWUtdGhyZWFkcz0xIG51bWEtcG9vbHM9MSB3cHAg",
    "bm8tcG1vZGUgbm8tcG1lIG5vLXBzbnIgbm8tc3NpbSBsb2ctbGV2ZWw9MCBiaXRkZXB0aD0xMCBpbnB1dC1jc3A9MSBmcHM9MjQvMSBpbnB1dC1yZXM9MTYw",
    "eDIyNCBpbnRlcmxhY2U9MCB0b3RhbC1mcmFtZXM9MCBsZXZlbC1pZGM9MCBoaWdoLXRpZXI9MSB1aGQtYmQ9MCByZWY9MyBuby1hbGxvdy1ub24tY29uZm9y",
    "bWFuY2Ugbm8tcmVwZWF0LWhlYWRlcnMgYW5uZXhiIG5vLWF1ZCBuby1lb2Igbm8tZW9zIG5vLWhyZCBpbmZvIGhhc2g9MCB0ZW1wb3JhbC1sYXllcnM9MCBv",
    "cGVuLWdvcCBtaW4ta2V5aW50PTI0IGtleWludD0yNTAgZ29wLWxvb2thaGVhZD0wIGJmcmFtZXM9NCBiLWFkYXB0PTIgYi1weXJhbWlkIGJmcmFtZS1iaWFz",
    "PTAgcmMtbG9va2FoZWFkPTIwIGxvb2thaGVhZC1zbGljZXM9MCBzY2VuZWN1dD00MCBuby1oaXN0LXNjZW5lY3V0IHJhZGw9MCBuby1zcGxpY2Ugbm8taW50",
    "cmEtcmVmcmVzaCBjdHU9NjQgbWluLWN1LXNpemU9OCBuby1yZWN0IG5vLWFtcCBtYXgtdHUtc2l6ZT0zMiB0dS1pbnRlci1kZXB0aD0xIHR1LWludHJhLWRl",
    "cHRoPTEgbGltaXQtdHU9MCByZG9xLWxldmVsPTAgZHluYW1pYy1yZD0wLjAwIG5vLXNzaW0tcmQgc2lnbmhpZGUgbm8tdHNraXAgbnItaW50cmE9MCBuci1p",
    "bnRlcj0wIG5vLWNvbnN0cmFpbmVkLWludHJhIHN0cm9uZy1pbnRyYS1zbW9vdGhpbmcgbWF4LW1lcmdlPTMgbGltaXQtcmVmcz0xIG5vLWxpbWl0LW1vZGVz",
    "IG1lPTEgc3VibWU9MiBtZXJhbmdlPTU3IHRlbXBvcmFsLW12cCBuby1mcmFtZS1kdXAgbm8taG1lIHdlaWdodHAgbm8td2VpZ2h0YiBuby1hbmFseXplLXNy",
    "Yy1waWNzIGRlYmxvY2s9MDowIHNhbyBuby1zYW8tbm9uLWRlYmxvY2sgcmQ9MyBzZWxlY3RpdmUtc2FvPTQgZWFybHktc2tpcCByc2tpcCBuby1mYXN0LWlu",
    "dHJhIG5vLXRza2lwLWZhc3Qgbm8tY3UtbG9zc2xlc3MgYi1pbnRyYSBuby1zcGxpdHJkLXNraXAgcmRwZW5hbHR5PTAgcHN5LXJkPTIuMDAgcHN5LXJkb3E9",
    "MC4wMCBuby1yZC1yZWZpbmUgbm8tbG9zc2xlc3MgY2JxcG9mZnM9MCBjcnFwb2Zmcz0wIHJjPWNyZiBjcmY9MjguMCBxY29tcD0wLjYwIHFwc3RlcD00IHN0",
    "YXRzLXdyaXRlPTAgc3RhdHMtcmVhZD0wIGlwcmF0aW89MS40MCBwYnJhdGlvPTEuMzAgYXEtbW9kZT0yIGFxLXN0cmVuZ3RoPTEuMDAgY3V0cmVlIHpvbmUt",
    "Y291bnQ9MCBuby1zdHJpY3QtY2JyIHFnLXNpemU9MzIgbm8tcmMtZ3JhaW4gcXBtYXg9NjkgcXBtaW49MCBuby1jb25zdC12YnYgc2FyPTEgb3ZlcnNjYW49",
    "MCB2aWRlb2Zvcm1hdD01IHJhbmdlPTAgY29sb3JwcmltPTIgdHJhbnNmZXI9MiBjb2xvcm1hdHJpeD0yIGNocm9tYWxvYz0wIGRpc3BsYXktd2luZG93PTAg",
    "Y2xsPTAsMCBtaW4tbHVtYT0wIG1heC1sdW1hPTEwMjMgbG9nMi1tYXgtcG9jLWxzYj04IHZ1aS10aW1pbmctaW5mbyB2dWktaHJkLWluZm8gc2xpY2VzPTEg",
    "bm8tb3B0LXFwLXBwcyBuby1vcHQtcmVmLWxpc3QtbGVuZ3RoLXBwcyBuby1tdWx0aS1wYXNzLW9wdC1ycHMgc2NlbmVjdXQtYmlhcz0wLjA1IG5vLW9wdC1j",
    "dS1kZWx0YS1xcCBuby1hcS1tb3Rpb24gbm8taGRyMTAgbm8taGRyMTAtb3B0IG5vLWRoZHIxMC1vcHQgbm8taWRyLXJlY292ZXJ5LXNlaSBhbmFseXNpcy1y",
    "ZXVzZS1sZXZlbD0wIGFuYWx5c2lzLXNhdmUtcmV1c2UtbGV2ZWw9MCBhbmFseXNpcy1sb2FkLXJldXNlLWxldmVsPTAgc2NhbGUtZmFjdG9yPTAgcmVmaW5l",
    "LWludHJhPTAgcmVmaW5lLWludGVyPTAgcmVmaW5lLW12PTEgcmVmaW5lLWN0dS1kaXN0b3J0aW9uPTAgbm8tbGltaXQtc2FvIGN0dS1pbmZvPTAgbm8tbG93",
    "cGFzcy1kY3QgcmVmaW5lLWFuYWx5c2lzLXR5cGU9MCBjb3B5LXBpYz0xIG1heC1hdXNpemUtZmFjdG9yPTEuMCBuby1keW5hbWljLXJlZmluZSBuby1zaW5n",
    "bGUtc2VpIG5vLWhldmMtYXEgbm8tc3Z0IG5vLWZpZWxkIHFwLWFkYXB0YXRpb24tcmFuZ2U9MS4wMCBzY2VuZWN1dC1hd2FyZS1xcD0wY29uZm9ybWFuY2Ut",
    "d2luZG93LW9mZnNldHMgcmlnaHQ9MCBib3R0b209MCBkZWNvZGVyLW1heC1yYXRlPTAgbm8tdmJ2LWxpdmUtbXVsdGktcGFzcyBuby1tY3N0ZiBuby1zYnJj",
    "IG5vLWZyYW1lLXJjgAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAUAAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAGAAAAgAAAAAUc3Rz",
    "cwAAAAAAAAABAAAAAQAAACRzZHRwAAAAACAQEBgYGBAQGBgYEBAYGBAQGBgYEBAYGAAAALhjdHRzAAAAAAAAABUAAAABAAAEAAAAAAEAAAwAAAAAAQAABgAA",
    "AAACAAAAAAAAAAEAAAIAAAAAAQAADAAAAAABAAAGAAAAAAIAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAwAAAAA",
    "AQAABgAAAAACAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAABgAAAABAAAAdHN0c3oA",
    "AAAAAAAAAAAAABgAAAAuAAAAGgAAABgAAAAZAAAAGQAAABgAAAAcAAAAGgAAABoAAAAaAAAAGQAAABwAAAAaAAAAGQAAABkAAAAcAAAAGgAAABoAAAAaAAAA",
    "GQAAABwAAAAaAAAAGQAAABkAAAAUc3RjbwAAAAAAAAABAAAN8wAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAA",
    "AAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAxAAAACGZyZWUAAAKIbWRhdAAAACooAa8dIWZSQPfP5cf/9F8aPlm0feV2uvrN",
    "YwOgqBeWA1/QkwuTeuCHDPgAAAAWAgHQKUvhDGOEVUD5gpDzkTLTlECPeAAAABQCAeBknXhhARNQkXyRrlxhqoATMAAAABUAAeAk9V+iwpImoI6MlDbEZjWA",
    "E9AAAAAVAAHgRNdfosKCJqCOjJQ2xGY1gBPQAAAAFAAB4Ia3/UYUkTWOjJQ2xGY1gBPQAAAAGAIB0FCS1f3EMBjhFVD5gpDzkTLTlECPeAAAABYCAeECJ1df",
    "cYQETUCRfJGuXGGqgBMwAAAAFgAB4Mb1VfSLCkiagI6MlDbEZjWAE9AAAAAWAAHg5tV19IsKCJqAjoyUNsRmNYAT0AAAABUAAeEiLdf3GFJE1I6MlDbEZjWA",
    "E9AAAAAYAgHQcLJV19xDAY6RVfmCkPORMtOUQI94AAAAFgIB4YIlUtfcYQETUJF8ka5cYaqAEzAAAAAVAAHhZvXX0iwpImqOjJQ2xGY1gBPQAAAAFQAB4aIt",
    "V/cYUETUjoyUNsRmNYAT0AAAABgCAdCYstVX3EMBjpFV+YKQ85Ey05RAj3gAAAAWAgHiIidSV9xhCRNQkXyRrlxhqoATMAAAABYAAeHm9VX0iwoImoCOjJQ2",
    "xGY1gBPQAAAAFgAB4gbVdfSLCgiagI6MlDbEZjWAE9AAAAAVAAHiQi3X9xhSRNSOjJQ2xGY1gBPQAAAAGAIB0LiyVdfcQwGOEVX5gpDzkTLTlECPeAAAABYC",
    "AeKiJVLX3GEBE1CRfJGuXGGqgBMwAAAAFQAB4ob119IsKCJqjoyUNsRmNYAT0AAAABUAAeLCLVf3GFJE1I6MlDbEZjWAE9A=",
].join("");

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
    const video = Buffer.from(smokeHevcMain10, "base64");
    if (createHash("sha256").update(video).digest("hex") !== SMOKE_VIDEO_SHA256) throw new Error("Synthetic HEVC fixture checksum changed");
    if (image.byteLength <= 1024 * 1024 || video.byteLength < 1000) throw new Error("Smoke fixtures did not meet real-media requirements");
    return { image, video, imageSha256: createHash("sha256").update(image).digest("hex"), width, height };
}

/** Test-only HTTP upstream. It never proxies or fetches a URL supplied by clients. */
export function createSmokeProvider(project: string, origin: string, media = createSmokeMedia(), imageDelayMs = 0) {
    if (!SMOKE_PROJECT_PATTERN.test(project)) throw new Error("Mock provider is restricted to isolated release/staging projects");
    const endpoint = new URL(origin);
    if (endpoint.protocol !== "http:" || !["mock-provider", "127.0.0.1", "localhost"].includes(endpoint.hostname)) throw new Error("Mock provider origin must be local");
    // A reserved example-domain alias satisfies the unchanged production result
    // URL contract. Both disposable Compose stacks resolve it only internally.
    const resultOrigin = new URL(endpoint.origin);
    resultOrigin.hostname = "mock-provider.example";
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
            return Response.json({ data: { status: "completed", result: { videos: [{ url: [`${resultOrigin.origin}/fixtures/result.mp4`] }] } } });
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
