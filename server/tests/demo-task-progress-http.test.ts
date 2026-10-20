import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DemoOaStore } from "../src/demo-oa-store";
import { DemoStateStore } from "../src/demo-state-store";

test("demo progress endpoint requires the task owner and never invents a shared worker queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-queue-progress-"));
  const path = join(directory, "isolated.sqlite");
  const accounts = new DemoOaStore(path);
  const a = accounts.login({ id: "employee-a", name: "甲" });
  const b = accounts.login({ id: "employee-b", name: "乙" });
  accounts.close();
  const successId = crypto.randomUUID(), pausedId = crypto.randomUUID();
  const state = new DemoStateStore(path);
  state.initialize({ assets: [], tasks: [
    { id: successId, requestId: "queue-progress-success", ownerUserId: a.user.id, operationType: "image_generation", status: "success", createdAt: new Date().toISOString(), resultUrls: [], credits: 0 },
    { id: pausedId, requestId: "queue-progress-paused", ownerUserId: a.user.id, operationType: "image_generation", status: "paused", createdAt: new Date().toISOString(), resultUrls: [], credits: 0 },
  ] as never });
  state.close();
  const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = portProbe.port!;
  await portProbe.stop(true);
  let providerCalls = 0;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    providerCalls++;
    return Response.json({ error: "unexpected provider call" }, { status: 503 });
  } });
  const safeEnvironment: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"])
    if (process.env[name]) safeEnvironment[name] = process.env[name]!;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", "./tests/fixtures/oa-preload.ts", "src/demo-server.ts"], {
    cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe",
    env: {
      ...safeEnvironment, NODE_ENV: "test", DEMO_STATE_PATH: path, DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "true", OA_USERINFO_URL: "https://oa.test/user", AUTH_ENABLED: "false", CREDITS_ENABLED: "false",
      LOCAL_STANDALONE: "false", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
      APIMART_API_KEY: "", OPENTOKEN_API_KEY: "", GPT_IMAGE_2_API_KEY: "", MARK_IMAGE_API_KEY: "",
      APIMART_BASE_URL: `${provider.url.origin}/v1`, OPENTOKEN_BASE_URL: `${provider.url.origin}/v1`,
      GPT_IMAGE_2_BASE_URL: `${provider.url.origin}/v1`, MARK_IMAGE_BASE_URL: `${provider.url.origin}/v1`,
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", REDIS_URL: "redis://127.0.0.1:1",
      HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
    },
  });
  const stderr = new Response(child.stderr).text();
  const origin = `http://127.0.0.1:${port}`;
  const request = (path: string, cookie = "", headers = {}) => fetch(`${origin}${path}`, { headers: { cookie, ...headers } });
  try {
    let ready = false;
    for (let index = 0; index < 100; index++) {
      if (await request("/api/health").then(response => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(await stderr);
      await Bun.sleep(40);
    }
    expect(ready).toBe(true);
    const taskPath = `/api/tasks/${successId}/progress`;
    expect((await request(taskPath)).status).toBe(401);
    const cookies: string[] = [];
    for (const token of ["test-a", "test-b"]) {
      const login = await fetch(`${origin}/api/auth/oa/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      expect(login.status).toBe(200);
      cookies.push(login.headers.get("set-cookie")!.split(";")[0]!);
    }
    const owned = await request(taskPath, cookies[0]);
    expect(owned.headers.get("cache-control")).toBe("private, no-store");
    expect(await owned.json()).toEqual({ progress: {
      taskId: successId, status: "success", runtime: "demo", phase: "complete", queuePosition: null,
      estimatedWaitSeconds: null, estimatedRemainingSeconds: null, sampleCount: 0, estimateReason: null, retryAfterSeconds: null,
    } });
    expect((await request(taskPath, cookies[1])).status).toBe(404);
    expect((await request(taskPath, cookies[1], { "X-Canvas-Owner-Id": a.user.id })).status).toBe(403);
    expect(await request(`/api/tasks/${pausedId}/progress`, cookies[0]).then(response => response.json())).toMatchObject({
      progress: { phase: "paused", runtime: "demo", queuePosition: null, estimatedRemainingSeconds: null },
    });
    expect(providerCalls).toBe(0);
    expect(a.user.id).not.toBe(b.user.id);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await stderr;
    await provider.stop(true);
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("canvas-queue-progress-")) throw new Error("Unsafe test cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
}, 15_000);
