import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoAccounts } from "../src/demo-accounts";
import { DemoOaStore } from "../src/demo-oa-store";

test("open canvas HTTP persists whole documents with owner headers, revisions and byte-preserving media", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-document-http-"));
  const statePath = join(directory, "state.sqlite");
  const identities = new DemoOaStore(statePath);
  const a = { user: demoAccounts.find(account => account.identifier === "designer01")!.user, token: "obsolete-session" };
  const b = identities.login({ id: "employee-b", name: "乙" });
  identities.close();
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!; await probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const start = () => Bun.spawn([process.execPath, "src/demo-server.ts"], {
    cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: statePath, DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1", OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "false", STANDALONE_WEB_DIR: "", OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "" },
  });
  let handle = start();
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false)) return;
      if (handle.exitCode !== null) throw new Error(await new Response(handle.stderr).text());
      await Bun.sleep(50);
    }
    throw new Error("isolated document server did not start");
  };
  const request = (path: string, employee = a, init: RequestInit = {}, ownerId: string | null = employee.user.id) => fetch(base + path, {
    ...init, headers: { cookie: `wireless_canvas_demo_session=${employee.token}`, "content-type": "application/json", ...(ownerId === null ? {} : { "x-canvas-owner-id": ownerId }), ...init.headers },
  });
  const put = (employee: typeof a, id: string, baseRevision: number, document: unknown) => request(`/api/canvas-documents/${id}`, employee, { method: "PUT", body: JSON.stringify({ baseRevision, document }) });
  try {
    await ready();
    expect((await fetch(base + "/api/canvas-documents")).status).toBe(403);
    expect((await request("/api/canvas-documents", a, {}, null)).status).toBe(403);
    expect((await request("/api/canvas-documents", a, {}, b.user.id)).status).toBe(403);
    const bytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64"));
    const uploadInput = { filename: "original.png", mimeType: "image/png", byteSize: bytes.byteLength };
    expect((await request("/api/assets/upload-request", a, { method: "POST", body: JSON.stringify(uploadInput) }, b.user.id)).status).toBe(403);
    const upload = await request("/api/assets/upload-request", a, { method: "POST", body: JSON.stringify(uploadInput) }).then(r => r.json()) as any;
    expect((await request(upload.uploadUrl, a, { method: "PUT", body: bytes }, b.user.id)).status).toBe(403);
    expect((await request(upload.uploadUrl, a, { method: "PUT", body: bytes })).status).toBe(204);
    const assetUrl = `/api/assets/${upload.assetId}/content`;
    const source = {
      id: "canvas-a", title: "完整设计稿", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T01:00:00.000Z",
      nodes: [{ id: "image-1", type: "image", title: "原始图片", width: 1500, height: 2100, position: { x: -1.25, y: 78.5 }, metadata: { content: assetUrl, prompt: "保持原样", extensions: { editable: true } } }],
      connections: [], chatSessions: [{ id: "chat-1", title: "讨论", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T01:00:00.000Z", messages: [{ id: "message-1", role: "user", text: "保留图片尺寸" }] }],
      activeChatId: "chat-1", backgroundMode: "lines", showImageInfo: true, viewport: { x: 15.125, y: -24.25, k: 0.875 },
    };
    const first = await put(a, source.id, 0, source);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.document).toMatchObject({ id: source.id, revision: 1, deleted: false, document: source });
    expect((await request("/api/canvas-documents", b)).status).toBe(403);
    const denied = await put(b, source.id, 0, source);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "CANVAS_OWNER_MISMATCH" });
    expect((await request(`/api/canvas-documents/${source.id}`, a, { method: "PUT", body: JSON.stringify({ baseRevision: 1, document: source }) }, b.user.id)).status).toBe(403);
    const races = await Promise.all([put(a, source.id, 1, { ...source, title: "设备一" }), put(a, source.id, 1, { ...source, title: "设备二" })]);
    expect(races.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = await races.find(r => r.status === 200)!.json() as any;
    const conflict = await races.find(r => r.status === 409)!.json() as any;
    expect(conflict).toMatchObject({ error: "CANVAS_REVISION_CONFLICT", document: winner.document });
    const deletedResponse = await put(a, source.id, 2, null);
    expect(deletedResponse.status).toBe(200);
    const deleted = await deletedResponse.json() as any;
    expect(deleted.document).toMatchObject({ revision: 3, deleted: true, document: null });
    handle.kill(); await handle.exited; handle = start(); await ready();
    expect(await request("/api/canvas-documents", a).then(r => r.json())).toEqual({ documents: [deleted.document] });
    for (const revision of [0, 2, 3]) expect((await put(a, source.id, revision, source)).status).toBe(409);
    const downloaded = await request(assetUrl, a);
    expect(await downloaded.bytes()).toEqual(bytes);
    expect((await request(assetUrl, b)).status).toBe(200);
    expect((await request("/api/assets/upload-request", b, { method: "POST", body: JSON.stringify(uploadInput) }, null)).status).toBe(201);
  } finally {
    handle.kill(); await handle.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
