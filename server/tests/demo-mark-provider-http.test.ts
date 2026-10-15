import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { MARK_IMAGE_MODELS, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";

test("demo exposes the expanded Mark catalog, enforces reference limits, and submits the original three UUIDs only once", async () => {
  const submissions: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer fake-mark-http-key");
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/images/generations") {
      submissions.push(await request.json() as Record<string, unknown>);
      return Response.json({ data: [{ task_id: `fake-upstream-${submissions.length}` }] });
    }
    if (request.method === "GET" && path.startsWith("/v1/tasks/")) {
      reads.push(path);
      return Response.json({ data: { status: "failed", error: { message: "local fake provider terminal result" } } });
    }
    return Response.json({ error: "Unexpected local mock request" }, { status: 400 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port; reservation.stop(true);
  const child = Bun.spawn([process.execPath, "src/demo-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", ROLE_PORTALS_ENABLED: "true", STANDALONE_WEB_DIR: "",
      OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "",
      MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, MARK_IMAGE_API_KEY: "fake-mark-http-key" },
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const catalog = await request("/api/models").then(response => response.json());
    const models = catalog.models as Array<Record<string, any>>;
    expect(catalog.tools.find((tool: { toolKey: string }) => tool.toolKey === "seamless-stitch").modelConfigId).toBeNull();
    const imageCatalog = models.filter(model => model.modelIdentityHidden);
    expect(imageCatalog.map(model => [model.id, model.name])).toEqual(MARK_PLATFORM_MODELS.flatMap((model, index) => model.defaultEnabled && (model.capabilities as readonly string[]).includes("generate")
      ? [[`d5000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, model.name]] : []));
    const images = imageCatalog.filter(model => MARK_IMAGE_MODELS.some(original => original.name === model.name));
    expect(images.map(model => [model.id, model.name])).toEqual(MARK_IMAGE_MODELS.map((model, index) => [`d5000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, model.name]));
    expect(images.map(model => model.imageParameterProfile)).toEqual(["quality-resolution", "quality-resolution", "resolution-1k"]);
    expect(images.every(model => model.modelId === model.id)).toBe(true);
    expect(JSON.stringify(models)).not.toMatch(/fake-mark-http-key|127\.0\.0\.1|baseUrl|apiKey/);
    expect((await request("/api/admin/mark-image-provider", "PUT", { apiKey: "must-not-replace-server-key" })).status).toBe(403);

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await request("/api/assets/upload-request", "POST", { filename: "reference-limit.png", mimeType: "image/png", byteSize: png.byteLength }).then(response => response.json());
    expect((await fetch(base + upload.uploadUrl, { method: "PUT", body: png, headers: { "content-type": "image/png" } })).ok).toBe(true);
    const sourceUrl = `/api/assets/${upload.assetId}/content`;
    const multiBatch = await request("/api/tasks/batch", "POST", { requestId: crypto.randomUUID(), projectId: "single-image-check", operationType: "batch_image", toolKey: "canvas-batch", modelConfigId: images[0]!.id, parameters: { count: 10 }, items: [{ sourceUrls: [sourceUrl] }, { sourceUrls: [sourceUrl] }] });
    expect(multiBatch.status).toBe(400);
    expect((await multiBatch.json()).error).toBe("SINGLE_IMAGE_ONLY");
    expect(submissions).toHaveLength(0);
    const disabled = await request("/api/tasks", "POST", { requestId: crypto.randomUUID(), operationType: "image_generation", modelConfigId: "d5000000-0000-4000-8000-000000000008", prompt: "disabled Grok cannot submit", parameters: { size: "1:1", resolution: "1k" } });
    expect(disabled.status).toBe(400);
    expect((await disabled.json()).error).toBe("MODEL_DISABLED");
    for (const [index, maximum] of [[6, 4], [7, 15], [9, 14], [1, 16], [2, 16], [3, 16]]) {
      const rejected = await request("/api/tasks", "POST", { requestId: crypto.randomUUID(), operationType: "image_generation", modelConfigId: `d5000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        prompt: "local reference count rejection", sourceUrls: Array(maximum! + 1).fill(sourceUrl), parameters: { size: "1:1", resolution: "1k" } });
      expect(rejected.status).toBe(400);
      const body = await rejected.json();
      expect(body.error).toBe("TOO_MANY_REFERENCES"); expect(body.message).toContain(String(maximum));
    }
    expect(submissions).toHaveLength(0);

    for (const [index, model] of images.entries()) {
      const input = { requestId: crypto.randomUUID(), operationType: index === 1 ? "seamless_stitch" : "image_generation", modelConfigId: model.id, prompt: "local fake Mark verification", parameters: { resolution: "1k", ...(index < 2 ? { quality: "low" } : {}) } };
      const generated = await request("/api/tasks", "POST", input);
      expect(generated.status).toBe(201);
      const task = (await generated.json()).task;
      const duplicate = await request("/api/tasks", "POST", input).then(response => response.json());
      expect(duplicate.task.id).toBe(task.id);
      let completed: any;
      for (let attempt = 0; attempt < 100; attempt++) {
        completed = await request(`/api/tasks/${task.id}`).then(response => response.json());
        if (completed.task.status !== "processing") break;
        await Bun.sleep(50);
      }
      expect(completed.task.status).toBe("failed");
      expect(completed.task.submissionStartedAt).toEqual(expect.any(String));
      expect(completed.task.upstreamTaskId).toBe(`fake-upstream-${index + 1}`);
      expect(submissions).toHaveLength(index + 1);
      expect(submissions[index]).toMatchObject({ model: MARK_IMAGE_MODELS[index]!.modelId, n: 1, prompt: input.prompt });
    }
    expect(submissions).toHaveLength(3);
    expect(reads).toHaveLength(3);
  } finally {
    child.kill(); await child.exited; provider.stop(true);
  }
}, 25_000);

test("demo recovers the same Mark job with its original mask and bytes, while an unknown submission stays paused", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  let generated = 0;
  let uploads = 0;
  let polls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer fake-mark-recovery-key");
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/v1/uploads/images") {
      uploads++;
      expect((await request.formData()).get("file")).toBeInstanceOf(File);
      return Response.json({ url: "https://mark-demo-reference.invalid/original.png" });
    }
    if (request.method === "POST" && path === "/v1/images/generations") {
      generated++;
      const input = await request.json() as Record<string, unknown>;
      if (input.prompt === "unknown submission") return Response.json({ data: [] });
      expect(input.image_urls).toEqual(["https://mark-demo-reference.invalid/original.png"]);
      expect(input.mask_url).toBe(`data:image/png;base64,${png.toString("base64")}`);
      return Response.json({ data: [{ task_id: "unchanged-mark-job" }] });
    }
    if (request.method === "GET" && path === "/v1/tasks/unchanged-mark-job") {
      polls++;
      if (polls === 1) return Response.json({ error: { message: "temporary local failure" } }, { status: 503 });
      return Response.json({ data: { status: "completed", result: { images: [{ url: ["https://mark-demo-result.invalid/original.png"] }] } } });
    }
    return Response.json({ error: "Unexpected local mock request" }, { status: 400 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port; reservation.stop(true);
  const child = Bun.spawn([process.execPath, "--preload", "./tests/fixtures/demo-mark-result-preload.ts", "src/demo-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", ROLE_PORTALS_ENABLED: "true", STANDALONE_WEB_DIR: "",
      OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "",
      MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, MARK_IMAGE_API_KEY: "fake-mark-recovery-key" },
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const settle = async (id: string) => {
    for (let attempt = 0; attempt < 180; attempt++) {
      const value = await request(`/api/tasks/${id}`).then(response => response.json());
      if (value.task.status !== "processing") return value.task;
      await Bun.sleep(50);
    }
    throw new Error("Local fake task did not settle");
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const sourceUrls: string[] = [];
    for (const filename of ["reference.png", "mask.png"]) {
      const upload = await request("/api/assets/upload-request", "POST", { filename, mimeType: "image/png", byteSize: png.byteLength }).then(response => response.json());
      const stored = await fetch(base + upload.uploadUrl, { method: "PUT", body: png, headers: { "content-type": "image/png" } });
      expect(stored.ok).toBe(true);
      sourceUrls.push(`/api/assets/${upload.assetId}/content`);
    }
    const input = { requestId: crypto.randomUUID(), operationType: "inpaint", modelConfigId: "d5000000-0000-4000-8000-000000000001", prompt: "recover original mask", sourceUrls,
      parameters: { resolution: "1k", quality: "low", output_format: "png", inputArchive: { maskReferenceIndex: 1 } } };
    const submitted = await request("/api/tasks", "POST", input);
    expect(submitted.status).toBe(201);
    const task = (await submitted.json()).task;
    const paused = await settle(task.id);
    expect(paused.status).toBe("paused"); expect(paused.upstreamTaskId).toBe("unchanged-mark-job");
    expect(generated).toBe(1); expect(uploads).toBe(1); expect(polls).toBe(1);
    const recovering = await request(`/api/tasks/${task.id}/recover`, "POST").then(response => response.json());
    expect(recovering.recovered).toBe(true);
    const repeated = await request(`/api/tasks/${task.id}/recover`, "POST").then(response => response.json());
    expect(repeated.recovered).toBe(false);
    const completed = await settle(task.id);
    expect(completed.status).toBe("success"); expect(completed.upstreamTaskId).toBe("unchanged-mark-job");
    expect(generated).toBe(1); expect(uploads).toBe(1); expect(polls).toBe(2);
    expect(completed.resultUrls).toHaveLength(1);
    const assetId = completed.resultUrls[0].split("/")[3];
    const variants = await request(`/api/assets/${assetId}/variants`).then(response => response.json());
    expect(variants.maskComposited).toBe(true);
    expect(variants.original.assetId).not.toBe(variants.primary.assetId);
    const originalResponse = await request(variants.original.url);
    expect(new Uint8Array(await originalResponse.arrayBuffer())).toEqual(new Uint8Array(png));
    expect((await request(variants.primary.url)).ok).toBe(true);
    expect((await request(`/api/tasks/${task.id}/recover`, "POST").then(response => response.json())).recovered).toBe(false);
    expect(generated).toBe(1); expect(polls).toBe(2);

    const unknown = await request("/api/tasks", "POST", { requestId: crypto.randomUUID(), operationType: "image_generation", modelConfigId: input.modelConfigId, prompt: "unknown submission", parameters: {} }).then(response => response.json());
    const unconfirmed = await settle(unknown.task.id);
    expect(unconfirmed.status).toBe("paused"); expect(unconfirmed.upstreamTaskId).toBeUndefined();
    const unchanged = await request(`/api/tasks/${unknown.task.id}/recover`, "POST").then(response => response.json());
    expect(unchanged.recovered).toBe(false); expect(unchanged.task.status).toBe("paused");
    expect(unchanged.task.errorCode).toBe("MARK_IMAGE_SUBMISSION_UNKNOWN");
    expect(generated).toBe(2); expect(uploads).toBe(1); expect(polls).toBe(2);
  } finally {
    child.kill(); await child.exited; provider.stop(true);
  }
}, 30_000);
