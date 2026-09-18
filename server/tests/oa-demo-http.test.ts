import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoOaStore } from "../src/demo-oa-store";
import { DemoStateStore } from "../src/demo-state-store";

test("local trial preserves private employee data and completes anonymous generation across restart", async () => {
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
    env: { ...process.env, DEMO_STATE_PATH: statePath, DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1", OA_LOGIN_ENABLED: "false", OA_USERINFO_URL: "https://oa.test/user", AUTH_ENABLED: "false", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", STANDALONE_WEB_DIR: "", OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, OPENTOKEN_API_KEY: "test-only", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "" },
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
    expect(await request("/api/deployment").then(r => r.json())).toEqual({ oaLoginEnabled: false, authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false });
    expect((await request("/api/tasks")).status).toBe(200);
    for (const path of ["/api/demo/accounts", "/api/auth/wecom/start"]) expect((await request(path)).status).toBe(404);
    expect((await request("/api/admin/accounts")).status).toBe(403);
    expect((await request("/api/auth/login", "", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await exchange("test-a")).response.status).toBe(404);
    const user = (await request("/api/auth/session").then(r => r.json()) as any).user;
    expect(user.role).toBe("designer");
    expect(user.id).not.toBe(a.user.id);
    expect(user.id).not.toBe(b.user.id);
    // Old employee data is left in place, never reassigned to the open designer.
    expect(await request("/api/tasks").then(r => r.json())).toMatchObject({ tasks: [] });
    expect((await request(`/api/tasks/${taskA}`)).status).toBe(404);
    const upload = await request("/api/assets/upload-request", "", { method: "POST", body: JSON.stringify({ filename: "open.txt", mimeType: "text/plain", byteSize: 1, ownerUserId: b.user.id }) }).then(r => r.json()) as any;
    expect((await request(upload.uploadUrl, "", { method: "PUT", body: "a" })).status).toBe(204);
    expect(await request("/api/assets").then(r => r.json())).toMatchObject({ assets: [{ ownerUserId: user.id }] });
    const generated = await request("/api/tasks", "", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), ownerUserId: "forged-owner", operationType: "image_generation", modelConfigId: "40000000-0000-4000-8000-000000000107", prompt: "open mock generation" }) }).then(r => r.json()) as any;
    let completed: any;
    for (let i = 0; i < 50; i++) {
      completed = await request(`/api/tasks/${generated.task.id}`).then(r => r.json());
      if (completed.task.status !== "processing") break;
      await Bun.sleep(20);
    }
    expect(completed.task).toMatchObject({ status: "success", ownerUserId: user.id, credits: 0 });
    expect((await request(completed.task.resultUrls[0])).status).toBe(200);
    expect(submissions).toBe(1);
    processHandle.kill(); await processHandle.exited; processHandle = start(); await ready();
    expect(await request("/api/auth/session", "wireless_canvas_demo_session=old-expired-oa-token").then(r => r.json())).toMatchObject({ user: { id: user.id } });
    expect((await request("/api/assets").then(r => r.json()) as any).assets).toHaveLength(2);
    expect((await request("/api/tasks").then(r => r.json()) as any).tasks).toHaveLength(1);
  } finally {
    processHandle.kill(); await processHandle.exited;
    await provider.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
