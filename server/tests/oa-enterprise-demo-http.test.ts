import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoOaStore } from "../src/demo-oa-store";
import { DemoStateStore } from "../src/demo-state-store";

test("OA HTTP exchange isolates employees, denies legacy logins and invalid replacements, preserves ownership across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-oa-http-"));
  const statePath = join(directory, "state.sqlite");
  const seed = new DemoOaStore(statePath);
  const a = seed.login({ id: "employee-a", name: "甲" });
  const b = seed.login({ id: "employee-b", name: "乙" });
  seed.close();
  const state = new DemoStateStore(statePath);
  const taskA = crypto.randomUUID();
  const taskB = crypto.randomUUID();
  state.initialize({ assets: [], tasks: [
    { id: taskA, requestId: taskA, ownerUserId: a.user.id, status: "success", resultUrls: [], credits: 0, createdAt: new Date().toISOString() },
    { id: taskB, requestId: taskB, ownerUserId: b.user.id, status: "success", resultUrls: [], credits: 0, createdAt: new Date().toISOString() },
  ] as never });
  state.close();
  const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = portProbe.port!; await portProbe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  let submissions = 0;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
    expect(new URL(request.url).pathname).toBe("/v1/images/generations");
    submissions++;
    return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=" }] });
  } });
  const start = () => Bun.spawn([process.execPath, "--preload", "./tests/fixtures/oa-preload.ts", "src/demo-server.ts"], {
    cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: statePath, DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1", OA_LOGIN_ENABLED: "true", OA_USERINFO_URL: "https://oa.test/user", AUTH_ENABLED: "false", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", STANDALONE_WEB_DIR: "", OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, OPENTOKEN_API_KEY: "test-only", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "" },
  });
  let processHandle = start();
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false)) return;
      if (processHandle.exitCode !== null) throw new Error(await new Response(processHandle.stderr).text());
      await Bun.sleep(50);
    }
    throw new Error("isolated server did not start");
  };
  const request = (path: string, cookie = "", init: RequestInit = {}) => fetch(base + path, { ...init, headers: { cookie, "content-type": "application/json", ...init.headers } });
  const exchange = async (token: string, cookie = "") => {
    const response = await request("/api/auth/oa/exchange", cookie, { method: "POST", body: JSON.stringify({ token, ownerUserId: "forged", role: "super_admin" }) });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] || "", body: await response.json() as any };
  };
  try {
    await ready();
    expect(await request("/api/deployment").then(r => r.json())).toMatchObject({ oaLoginEnabled: true, authenticationEnabled: true, rolePortalsEnabled: false });
    expect((await request("/api/tasks")).status).toBe(401);
    for (const path of ["/api/demo/accounts", "/api/auth/wecom/start"]) expect((await request(path)).status).toBe(404);
    expect((await request("/api/admin/accounts")).status).toBe(403);
    expect((await request("/api/auth/login", "", { method: "POST", body: "{}" })).status).toBe(404);
    expect(await request("/api/auth/wecom/start").then(r => r.json())).toMatchObject({ message: "请从公司 OA 进入，无需另外扫码。" });
    const first = await exchange("test-a"); const second = await exchange("test-b");
    expect(first.body.user.id).toBe(a.user.id); expect(second.body.user.id).toBe(b.user.id);
    expect(first.body.user.role).toBe("designer");
    expect(first.response.headers.get("set-cookie")).toContain("HttpOnly");
    for (const path of ["/api/tasks", "/api/chat/responses"]) {
      const rejected = await request(path, second.cookie, { method: "POST", headers: { "X-Canvas-Owner-Id": a.user.id }, body: "{}" });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ error: "CANVAS_OWNER_MISMATCH" });
      expect(rejected.headers.get("set-cookie")).toBeNull();
    }
    expect(submissions).toBe(0);
    expect((await request("/api/tasks", second.cookie, { headers: { "X-Canvas-Owner-Id": b.user.id } })).status).toBe(200);
    expect(await request("/api/tasks", first.cookie).then(r => r.json())).toMatchObject({ tasks: [{ id: taskA, ownerUserId: a.user.id }] });
    expect(await request("/api/tasks", second.cookie).then(r => r.json())).toMatchObject({ tasks: [{ id: taskB, ownerUserId: b.user.id }] });
    expect((await request(`/api/tasks/${taskA}`, second.cookie)).status).toBe(404);
    const upload = await request("/api/assets/upload-request", first.cookie, { method: "POST", body: JSON.stringify({ filename: "owner-check.txt", mimeType: "text/plain", byteSize: 1, ownerUserId: b.user.id }) }).then(r => r.json()) as any;
    expect((await request(upload.uploadUrl, first.cookie, { method: "PUT", body: "a" })).status).toBe(204);
    expect(await request("/api/assets", first.cookie).then(r => r.json())).toMatchObject({ assets: [{ ownerUserId: a.user.id, ownerName: "甲" }] });
    expect((await request(`/api/assets/${upload.assetId}/content`, second.cookie)).status).toBe(404);
    for (const employee of [{ login: first, id: a.user.id }, { login: second, id: b.user.id }]) {
      const generated = await request("/api/tasks", employee.login.cookie, { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), ownerUserId: "forged-owner", operationType: "image_generation", modelConfigId: "40000000-0000-4000-8000-000000000107", prompt: "isolated mock generation" }) }).then(r => r.json()) as any;
      expect(generated.task.ownerUserId).toBe(employee.id);
      let completed: any;
      for (let i = 0; i < 50; i++) {
        completed = await request(`/api/tasks/${generated.task.id}`, employee.login.cookie).then(r => r.json());
        if (completed.task.status !== "processing") break;
        await Bun.sleep(20);
      }
      expect(completed.task.status).toBe("success");
      expect(completed.task.ownerUserId).toBe(employee.id);
      const other = employee.id === a.user.id ? second.cookie : first.cookie;
      expect((await request(completed.task.resultUrls[0], other)).status).toBe(404);
      expect(await request("/api/history", employee.login.cookie).then(r => r.json())).toMatchObject({ history: expect.arrayContaining([expect.objectContaining({ taskId: generated.task.id, userId: employee.id })]) });
    }
    expect(submissions).toBe(2);
    const invalid = await exchange("invalid", first.cookie);
    expect(invalid.response.status).toBe(401);
    expect(invalid.response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await request("/api/auth/session", first.cookie)).status).toBe(401);
    const rotated = await exchange("test-a-rotated");
    expect(rotated.body.user.id).toBe(a.user.id);
    processHandle.kill(); await processHandle.exited; processHandle = start(); await ready();
    expect(await request("/api/auth/session", rotated.cookie).then(r => r.json())).toMatchObject({ user: { id: a.user.id } });
    const persistedAssets = await request("/api/assets", rotated.cookie).then(r => r.json()) as any;
    expect(persistedAssets.assets).toHaveLength(2);
    expect(persistedAssets.assets.every((asset: any) => asset.ownerUserId === a.user.id)).toBe(true);
    expect((await request("/api/auth/logout", rotated.cookie, { method: "POST" })).status).toBe(204);
    expect((await request("/api/auth/session", rotated.cookie)).status).toBe(401);
  } finally {
    processHandle.kill(); await processHandle.exited;
    await provider.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
