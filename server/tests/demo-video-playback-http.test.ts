import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("demo HTTP playback converts an owned HEVC original, honors Range and preserves its original without any generation task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-demo-playback-http-"));
  const input = join(directory, "source.mp4"), output = join(directory, "preview.mp4");
  const command = (tool: string, args: string[]) => new Promise<Buffer>((resolve, reject) => execFile(tool, args, { windowsHide: true, encoding: "buffer", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await command(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x224:r=24", "-t", "1", "-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1:log-level=error", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", input]);
    const original = await readFile(input);
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port; reservation.stop(true);
    child = Bun.spawn([process.execPath, "--no-env-file", "src/demo-server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe", windowsHide: true,
      env: { ...process.env, NODE_ENV: "test", DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
        OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", ROLE_PORTALS_ENABLED: "true", STANDALONE_WEB_DIR: "",
        OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", MARK_IMAGE_API_KEY: "" },
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(child.stderr && typeof child.stderr !== "number" ? await new Response(child.stderr).text() : "Demo fixture exited before readiness");
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const uploaded = await fetch(`${base}/api/assets/upload-request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "original-hevc.mp4", mimeType: "video/mp4", byteSize: original.byteLength }) });
    expect(uploaded.status).toBe(201);
    const upload = await uploaded.json();
    expect((await fetch(base + upload.uploadUrl, { method: "PUT", body: original, headers: { "content-type": "video/mp4" } })).status).toBe(204);
    const url = `${base}/api/assets/${upload.assetId}/playback`;
    expect((await fetch(url, { method: "HEAD" })).status).toBe(202);
    expect((await fetch(url)).status).toBe(202);
    let playback: Response | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      const response = await fetch(url);
      if (response.status !== 202) { playback = response; break; }
      await Bun.sleep(50);
    }
    expect(playback?.status).toBe(200);
    if (!playback || !playback.ok) throw new Error(await playback?.text() || "Playback did not finish");
    expect(playback.headers.get("x-canvas-media-width")).toBe("160"); expect(playback.headers.get("cache-control")).toBe("no-store");
    const derived = Buffer.from(await playback.arrayBuffer());
    await Bun.write(output, derived);
    const probe = JSON.parse((await command(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", output])).toString());
    expect(probe.streams).toEqual([{ codec_name: "h264", width: 160, height: 224, pix_fmt: "yuv420p" }]);
    const ranged = await fetch(url, { headers: { Range: "bytes=0-15" } });
    expect(ranged.status).toBe(206); expect(Buffer.from(await ranged.arrayBuffer())).toEqual(derived.subarray(0, 16));
    expect((await fetch(url, { headers: { "If-None-Match": playback.headers.get("etag")! } })).status).toBe(304);
    expect(Buffer.from(await (await fetch(`${base}/api/assets/${upload.assetId}/content?download=1`)).arrayBuffer())).toEqual(original);
    expect((await fetch(`${base}/api/tasks`).then(response => response.json())).tasks).toEqual([]);
    expect((await fetch(`${base}/api/assets/${upload.assetId}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(url, { headers: { "If-None-Match": playback.headers.get("etag")! } })).status).toBe(404);
  } finally {
    if (child) { child.kill(); await child.exited; }
    for (const path of [input, output]) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}, 30_000);
