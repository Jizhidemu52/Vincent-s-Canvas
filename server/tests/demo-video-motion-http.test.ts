import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { ensureVideoMotionRecipe } from "../src/video-motion-input";
import { DemoStateStore } from "../src/demo-state-store";

test("Demo HTTP validates media before planning, stores safe summary and reuses one compilation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-demo-video-motion-")), statePath = join(directory, "state.sqlite");
  const database = sqlitePromptRecipeStore(statePath);
  await ensureVideoMotionRecipe(database.store);
  const privateRule = "Private video-motion HTTP fixture only. Never expose this authoring instruction to a public task.";
  const summaryZh = "镜头轻推近毛衫针织纹理";
  let plannerCalls = 0, videoCalls = 0, imageUploads = 0, invalidOutput = false;
  const payloads: any[] = [], videoBodies: any[] = [];
  const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const generated = Bun.spawnSync([process.env.FFMPEG_PATH || "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=768x768", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (generated.exitCode !== 0) throw new Error("Could not generate offline PNG test fixture");
  const sourcePng = generated.stdout;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/mark/v1/messages") {
      plannerCalls++;
      const body = await request.json() as any;
      expect(body.system).toContain(privateRule);
      const text = body.messages[0].content.find((part: any) => part.type === "text").text;
      const payload = JSON.parse(text); payloads.push(payload);
      return Response.json({ content: [{ type: "text", text: invalidOutput ? "invalid JSON" : JSON.stringify({ prompt: `${payload.images.length ? "以图片1为首帧。" : ""}0-5秒：镜头轻推近毛衫针织纹理，保持款式颜色。`, summary_zh: summaryZh }) }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 25 } });
    }
    if (path === "/apimart/v1/uploads/images") {
      imageUploads++;
      const form = await request.formData(), file = form.get("file") as File;
      expect(Buffer.from(await file.arrayBuffer()).equals(sourcePng)).toBe(true);
      return Response.json({ url: "https://fixture-cdn.example/untouched-original.png" });
    }
    if (path === "/apimart/v1/videos/generations") {
      videoCalls++; videoBodies.push(await request.json());
      // Deterministic terminal rejection avoids polling and any remote media access.
      return Response.json({ error: "offline fixture rejection" }, { status: 400 });
    }
    return Response.json({ error: "Only loopback fixture routes allowed" }, { status: 400 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const start = () => Bun.spawn([process.execPath, "src/demo-server.ts"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe", windowsHide: true,
    env: { ...process.env, DEMO_STATE_PATH: statePath, DEMO_RECOVERY_FILE: "", DEMO_HOST: "127.0.0.1", DEMO_PORT: String(port), OA_LOGIN_ENABLED: "false", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
      MARK_IMAGE_API_KEY: "offline-planner-key", MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/mark/v1`,
      APIMART_API_KEY: "offline-video-key", APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/apimart/v1`, OPENTOKEN_API_KEY: "", GPT_IMAGE_2_API_KEY: "" } });
  let child = start();
  const ready = async () => {
    for (let index = 0; index < 150; index++) {
      if (await fetch(base + "/api/health").then(response => response.ok).catch(() => false)) return;
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(40);
    }
    throw new Error("Demo motion fixture startup timed out");
  };
  const request = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const input = () => ({ requestId: crypto.randomUUID(), projectId: "video-motion-http-fixture", operationType: "video_generation", toolKey: "video", modelConfigId: "40000000-0000-4000-8000-000000000111", prompt: "",
    parameters: { seconds: 5, size: "adaptive", resolution: "720p", videoMode: "auto" }, sourceUrls: [] as string[], promptInput: { scene: "video-motion", mode: "video", fields: {}, userText: "" } });
  const upload = async (bytes: Uint8Array) => {
    const reservation = await (await request("/api/assets/upload-request", { filename: "motion.png", mimeType: "image/png", byteSize: bytes.byteLength })).json();
    expect((await fetch(base + reservation.uploadUrl, { method: "PUT", body: Uint8Array.from(bytes), headers: { "content-type": "image/png" } })).status).toBe(204);
    return `/api/assets/${reservation.assetId}/content`;
  };
  const settled = async (id: string) => {
    for (let index = 0; index < 150; index++) {
      const result = await (await request(`/api/tasks/${id}`)).json();
      if (result.task.status !== "processing") return result.task;
      await Bun.sleep(40);
    }
    throw new Error("Offline video task did not finish");
  };
  try {
    await ready();
    const unconfigured = await request("/api/tasks", input()); expect(unconfigured.status).toBe(503);
    expect(plannerCalls).toBe(0); expect(videoCalls).toBe(0);
    await database.store.update("video-motion", { ...(await database.store.get("video-motion")), modelConfigId: "d5000000-0000-4000-8000-000000000010" });
    const version = await database.store.saveVersion("video-motion", { systemPrompt: privateRule, fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "zh", changeNote: "offline fixture" }, "fixture-admin");
    await database.store.activate("video-motion", version.id);
    const invalid = input(); invalid.sourceUrls = [await upload(tinyPng)];
    expect((await request("/api/tasks", invalid)).status).toBe(400); expect(plannerCalls).toBe(0); expect(imageUploads).toBe(0); expect(videoCalls).toBe(0);
    const value = input(); value.sourceUrls = [await upload(sourcePng)];
    const created = await request("/api/tasks", value); expect(created.status).toBe(201);
    const first = (await created.json()).task;
    expect(first).toMatchObject({ summaryZh, optimized: true, parameters: { videoMode: "first-frame", generateAudio: false, promptOptimization: { summaryZh } } });
    expect(JSON.stringify(first)).not.toMatch(/Private video-motion|rawResponse|latencyMs|actualCost|offline-planner-key|claude-sonnet/);
    expect((await settled(first.id)).status).toBe("failed");
    expect(plannerCalls).toBe(1); expect(videoCalls).toBe(1); expect(imageUploads).toBe(1);
    expect(payloads[0]).toMatchObject({ model_style: "video", fields: { duration: 5, video_mode: "first-frame", generate_audio: false }, images: [{ index: 1, role: "首帧" }] });
    expect(videoBodies[0]).toMatchObject({ model: "seedance-2.5", duration: 5, resolution: "720p", generate_audio: false, image_with_roles: [{ role: "first_frame", url: "https://fixture-cdn.example/untouched-original.png" }] });
    expect((await (await request("/api/tasks", value)).json()).task.id).toBe(first.id); expect(plannerCalls).toBe(1); expect(videoCalls).toBe(1);
    const same = await (await request("/api/tasks", { ...value, requestId: crypto.randomUUID() })).json(); await settled(same.task.id);
    expect(plannerCalls).toBe(1); expect(videoCalls).toBe(2);
    invalidOutput = true;
    const badOutput = input(); badOutput.promptInput.userText = "invalid output";
    expect((await request("/api/tasks", badOutput)).status).toBe(422); expect(plannerCalls).toBe(2); expect(videoCalls).toBe(2);
    const raw = { ...input(), promptInput: undefined, prompt: "明确自写的视频提示词" };
    expect((await request("/api/tasks", raw)).status).toBe(403);
    child.kill(); await child.exited;
    const state = new DemoStateStore(statePath); state.saveVideoRawPromptAllowance(true); state.close();
    child = start(); await ready();
    expect((await (await request(`/api/tasks/${first.id}`)).json()).task.summaryZh).toBe(summaryZh);
    expect((await (await request("/api/models")).json()).tools.find((tool: { toolKey: string }) => tool.toolKey === "video").allowRawPrompt).toBe(true);
    const allowed = await request("/api/tasks", raw); expect(allowed.status).toBe(201); await settled((await allowed.json()).task.id);
    expect(plannerCalls).toBe(2); expect(videoCalls).toBe(3);
  } finally {
    child.kill(); await child.exited; provider.stop(true); database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);
