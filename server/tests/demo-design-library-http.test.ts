import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DemoOaStore } from "../src/demo-oa-store";

const temporaryPrefix = "canvas-demo-library-http-";
// Two independently encoded, decoded 1x1 RGBA PNGs have the same byte length.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAADUlEQVR4nGP8z8DwHwAFBQIAgJbjwgAAAABJRU5ErkJggg==", "base64");
const replacementPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAADUlEQVR4nGNk+M/wHwAEBgIAe2BNVAAAAABJRU5ErkJggg==", "base64");
type Employee = ReturnType<DemoOaStore["login"]>;

async function createHarness() {
  const directory = resolve(await mkdtemp(join(tmpdir(), temporaryPrefix)));
  const withinTemporary = relative(resolve(tmpdir()), directory);
  if (isAbsolute(withinTemporary) || withinTemporary !== basename(directory) || !basename(directory).startsWith(temporaryPrefix)) throw new Error("Unverified temporary directory");
  const databasePath = join(directory, "demo.sqlite");
  const oa = new DemoOaStore(databasePath);
  const a = oa.login({ id: "isolated-library-a", name: "员工甲" });
  const b = oa.login({ id: "isolated-library-b", name: "员工乙" });
  oa.close();
  const providerRequests: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    providerRequests.push(request.url);
    return Response.json({ error: "UNEXPECTED_UPSTREAM_REQUEST" }, { status: 503 });
  } });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let origin = "";
  let drained: Promise<unknown> | undefined;
  const stop = async () => {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (child) await child.exited;
    await drained;
    child = undefined;
  };
  const start = async (oaEnabled = true) => {
    await stop();
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop(true);
    origin = `http://127.0.0.1:${port}`;
    const environment: Record<string, string> = {};
    for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"]) {
      if (process.env[name]) environment[name] = process.env[name]!;
    }
    const handle = Bun.spawn([process.execPath, "--no-env-file", "src/demo-server.ts"], {
      cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        ...environment, NODE_ENV: "test", DEMO_HOST: "127.0.0.1", DEMO_PORT: String(port),
        OA_LOGIN_ENABLED: String(oaEnabled), AUTH_ENABLED: String(oaEnabled), LOCAL_STANDALONE: String(!oaEnabled), CREDITS_ENABLED: "false", ROLE_PORTALS_ENABLED: "false",
        DEMO_STATE_PATH: databasePath, DEMO_RECOVERY_FILE: "", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
        OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", OA_USERINFO_URL: "",
        OPENTOKEN_BASE_URL: `${provider.url.origin}/v1`, APIMART_BASE_URL: `${provider.url.origin}/v1`, GPT_IMAGE_2_BASE_URL: `${provider.url.origin}/v1`,
        DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", REDIS_URL: "redis://127.0.0.1:1",
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
      },
    });
    child = handle;
    const output = { stdout: "", stderr: "" };
    const drain = async (stream: ReadableStream<Uint8Array>, key: keyof typeof output) => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) output[key] = `${output[key]}${decoder.decode(bytes, { stream: true })}`.slice(-12000);
    };
    drained = Promise.all([drain(handle.stdout, "stdout"), drain(handle.stderr, "stderr")]);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && handle.exitCode === null) {
      if (output.stdout.includes(origin) && await fetch(origin + "/api/health").then(r => r.ok).catch(() => false)) return;
      await Bun.sleep(40);
    }
    throw new Error(`Isolated library server failed to start: ${output.stdout}\n${output.stderr}`);
  };
  const request = (path: string, employee: Employee | null = a, init: RequestInit = {}, ownerId: string | null = employee?.user.id ?? null) => fetch(origin + path, {
    ...init, signal: AbortSignal.timeout(5000), headers: {
      "content-type": "application/json", ...(employee ? { cookie: `wireless_canvas_demo_session=${employee.token}` } : {}),
      ...(ownerId ? { "x-canvas-owner-id": ownerId } : {}), ...init.headers,
    },
  });
  const post = (path: string, employee: Employee, body: unknown, ownerId: string | null = employee.user.id) => request(path, employee, { method: "POST", body: JSON.stringify(body) }, ownerId);
  const upload = async (employee: Employee, bytes: Uint8Array = png) => {
    const requested = await post("/api/assets/upload-request", employee, { filename: "原始设计.png", mimeType: "image/png", byteSize: bytes.byteLength, metadata: { secretPrompt: "不应自动公开", privateCanvas: "private-canvas" } });
    expect(requested.status).toBe(201);
    const asset = await requested.json() as { assetId: string; uploadUrl: string };
    expect((await request(asset.uploadUrl, employee, { method: "PUT", body: new Uint8Array(bytes) })).status).toBe(204);
    return asset;
  };
  const cleanup = async () => { await stop(); await provider.stop(true); await rm(directory, { recursive: true, force: true }); };
  return { a, b, start, request, post, upload, cleanup, providerRequests };
}

test("demo library persists independent publication and reader copies, authenticates each operation and counts receipts once", async () => {
  const h = await createHarness();
  try {
    await h.start(false);
    const unavailable = await h.request("/api/design-library");
    expect(unavailable.status).toBe(403);
    expect(await unavailable.json()).toMatchObject({ code: 403, error: "DESIGN_LIBRARY_DISABLED" });
    await h.start();
    expect((await h.request("/api/design-library", null)).status).toBe(401);
    expect((await h.request("/api/admin/design-library", h.a)).status).toBe(403);
    const original = new Uint8Array(png);
    const source = await h.upload(h.a, original);
    const input = { title: "春季设计方向", thought: "只公开指定设计思路", prompt: "指定提示词", tags: ["春季", "色彩"], assetIds: [source.assetId], requestId: "publish-1" };
    expect((await h.post("/api/design-library", h.b, input)).status).toBe(403);
    expect((await h.post("/api/design-library", h.a, input, h.b.user.id)).status).toBe(403);
    expect((await h.post("/api/design-library", h.a, input, null)).status).toBe(403);
    const publishedResponse = await h.post("/api/design-library", h.a, input);
    expect(publishedResponse.status).toBe(201);
    expect(publishedResponse.headers.get("cache-control")).toContain("no-store");
    const published = await publishedResponse.json() as any;
    const entry = published.data.entry;
    const image = entry.images[0];
    const entryPath = `/api/design-library/${entry.id}`;
    const imagePath = `${entryPath}/images/${image.id}`;
    expect(entry).toMatchObject({ author: { id: h.a.user.id, name: "员工甲" }, title: input.title, prompt: input.prompt, status: "published" });
    expect(image).toMatchObject({ byteSize: original.byteLength, mimeType: "image/png", width: 1, height: 1 });
    expect(JSON.stringify(published)).not.toContain(source.assetId);
    expect(JSON.stringify(published)).not.toContain("private-canvas");
    expect(JSON.stringify(published)).not.toContain("secretPrompt");
    const duplicate = await h.post("/api/design-library", h.a, input).then(r => r.json()) as any;
    expect(duplicate.data.entry.id).toBe(entry.id);
    expect((await h.post("/api/design-library", h.a, { ...input, title: "变更相同请求" })).status).toBe(409);
    expect((await h.request(`/api/assets/${source.assetId}/content`, h.b)).status).toBe(404);
    expect((await h.request(entryPath, h.b)).status).toBe(200);
    expect((await h.request(`${entryPath}/stats`, h.b)).status).toBe(403);
    expect((await h.post(`${entryPath}/moderate`, h.b, { reason: "伪造管理员" })).status).toBe(403);
    // A valid replacement must not change the independent published snapshot;
    // corrupt same-length input remains rejected without changing the source.
    expect((await h.request(source.uploadUrl, h.a, { method: "PUT", body: new Uint8Array(original.byteLength).fill(7) })).status).toBe(415);
    expect(await h.request(`/api/assets/${source.assetId}/content`, h.a).then(r => r.bytes())).toEqual(original);
    const sourceReplacement = new Uint8Array(replacementPng);
    expect(sourceReplacement.byteLength).toBe(original.byteLength);
    expect(sourceReplacement).not.toEqual(original);
    expect((await h.request(source.uploadUrl, h.a, { method: "PUT", body: sourceReplacement })).status).toBe(204);
    expect(await h.request(`/api/assets/${source.assetId}/content`, h.a).then(r => r.bytes())).toEqual(sourceReplacement);
    expect(await h.request(image.contentUrl, h.b).then(r => r.bytes())).toEqual(original);
    const reuseResponse = await h.post(`${imagePath}/reuse`, h.b, { requestId: "reuse-001" });
    expect(reuseResponse.status).toBe(200);
    const reuse = (await reuseResponse.json() as any).data;
    expect(reuse.assetId).not.toBe(source.assetId);
    expect(reuse.image.contentUrl).toBe(`/api/assets/${reuse.assetId}/content`);
    expect(await h.request(reuse.image.contentUrl, h.b).then(r => r.bytes())).toEqual(original);
    expect((await h.request(reuse.image.contentUrl, h.a)).status).toBe(404);
    expect((await h.post(`${imagePath}/reuse`, h.b, { requestId: "reuse-001" }).then(r => r.json()) as any).data.assetId).toBe(reuse.assetId);
    const zeroStats = (await h.request(`${entryPath}/stats`, h.a).then(r => r.json()) as any).data;
    expect(zeroStats.totals.reuse).toEqual({ count: 0, people: 0 });
    const receipt = (actor: Employee, body: unknown) => h.post(`${entryPath}/events`, actor, body);
    expect((await receipt(h.b, { action: "download", imageId: image.id, requestId: "forged-delivery" })).status).toBe(409);
    expect((await receipt(h.b, { action: "reuse", imageId: image.id, reusedAssetId: source.assetId, requestId: "reuse-001" })).status).toBe(409);
    expect((await receipt(h.a, { action: "view", requestId: "author-view" }).then(r => r.json()) as any).data.recorded).toBe(false);
    for (const requestId of ["view-001", "view-001", "view-002"]) expect((await receipt(h.b, { action: "view", requestId })).status).toBe(200);
    expect((await receipt(h.b, { action: "view", imageId: image.id, requestId: "image-view" })).status).toBe(200);
    expect((await receipt(h.b, { action: "prompt_copy", requestId: "prompt-1" })).status).toBe(200);
    for (const repeat of [0, 1]) expect((await receipt(h.b, { action: "reuse", imageId: image.id, reusedAssetId: reuse.assetId, requestId: "reuse-001" })).status).toBe(200);
    const downloadResponse = await h.post(`${imagePath}/download`, h.b, { requestId: "download-1" });
    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.bytes()).toEqual(original);
    expect((await receipt(h.b, { action: "download", imageId: image.id, requestId: "download-1" })).status).toBe(200);
    const inFlight = await h.post(`${imagePath}/download`, h.b, { requestId: "download-in-flight" });
    expect(await inFlight.bytes()).toEqual(original);
    await h.start();
    expect(await h.request(image.contentUrl, h.b).then(r => r.bytes())).toEqual(original);
    expect(await h.request(reuse.image.contentUrl, h.b).then(r => r.bytes())).toEqual(original);
    const stats = (await h.request(`${entryPath}/stats?page=1&pageSize=1`, h.a).then(r => r.json()) as any).data;
    expect(stats.totals).toEqual({ view: { count: 2, people: 1 }, reuse: { count: 1, people: 1 }, download: { count: 1, people: 1 }, prompt_copy: { count: 1, people: 1 } });
    expect(stats.images[0].counts.view).toEqual({ count: 1, people: 1 });
    expect(stats.activityTotal).toBe(2);
    expect(stats.activity).toHaveLength(1);
    expect(stats.activity[0].actor).toMatchObject({ name: "员工乙" });
    expect(JSON.stringify(stats)).not.toContain("private-canvas");
    expect((await h.post(`${entryPath}/withdraw`, h.b, {})).status).toBe(404);
    expect((await h.post(`${entryPath}/withdraw`, h.a, {})).status).toBe(200);
    expect((await h.post(`${entryPath}/withdraw`, h.a, {})).status).toBe(200);
    expect((await h.request("/api/design-library?scope=company", h.b).then(r => r.json()) as any).data.total).toBe(0);
    expect((await h.request("/api/design-library?scope=mine", h.a).then(r => r.json()) as any).data.items[0].status).toBe("withdrawn");
    expect((await h.request(image.contentUrl, h.b)).status).toBe(404);
    expect((await h.request(entryPath, h.b)).status).toBe(404);
    expect((await h.request(image.contentUrl, h.a)).status).toBe(200);
    expect((await h.post(`${imagePath}/download`, h.b, { requestId: "new-download" })).status).toBe(409);
    expect((await h.post(`${imagePath}/reuse`, h.b, { requestId: "new-reuse" })).status).toBe(409);
    expect((await receipt(h.b, { action: "view", requestId: "new-view" })).status).toBe(409);
    expect((await receipt(h.b, { action: "download", imageId: image.id, requestId: "download-in-flight" })).status).toBe(200);
    expect(await h.request(reuse.image.contentUrl, h.b).then(r => r.bytes())).toEqual(original);
    await h.start();
    expect((await h.request("/api/design-library?scope=company", h.b).then(r => r.json()) as any).data.total).toBe(0);
    expect(await h.request(reuse.image.contentUrl, h.b).then(r => r.bytes())).toEqual(original);
    expect(h.providerRequests).toEqual([]);
  } finally { await h.cleanup(); }
}, 30000);
