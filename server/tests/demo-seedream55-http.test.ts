import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("local Seedream supports owned-reference edits and generation with strict preflight and one original submission", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const submissions: Array<Record<string, unknown>> = [];
  const polls: string[] = [];
  const unexpected: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer isolated-seedream-fixture");
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/images/generations") {
      submissions.push(await request.json() as Record<string, unknown>);
      return Response.json({ data: [{ task_id: `seedream-fixture-${submissions.length}` }] });
    }
    if (request.method === "GET" && path.startsWith("/v1/tasks/seedream-fixture-")) {
      polls.push(path);
      const count = path.endsWith("-3") ? 2 : 1;
      return Response.json({ data: { status: "completed", result: { images: Array.from({ length: count }, () => ({ url: ["https://mark-demo-result.invalid/original.png"] })) } } });
    }
    unexpected.push(`${request.method} ${path}`);
    return Response.json({ error: "UNEXPECTED_FIXTURE_REQUEST" }, { status: 400 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port; reservation.stop(true);
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", "./tests/fixtures/demo-mark-result-preload.ts", "src/demo-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe", windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", ROLE_PORTALS_ENABLED: "true", STANDALONE_WEB_DIR: "",
      OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", DEMO_TEST_RESULT_FAILURE_ONCE: "0", DEMO_SEEDREAM55_ENABLED: "true",
      MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, MARK_IMAGE_API_KEY: "isolated-seedream-fixture" },
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const taskResult = async (id: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const result = await request(`/api/tasks/${id}`).then(response => response.json());
      if (result.task.status !== "processing") return result.task;
      await Bun.sleep(50);
    }
    throw new Error("Isolated Seedream task did not finish");
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const catalog = await request("/api/models").then(response => response.json());
    const model = catalog.models.find((item: { name: string }) => item.name === "豆包生图");
    expect(model).toMatchObject({ id: "d5000000-0000-4000-8000-000000000014", imageParameterProfile: "seedream55", imageSupportsMask: false, capabilities: ["generate", "edit"] });
    expect(JSON.stringify(model)).not.toMatch(/isolated-seedream-fixture|seedream-5-5|baseUrl|apiKey/);

    const upload = await request("/api/assets/upload-request", "POST", { filename: "seedream-reference.png", mimeType: "image/png", byteSize: png.length }).then(response => response.json());
    expect((await fetch(base + upload.uploadUrl, { method: "PUT", body: png, headers: { "content-type": "image/png" } })).ok).toBe(true);
    const sourceUrl = `/api/assets/${upload.assetId}/content`;
    const edit = { requestId: crypto.randomUUID(), projectId: "isolated-seedream", toolKey: "image-edit", operationType: "inpaint", modelConfigId: model.id,
      prompt: "Keep the shape and change the fabric to blue", sourceUrls: [sourceUrl], parameters: { size: "auto", resolution: "1k", n: 1, count: 1 } };
    for (const input of [
      { ...edit, requestId: crypto.randomUUID(), sourceUrls: Array(11).fill(sourceUrl) },
      { ...edit, requestId: crypto.randomUUID(), parameters: { ...edit.parameters, layer_decomposition: true } },
      { ...edit, requestId: crypto.randomUUID(), sourceUrls: [sourceUrl, sourceUrl], parameters: { ...edit.parameters, inputArchive: { maskReferenceIndex: 1 } } },
    ]) {
      expect((await request("/api/tasks", "POST", input)).status).toBe(400);
    }
    expect(submissions).toEqual([]);

    const response = await request("/api/tasks", "POST", edit);
    expect(response.status).toBe(201);
    const task = (await response.json()).task;
    const duplicate = await request("/api/tasks", "POST", edit).then(response => response.json());
    expect(duplicate.task.id).toBe(task.id);
    const completed = await taskResult(task.id);
    expect(completed.status).toBe("success");
    expect(completed.upstreamTaskId).toBe("seedream-fixture-1");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ model: "seedream-5-5", prompt: edit.prompt, size: "1K", n: 1, image_urls: [`data:image/png;base64,${png.toString("base64")}`] });
    expect(submissions[0]).not.toHaveProperty("mask_url");
    expect(submissions[0]).not.toHaveProperty("layer_decomposition");
    expect(completed.resultUrls).toHaveLength(1);
    const resultBytes = await request(completed.resultUrls[0]).then(response => response.arrayBuffer());
    expect(Buffer.from(resultBytes)).toEqual(png);

    const generation = { ...edit, requestId: crypto.randomUUID(), operationType: "image_generation", toolKey: "image", sourceUrls: [] };
    const generated = await request("/api/tasks", "POST", generation).then(response => response.json());
    expect((await taskResult(generated.task.id)).status).toBe("success");
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).not.toHaveProperty("image_urls");

    const overreturn = { ...edit, requestId: crypto.randomUUID() };
    const excess = await request("/api/tasks", "POST", overreturn).then(response => response.json());
    const paused = await taskResult(excess.task.id);
    expect(paused.status).toBe("paused");
    expect(paused.upstreamTaskId).toBe("seedream-fixture-3");
    expect(paused.resultUrls).toEqual([]);
    expect((await request("/api/tasks", "POST", overreturn).then(response => response.json())).task.id).toBe(excess.task.id);
    expect(submissions).toHaveLength(3);
    expect(polls).toHaveLength(3);
    expect(unexpected).toEqual([]);
    const originalBytes = await request(sourceUrl).then(response => response.arrayBuffer());
    expect(Buffer.from(originalBytes)).toEqual(png);
  } finally {
    child.kill(); await child.exited; provider.stop(true);
  }
}, 30_000);
