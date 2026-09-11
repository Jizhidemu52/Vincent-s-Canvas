import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoStateStore } from "../src/demo-state-store";

const serverDirectory = fileURLToPath(new URL("../", import.meta.url));
const serverEntry = fileURLToPath(new URL("../src/demo-server.ts", import.meta.url));
const temporaryPrefix = "canvas-demo-persistence-api-";
type UploadRequest = { assetId: string; uploadUrl: string | null; reused?: boolean };
type ListedAsset = { id: string; filename: string; byteSize: number; metadata: Record<string, unknown> };
type ApiTask = { id: string; requestId: string; status: string; upstreamTaskId?: string; errorCode?: string; credits: number };

function validateTemporaryDirectory(directory: string) {
  const candidate = resolve(directory);
  const withinTemporary = relative(resolve(tmpdir()), candidate);
  if (!withinTemporary || isAbsolute(withinTemporary) || withinTemporary !== basename(candidate) || !basename(candidate).startsWith(temporaryPrefix)) {
    throw new Error("Refusing to use or remove an unverified test directory");
  }
  return candidate;
}

async function unusedLocalPort() {
  const reservation = createServer();
  await new Promise<void>((accept, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", accept);
  });
  try {
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No isolated test port was assigned");
    return address.port;
  } finally {
    await new Promise<void>((accept, reject) => reservation.close((error) => error ? reject(error) : accept()));
  }
}

async function createHarness() {
  const directory = validateTemporaryDirectory(await mkdtemp(join(tmpdir(), temporaryPrefix)));
  const databasePath = join(directory, "database", "demo.sqlite");
  const providerRequests: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      providerRequests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ error: "UNEXPECTED_UPSTREAM_REQUEST" }, { status: 503 });
    },
  });
  let running: { stop: () => Promise<void>; origin: string } | undefined;

  const stop = async () => {
    const current = running;
    running = undefined;
    if (current) await current.stop();
  };
  const start = async (recoveryFile = "") => {
    await stop();
    const port = await unusedLocalPort();
    const origin = `http://127.0.0.1:${port}`;
    const environment: Record<string, string> = {};
    // Do not inherit credentials or Bun's automatic .env loading from the developer machine.
    for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"]) {
      if (process.env[name]) environment[name] = process.env[name]!;
    }
    const child = Bun.spawn([process.execPath, "--no-env-file", serverEntry], {
      cwd: serverDirectory,
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        ...environment,
        NODE_ENV: "test", DEMO_HOST: "127.0.0.1", DEMO_PORT: String(port),
        LOCAL_STANDALONE: "true", AUTH_ENABLED: "false", CREDITS_ENABLED: "false", ROLE_PORTALS_ENABLED: "false",
        DEMO_STATE_PATH: databasePath, DEMO_RECOVERY_FILE: recoveryFile,
        APIMART_API_KEY: "", OPENTOKEN_API_KEY: "", GPT_IMAGE_2_API_KEY: "",
        APIMART_BASE_URL: `${provider.url.origin}/v1`, OPENTOKEN_BASE_URL: `${provider.url.origin}/v1`, GPT_IMAGE_2_BASE_URL: `${provider.url.origin}/v1`,
        DEMO_PUBLIC_ASSET_ORIGIN: "", STANDALONE_WEB_DIR: "",
        DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", REDIS_URL: "redis://127.0.0.1:1",
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
      },
    });
    const output = { stdout: "", stderr: "" };
    const drain = async (stream: ReadableStream<Uint8Array>, key: keyof typeof output) => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) output[key] = `${output[key]}${decoder.decode(bytes, { stream: true })}`.slice(-12_000);
    };
    const drained = Promise.all([drain(child.stdout, "stdout"), drain(child.stderr, "stderr")]);
    const shutdown = async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await drained;
    };
    running = { stop: shutdown, origin };
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Isolated demo exited (${child.exitCode})`);
        if (output.stdout.includes(origin)) {
          const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(750) }).catch(() => null);
          if (response?.ok && (await response.json()).mode === "local-demo") return;
        }
        await Bun.sleep(40);
      }
      throw new Error("Isolated demo did not become ready within 15 seconds");
    } catch (error) {
      await stop();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.stdout}\n${output.stderr}`);
    }
  };
  const request = async (path: string, init: RequestInit = {}) => {
    if (!running) throw new Error("Isolated demo is not running");
    return fetch(new URL(path, running.origin), { ...init, signal: AbortSignal.timeout(5_000) });
  };
  const json = async <T>(path: string, method = "GET", body?: unknown, expectedStatus = 200): Promise<T> => {
    const response = await request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (response.status !== expectedStatus) throw new Error(`${method} ${path}: expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(value)}`);
    return value as T;
  };
  const deferredRequest = async (path: string, method: string, body: Uint8Array, contentType: string) => {
    if (!running) throw new Error("Isolated demo is not running");
    let client: ReturnType<typeof httpRequest>;
    const response = new Promise<{ status: number; body: string }>((accept, reject) => {
      client = httpRequest(new URL(path, running!.origin), { method, headers: { "content-type": contentType, "content-length": body.byteLength } }, (result) => {
        const chunks: Buffer[] = [];
        result.on("data", (chunk: Buffer) => chunks.push(chunk));
        result.once("error", reject);
        result.once("end", () => accept({ status: result.statusCode || 500, body: Buffer.concat(chunks).toString("utf8") }));
      });
      client.once("error", reject);
      client.setTimeout(5_000, () => client.destroy(new Error("Deferred test request timed out")));
    });
    const split = Math.max(1, Math.floor(body.byteLength / 2));
    await new Promise<void>((accept, reject) => client!.write(body.subarray(0, split), (error) => error ? reject(error) : accept()));
    // Headers plus a partial body enter the real handler, while json()/arrayBuffer() remain pending.
    await Bun.sleep(75);
    return {
      response,
      release() { client!.end(body.subarray(split)); },
      async cancel() {
        client!.destroy();
        await response.catch(() => {}); // Expected socket cancellation during test cleanup.
      },
    };
  };
  return {
    directory, databasePath, providerRequests, start, stop, request, json, deferredRequest,
    async close() {
      try { await stop(); }
      finally {
        await provider.stop(true);
        await rm(validateTemporaryDirectory(directory), { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
      }
    },
  };
}

test("real demo HTTP uploads, metadata and unfinished upload reservations survive abrupt restarts", async () => {
  const demo = await createHarness();
  const bytes = new TextEncoder().encode("原始说明\n第二行，UTF-8 字节必须保持不变。\n");
  const laterBytes = new TextEncoder().encode("重启后完成上传的占位素材");
  const originalMetadata = { title: "上传说明", tags: ["初稿"], source: "集成测试", note: "原备注" };
  const updatedMetadata = { title: "修订说明", tags: ["已核对", "文本"], source: "本地持久化", note: "重启后仍保留" };
  const uploadInput = { filename: "原始说明.txt", mimeType: "text/plain", byteSize: bytes.byteLength, clientReferenceId: "text-original", metadata: originalMetadata };
  const reservationInput = { filename: "待上传.txt", mimeType: "text/plain", byteSize: laterBytes.byteLength, clientReferenceId: "unfinished-upload" };
  try {
    await demo.start();
    const uploaded = await demo.json<UploadRequest>("/api/assets/upload-request", "POST", uploadInput, 201);
    expect(uploaded.uploadUrl).toBe(`/api/assets/${uploaded.assetId}/content-upload`);
    expect((await demo.request(uploaded.uploadUrl!, { method: "PUT", body: bytes })).status).toBe(204);
    expect((await demo.request(`/api/assets/${uploaded.assetId}/metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(updatedMetadata) })).status).toBe(204);
    const reservation = await demo.json<UploadRequest>("/api/assets/upload-request", "POST", reservationInput, 201);

    await demo.start(); // SIGKILL, same SQLite database, a fresh ephemeral port.
    const content = await demo.request(`/api/assets/${uploaded.assetId}/content`);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
    const assets = await demo.json<{ assets: ListedAsset[] }>("/api/assets");
    expect(assets.assets).toHaveLength(1);
    expect(assets.assets[0]).toMatchObject({ id: uploaded.assetId, filename: uploadInput.filename, byteSize: bytes.byteLength, metadata: { ...updatedMetadata, content: new TextDecoder().decode(bytes) } });
    expect(await demo.json<UploadRequest>("/api/assets/upload-request", "POST", uploadInput, 201)).toEqual({ assetId: uploaded.assetId, uploadUrl: null, reused: true });
    expect((await demo.request(`/api/assets/${reservation.assetId}/content`)).status).toBe(404);
    const resumed = await demo.json<UploadRequest>("/api/assets/upload-request", "POST", reservationInput, 201);
    expect(resumed).toEqual({ assetId: reservation.assetId, uploadUrl: reservation.uploadUrl, reused: true });
    expect((await demo.request(resumed.uploadUrl!, { method: "PUT", body: laterBytes })).status).toBe(204);

    await demo.start();
    expect(new Uint8Array(await (await demo.request(`/api/assets/${reservation.assetId}/content`)).arrayBuffer())).toEqual(laterBytes);
    expect((await demo.json<{ assets: ListedAsset[] }>("/api/assets")).assets.map((item) => item.id).sort()).toEqual([uploaded.assetId, reservation.assetId].sort());
    expect(demo.providerRequests).toEqual([]);
  } finally { await demo.close(); }
}, 60_000);

test("restart pauses stored paid work, deduplicates before provider checks and ignores stale recovery snapshots", async () => {
  const demo = await createHarness();
  try {
    await demo.start();
    const { user } = await demo.json<{ user: { id: string; creditBalance: number } }>("/api/auth/session");
    await demo.stop();
    const savedAsset = { id: crypto.randomUUID(), ownerUserId: user.id, filename: "durable.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("durable original bytes"), createdAt: new Date().toISOString(), metadata: { title: "当前素材" } };
    const interrupted = {
      id: crypto.randomUUID(), requestId: "paid-once-request", ownerUserId: user.id, operationType: "video_generation",
      status: "processing" as const, stage: "polling", providerModel: "wan2.7", upstreamTaskId: "original-upstream-task",
      submissionStartedAt: "2026-09-11T00:00:00.000Z", createdAt: "2026-09-11T00:00:00.000Z",
      credits: 0, resultUrls: [], failureReason: null, prompt: "must never be resubmitted", parameters: { seconds: 6 },
    };
    const store = new DemoStateStore(demo.databasePath);
    try { store.save({ assets: [savedAsset], tasks: [interrupted] }); }
    finally { store.close(); }

    await demo.start();
    const recovered = await demo.json<{ task: ApiTask }>(`/api/tasks/${interrupted.id}`);
    expect(recovered.task).toMatchObject({ id: interrupted.id, requestId: interrupted.requestId, status: "paused", upstreamTaskId: interrupted.upstreamTaskId, errorCode: "LOCAL_PROCESS_INTERRUPTED", credits: 0 });
    const duplicateBody = { requestId: interrupted.requestId, operationType: "video_generation", modelConfigId: "provider-is-deliberately-unconfigured", prompt: "must not create another task" };
    expect(await demo.json<{ task: ApiTask }>("/api/tasks", "POST", duplicateBody)).toEqual(recovered);
    expect((await demo.json<{ tasks: ApiTask[] }>("/api/tasks")).tasks).toHaveLength(1);
    expect((await demo.json<{ user: { creditBalance: number } }>("/api/auth/session")).user.creditBalance).toBe(user.creditBalance);
    expect((await demo.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...duplicateBody, requestId: "new-disabled-request" }) })).status).toBe(503);
    // The existing video polling loop waits two seconds before its first GET.
    await Bun.sleep(2_200);
    expect(demo.providerRequests).toEqual([]);

    const snapshotPath = join(demo.directory, "stale-recovery.json");
    await writeFile(snapshotPath, JSON.stringify({
      assets: [{ ...savedAsset, bytes: undefined, base64: Buffer.from("stale overwritten bytes").toString("base64"), metadata: { title: "旧快照不得覆盖" } }],
      tasks: [{ ...interrupted, status: "success", resultUrls: ["https://must-not-appear.invalid/stale.mp4"] }],
    }), "utf8");
    for (let restart = 0; restart < 2; restart++) {
      await demo.start(snapshotPath);
      expect(await demo.json<{ task: ApiTask }>(`/api/tasks/${interrupted.id}`)).toEqual(recovered);
      expect(await demo.json<{ task: ApiTask }>("/api/tasks", "POST", duplicateBody)).toEqual(recovered);
      expect(new Uint8Array(await (await demo.request(`/api/assets/${savedAsset.id}/content`)).arrayBuffer())).toEqual(savedAsset.bytes);
      expect((await demo.json<{ assets: ListedAsset[] }>("/api/assets")).assets).toHaveLength(1);
      expect((await demo.json<{ tasks: ApiTask[] }>("/api/tasks")).tasks).toHaveLength(1);
    }
    expect(demo.providerRequests).toEqual([]);
  } finally { await demo.close(); }
}, 60_000);

test("delayed metadata and upload bodies cannot overwrite each other's committed bytes or fields", async () => {
  const demo = await createHarness();
  const bytes = new TextEncoder().encode("交错上传也必须保留原始字节");
  const metadata = { title: "交错保存名称", tags: ["必须保留"], source: "HTTP 回归", note: "不能覆盖已经完成的写入" };
  try {
    await demo.start();
    for (const delayedMethod of ["PATCH", "PUT"]) {
      const upload = await demo.json<UploadRequest>("/api/assets/upload-request", "POST", { filename: `${delayedMethod}.txt`, mimeType: "text/plain", byteSize: bytes.byteLength }, 201);
      const metadataPath = `/api/assets/${upload.assetId}/metadata`;
      const deferred = delayedMethod === "PATCH"
        ? await demo.deferredRequest(metadataPath, "PATCH", new TextEncoder().encode(JSON.stringify(metadata)), "application/json")
        : await demo.deferredRequest(upload.uploadUrl!, "PUT", bytes, "text/plain");
      try {
        if (delayedMethod === "PATCH") expect((await demo.request(upload.uploadUrl!, { method: "PUT", body: bytes })).status).toBe(204);
        else expect((await demo.request(metadataPath, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) })).status).toBe(204);
        deferred.release();
        expect((await deferred.response).status).toBe(204);
        expect(new Uint8Array(await (await demo.request(`/api/assets/${upload.assetId}/content`)).arrayBuffer())).toEqual(bytes);
        expect((await demo.json<{ assets: ListedAsset[] }>("/api/assets")).assets.find((item) => item.id === upload.assetId)?.metadata).toEqual({ ...metadata, content: new TextDecoder().decode(bytes) });
      } finally { await deferred.cancel(); }
    }
    await demo.start();
    const persisted = await demo.json<{ assets: ListedAsset[] }>("/api/assets");
    expect(persisted.assets).toHaveLength(2);
    for (const item of persisted.assets) {
      expect(new Uint8Array(await (await demo.request(`/api/assets/${item.id}/content`)).arrayBuffer())).toEqual(bytes);
      expect(item.metadata).toEqual({ ...metadata, content: new TextDecoder().decode(bytes) });
    }
    expect(demo.providerRequests).toEqual([]);
  } finally { await demo.close(); }
}, 60_000);

test("SQLite rejected writes return 503 and leave both original asset bytes and metadata unchanged", async () => {
  const demo = await createHarness();
  const originalBytes = new TextEncoder().encode("keep original bytes");
  const replacementBytes = new Uint8Array(originalBytes.byteLength).fill(120);
  const originalMetadata = { title: "不能丢失", tags: ["原始"], source: "本地", note: "拒写前的备注" };
  try {
    await demo.start();
    const upload = await demo.json<UploadRequest>("/api/assets/upload-request", "POST", { filename: "durable.txt", mimeType: "text/plain", byteSize: originalBytes.byteLength, metadata: originalMetadata }, 201);
    expect((await demo.request(upload.uploadUrl!, { method: "PUT", body: originalBytes })).status).toBe(204);
    const storageFault = new Database(demo.databasePath);
    try {
      storageFault.exec("CREATE TRIGGER test_reject_asset_updates BEFORE UPDATE ON demo_assets BEGIN SELECT RAISE(ABORT, 'test storage write rejected'); END;");
      const rejectedUpload = await demo.request(upload.uploadUrl!, { method: "PUT", body: replacementBytes });
      expect(rejectedUpload.status).toBe(503);
      expect(await rejectedUpload.json()).toMatchObject({ error: "LOCAL_STORAGE_UNAVAILABLE" });
      const rejectedMetadata = await demo.request(`/api/assets/${upload.assetId}/metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...originalMetadata, title: "must not be saved" }) });
      expect(rejectedMetadata.status).toBe(503);
      expect(await rejectedMetadata.json()).toMatchObject({ error: "LOCAL_STORAGE_UNAVAILABLE" });
      expect(new Uint8Array(await (await demo.request(`/api/assets/${upload.assetId}/content`)).arrayBuffer())).toEqual(originalBytes);
      expect((await demo.json<{ assets: ListedAsset[] }>("/api/assets")).assets[0]?.metadata).toEqual({ ...originalMetadata, content: new TextDecoder().decode(originalBytes) });
    } finally {
      try { storageFault.exec("DROP TRIGGER IF EXISTS test_reject_asset_updates"); }
      finally { storageFault.close(true); }
    }
    await demo.start();
    expect(new Uint8Array(await (await demo.request(`/api/assets/${upload.assetId}/content`)).arrayBuffer())).toEqual(originalBytes);
    expect((await demo.json<{ assets: ListedAsset[] }>("/api/assets")).assets[0]?.metadata).toEqual({ ...originalMetadata, content: new TextDecoder().decode(originalBytes) });
    expect(demo.providerRequests).toEqual([]);
  } finally { await demo.close(); }
}, 60_000);
