import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type PublicModel = { id: string; modelId: string; capabilities: string[]; parameterModelId?: string };

test.each([false, true])("demo Mark chat and video isolate credentials and resume without paid replay (legacy credentials: %s)", async (withLegacyCredentials) => {
  const calls: Array<{ path: string; method: string; authorization: string | null; body?: any }> = [];
  let polls = 0;
  let providerPort = 0;
  const output = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50]);
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/result.mp4") return new Response(output, { headers: { "content-type": "video/mp4" } });
    const call: (typeof calls)[number] = { path, method: request.method, authorization: request.headers.get("authorization") };
    calls.push(call);
    if (call.authorization !== "Bearer isolated-mark-test-key" || !path.startsWith("/mark/v1/"))
      return Response.json({ error: "A Mark request used the wrong channel" }, { status: 403 });
    if (path === "/mark/v1/responses") {
      call.body = await request.json();
      return Response.json({ code: 200, data: { choices: [{ message: { content: "The original cable structure is intact." }, finish_reason: "stop" }] } });
    }
    if (path === "/mark/v1/uploads/images") {
      expect((await request.formData()).get("file")).toBeInstanceOf(File);
      return Response.json({ url: "https://mark-reference.invalid/knit.png" });
    }
    if (path === "/mark/v1/videos/generations") {
      call.body = await request.json();
      return Response.json({ data: [{ task_id: "same-mark-video-task" }] });
    }
    if (path === "/mark/v1/tasks/same-mark-video-task") {
      polls++;
      if (polls === 1) return Response.json({ error: "Temporary local poll failure" }, { status: 503 });
      return Response.json({ data: { status: "completed", result: { videos: [{ url: [`http://127.0.0.1:${providerPort}/result.mp4`] }] } } });
    }
    return Response.json({ error: "Unexpected local request" }, { status: 400 });
  } });
  providerPort = provider.port!;
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const child = Bun.spawn([process.execPath, "src/demo-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", ROLE_PORTALS_ENABLED: "true", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
      OPENTOKEN_API_KEY: withLegacyCredentials ? "wrong-opentoken-key" : "", APIMART_API_KEY: withLegacyCredentials ? "wrong-legacy-apimart-key" : "", GPT_IMAGE_2_API_KEY: "",
      OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/opentoken/v1`, APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/legacy/v1`,
      MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/mark/v1`, MARK_IMAGE_API_KEY: "isolated-mark-test-key" },
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const settle = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await request(`/api/tasks/${id}`).then(response => response.json());
      if (value.task.status !== "processing") return value.task;
      await Bun.sleep(50);
    }
    throw new Error("Local fake video task did not settle");
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const catalog = await request("/api/models").then(response => response.json());
    const models = catalog.models as PublicModel[];
    const markModels = models.filter(model => model.id.startsWith("d5000000-"));
    const chat = markModels.find(model => model.capabilities.includes("chat"));
    const video = markModels.find(model => model.capabilities.includes("video"));
    expect(chat).toBeDefined(); expect(video).toBeDefined();
    expect(chat!.modelId).toBe(chat!.id); expect(video!.modelId).toBe(video!.id);
    expect(video!.parameterModelId).toBe("happyhorse-1.1");
    expect(JSON.stringify(models)).not.toMatch(/isolated-mark-test-key|wrong-opentoken-key|wrong-legacy-apimart-key|127\.0\.0\.1/);
    if (withLegacyCredentials) expect(models.some(model => model.id !== chat!.id && model.modelId === "gpt-6-astra")).toBe(true);

    const reply = await request("/api/chat/responses", "POST", { modelId: chat!.id, toolKey: "gpt-chat", input: [{ role: "user", content: "Inspect this knit." }], tools: [] });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ content: "The original cable structure is intact.", toolCalls: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ model: "gpt-6-astra", stream: false, input: [{ role: "user", content: "Inspect this knit." }], tools: [], tool_choice: "auto", parallel_tool_calls: false });

    const reference = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "720x960", "-i", "pipe:0", "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], {
      input: new Uint8Array(720 * 960 * 3).fill(128), encoding: "buffer", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    if (reference.error || reference.status !== 0) throw new Error(String(reference.error || reference.stderr));
    const upload = await request("/api/assets/upload-request", "POST", { filename: "knit-reference.png", mimeType: "image/png", byteSize: reference.stdout.byteLength }).then(response => response.json());
    expect((await fetch(base + upload.uploadUrl, { method: "PUT", body: reference.stdout, headers: { "content-type": "image/png" } })).ok).toBe(true);
    const input = { requestId: crypto.randomUUID(), operationType: "video_generation", toolKey: "video", modelConfigId: video!.id,
      prompt: "Keep the cable-knit cardigan intact. Slow camera movement.", sourceUrls: [`/api/assets/${upload.assetId}/content`],
      parameters: { videoMode: "first-frame", seconds: 3, resolution: "720P", size: "3:4", watermark: false } };
    const preflight = await request("/api/tasks/preflight", "POST", input);
    expect(preflight.status).toBe(200);
    expect(calls).toHaveLength(1);
    const submitted = await request("/api/tasks", "POST", input);
    expect(submitted.status).toBe(201);
    const task = (await submitted.json()).task;
    const duplicate = await request("/api/tasks", "POST", input).then(response => response.json());
    expect(duplicate.task.id).toBe(task.id);
    const paused = await settle(task.id);
    expect(paused.status).toBe("paused"); expect(paused.upstreamTaskId).toBe("same-mark-video-task");
    expect(calls.filter(call => call.path.endsWith("/uploads/images"))).toHaveLength(1);
    const submissions = calls.filter(call => call.path.endsWith("/videos/generations"));
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.body).toMatchObject({ model: "happyhorse-1.1", prompt: input.prompt, duration: 3, resolution: "720P", first_frame_image: "https://mark-reference.invalid/knit.png", watermark: false });
    const recovering = await request(`/api/tasks/${task.id}/recover`, "POST").then(response => response.json());
    expect(recovering.recovered).toBe(true);
    expect((await request(`/api/tasks/${task.id}/recover`, "POST").then(response => response.json())).recovered).toBe(false);
    const completed = await settle(task.id);
    expect(completed.status).toBe("success"); expect(completed.upstreamTaskId).toBe("same-mark-video-task");
    expect(completed.resultUrls).toHaveLength(1);
    expect(new Uint8Array(await (await request(completed.resultUrls[0])).arrayBuffer())).toEqual(output);
    expect(polls).toBe(2);
    expect(calls.map(call => [call.path, call.method])).toEqual([
      ["/mark/v1/responses", "POST"], ["/mark/v1/uploads/images", "POST"], ["/mark/v1/videos/generations", "POST"],
      ["/mark/v1/tasks/same-mark-video-task", "GET"], ["/mark/v1/tasks/same-mark-video-task", "GET"],
    ]);
  } finally {
    child.kill(); await child.exited; provider.stop(true);
  }
}, 30_000);
