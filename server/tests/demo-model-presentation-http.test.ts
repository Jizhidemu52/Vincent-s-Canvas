import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("designer sees four feature-named OpenToken images while UUID submission still calls the configured upstream model", async () => {
  const submissions: Array<Record<string, unknown>> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer fake-key-no-paid-network");
    submissions.push(await request.json() as Record<string, unknown>);
    return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port; reservation.stop(true);
  const child = Bun.spawn([process.execPath, "src/demo-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", ROLE_PORTALS_ENABLED: "true", STANDALONE_WEB_DIR: "",
      OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, OPENTOKEN_API_KEY: "fake-key-no-paid-network",
      APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, APIMART_API_KEY: "fake-key-no-paid-network", GPT_IMAGE_2_API_KEY: "" },
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, cookie = "", method = "GET", body?: unknown) => fetch(base + path, {
    method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const designerCookie = "";
    const models = (await request("/api/models", designerCookie).then((response) => response.json())).models as Array<Record<string, any>>;
    const images = models.filter((model) => model.modelIdentityHidden);
    expect(images.map(model => [model.id, model.name])).toEqual([
      ["40000000-0000-4000-8000-000000000105", "日常生图"],
      ["40000000-0000-4000-8000-000000000107", "快速试稿"],
      ["40000000-0000-4000-8000-000000000108", "细节精修"],
      ["40000000-0000-4000-8000-000000000106", "备用生图"],
    ]);
    expect(models.some(model => model.modelId === "happyhorse-1.1")).toBe(true);
    expect(models.some(model => model.modelId === "claude-fable-5")).toBe(true);
    for (const model of images) {
      expect(model.name.length).toBeLessThanOrEqual(8);
      expect(model.modelId).toBe(model.id);
      expect(model.publicName).toBe(model.name);
      expect(model.publicDescription).toEqual(expect.any(String));
      expect(JSON.stringify(model)).not.toMatch(/gpt|gemini|midjourney|apimart|opentoken/i);
    }
    expect([403, 404]).toContain((await request("/api/admin/model-configuration/models", designerCookie)).status);
    const alias = images.find((model) => model.id === "40000000-0000-4000-8000-000000000107")!;
    expect(alias).toBeDefined();
    expect((await request("/api/auth/login", "", "POST", { identifier: "admin", password: "Canvas2026!#", portal: "admin" })).status).toBe(404);
    expect((await request(`/api/admin/model-configuration/models/${alias.id}`, "", "PATCH", { enabled: false })).status).toBe(403);

    const removed = await request("/api/tasks", designerCookie, "POST", { requestId: crypto.randomUUID(), operationType: "image_generation", modelConfigId: "40000000-0000-4000-8000-000000000099", prompt: "must not call retired channel", parameters: {} });
    expect(removed.status).toBe(400);
    expect((await removed.json()).error).toBe("MODEL_DISABLED");
    expect(submissions).toHaveLength(0);

    const generated = await request("/api/tasks", designerCookie, "POST", { requestId: crypto.randomUUID(), operationType: "image_generation", modelConfigId: alias.modelId, prompt: "anonymous model verification", parameters: {} });
    expect(generated.status).toBe(201);
    const task = (await generated.json()).task;
    let completed: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      completed = await request(`/api/tasks/${task.id}`, designerCookie).then((response) => response.json());
      if (completed.task.status !== "processing") break;
      await Bun.sleep(20);
    }
    expect(completed.task.status).toBe("success");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ model: "gpt-image-2.5-flare", prompt: "anonymous model verification" });
  } finally {
    child.kill(); await child.exited; provider.stop(true);
  }
}, 20_000);
