import { expect, test } from "bun:test";
import express from "express";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { LAYER_STUDIO_MAX_REFERENCE_BYTES } from "../../shared/layer-studio-options";
import { APIMART_IMAGE_MAX_BYTES } from "../src/apimart-upload";
import type { Cache, Database } from "../src/db";
import type { ObjectReadOptions, ObjectStorage } from "../src/object-storage";
import { normalizeProviderImageOrigin, ProviderImageAccess, PROVIDER_IMAGE_PATH } from "../src/provider-image-access";
import { createProviderImagesRouter } from "../src/routes/provider-images";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
const assetId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
const otherUserId = "00000000-0000-4000-8000-000000000004";
const origin = "http://ai.in-choice.com.cn";
const seedreamRoute = { toolKey: "layer-studio", modelId: "seedream-5-5", protocol: "apimart" };
const standardMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const extendedMimes = ["image/bmp", "image/tiff", "image/heic", "image/heif"];
const exec = promisify(execFile);
const references = new Map<string, Promise<Buffer>>();

async function imageReference(mimeType: string) {
  let pending = references.get(mimeType);
  if (!pending) {
    pending = (async () => {
      if (mimeType === "image/heic" || mimeType === "image/heif") {
        const bytes = Buffer.from(await Bun.file(new URL("./fixtures/seedream55-reference.heic", import.meta.url)).arrayBuffer());
        if (mimeType === "image/heif") bytes.write("mif1", 8, "ascii");
        return bytes;
      }
      const codecs: Record<string, string> = { "image/jpeg": "mjpeg", "image/png": "png", "image/webp": "libwebp", "image/gif": "gif", "image/bmp": "bmp", "image/tiff": "tiff" };
      const { stdout } = await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x32", "-frames:v", "1", "-c:v", codecs[mimeType]!, "-threads", "1", "-f", "image2pipe", "pipe:1"],
        { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
      return stdout;
    })();
    references.set(mimeType, pending);
  }
  return pending;
}

function fixture() {
  const state = {
    owner: userId, user: userId, userStatus: "active", userDeleted: false, assetStatus: "ready", deleted: false, kind: "image", status: "processing",
    objectKey: "private/employee/original.png", mimeType: "image/png", byteSize: png.length,
    toolKey: null as string | null, modelId: null as string | null, protocol: null as string | null, operationType: "inpaint",
    sourceUrls: [`/api/assets/${assetId}/content`], executionToken: "current-worker", leaseValid: true,
    etag: '"original-etag"', bytes: Buffer.from(png), cacheFailure: false, dbFailure: false, storageFailure: false,
  };
  const records = new Map<string, string>();
  const reads: ObjectReadOptions[] = [];
  const writes: Array<{ value: string; options?: { EX: number } }> = [];
  const queries: string[] = [];
  let onGet: (() => void) | undefined;
  const db = { query: async (sql: string, params: unknown[]) => {
    queries.push(sql);
    if (state.dbFailure) throw new Error("sensitive DB detail");
    const [task, user, asset, key, sources, executionToken] = params;
    const eligible = task === taskId && user === state.user && asset === assetId && user === state.owner
      && key === state.objectKey && state.assetStatus === "ready" && !state.deleted
      && (state.kind === "image" || state.operationType === "video_generation" && state.protocol === "apimart" && ["video", "other"].includes(state.kind))
      && state.userStatus === "active" && !state.userDeleted
      && state.status === "processing" && JSON.parse(String(sources)).every((url: string) => state.sourceUrls.includes(url))
      && (executionToken === undefined || state.executionToken === executionToken && state.leaseValid);
    return { rows: eligible ? [{ object_key: state.objectKey, mime_type: state.mimeType, filename: "员工原件.png", byte_size: state.byteSize,
      tool_key: state.toolKey, model_id: state.modelId, protocol: state.protocol, operation_type: state.operationType, kind: state.kind }] : [] };
  } } as unknown as Pick<Database, "query">;
  const cache: Pick<Cache, "get" | "set"> = {
    get: async key => { if (state.cacheFailure) throw new Error("sensitive redis detail"); return records.get(key) ?? null; },
    set: async (key, value, options) => {
      if (state.cacheFailure) throw new Error("sensitive redis detail");
      records.set(key, value); writes.push({ value, options }); return "OK";
    },
  };
  const storage = {
    head: async (key: string) => {
      if (state.storageFailure) throw new Error("sensitive storage detail");
      expect(key).toBe(state.objectKey);
      return { ETag: state.etag, ContentLength: state.bytes.length, LastModified: new Date("2026-01-01T00:00:00Z") };
    },
    get: async (key: string, options: ObjectReadOptions = {}) => {
      if (state.storageFailure) throw new Error("sensitive storage detail");
      expect(key).toBe(state.objectKey);
      reads.push(options);
      if (options.ifMatch !== state.etag) throw new Error("precondition failure");
      const range = /^bytes=(\d+)-(\d+)$/.exec(options.range || "");
      const start = range ? Number(range[1]) : 0;
      const end = range ? Number(range[2]) : state.bytes.length - 1;
      const bytes = state.bytes.subarray(start, end + 1);
      onGet?.();
      return { Body: Readable.from([bytes]), ETag: state.etag, ContentLength: bytes.length,
        ...(range ? { ContentRange: `bytes ${start}-${end}/${state.bytes.length}` } : {}) };
    },
  } as unknown as ObjectStorage;
  const access = new ProviderImageAccess(db, cache, storage, origin);
  const input = { taskId, userId, executionToken: state.executionToken,
    source: { assetId, objectKey: state.objectKey, bytes: png, mimeType: "image/png", filename: "员工原件.png", etag: state.etag as string | undefined } };
  return { state, records, writes, reads, queries, access, input, storage, onGet: (callback: () => void) => { onGet = callback; } };
}

function setReference(f: ReturnType<typeof fixture>, bytes: Buffer, mimeType: string) {
  Object.assign(f.state, { bytes: Buffer.from(bytes), byteSize: bytes.length, mimeType });
  Object.assign(f.input.source, { bytes, mimeType });
}

async function withServer(f: ReturnType<typeof fixture>, run: (base: string) => Promise<void>) {
  const app = express();
  app.use(PROVIDER_IMAGE_PATH, createProviderImagesRouter(f.access, f.storage));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const pathOf = (url: string) => new URL(url).pathname;
const tokenOf = (url: string) => pathOf(url).split("/")[3]!;

test.each(["video/mp4", "audio/wav"])("owned video generation %s grants stream the exact ETag-bound original via public HTTP", async mime => {
  const f = fixture();
  const video = mime.startsWith("video/");
  const { stdout } = await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    video ? "color=c=blue:s=64x32:r=24" : "sine=frequency=440:sample_rate=8000", "-t", "1",
    ...(video ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov"] : ["-c:a", "pcm_s16le"]),
    "-threads", "1", "-f", video ? "mp4" : "wav", "pipe:1"], { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
  Object.assign(f.state, { operationType: "video_generation", protocol: "apimart", modelId: "doubao-seedance-2.5", kind: video ? "video" : "other" });
  setReference(f, stdout, mime);
  const input = { taskId, userId, executionToken: f.state.executionToken,
    source: { assetId, objectKey: f.state.objectKey, byteSize: stdout.length, mimeType: mime, etag: f.state.etag } };
  const url = await f.access.issueMedia(input);
  expect(url).toMatch(/^http:\/\/ai\.in-choice\.com\.cn\/api\/provider-images\/[a-f0-9]{64}\/media$/);
  expect(f.writes[0]!.options).toEqual({ EX: 1800 });
  await withServer(f, async base => {
    const response = await fetch(base + pathOf(url));
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(Buffer.from(await response.arrayBuffer())).toEqual(stdout);
    const range = await fetch(base + pathOf(url), { headers: { Range: "bytes=3-18" } });
    expect(range.status).toBe(206); expect(Buffer.from(await range.arrayBuffer())).toEqual(stdout.subarray(3, 19));
    const head = await fetch(base + pathOf(url), { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(stdout.length));
  });
  f.state.executionToken = ""; f.state.leaseValid = false;
  expect((await f.access.resolve(tokenOf(url))).expectedObject.length).toBe(stdout.length);
  await expect(f.access.issueMedia(input)).rejects.toMatchObject({ status: 404 });
  f.state.status = "cancelled";
  await expect(f.access.resolve(tokenOf(url))).rejects.toMatchObject({ status: 404 });
});

test("video grants reject route/owner/source/lease/ETag changes and never widen ordinary image grants", async () => {
  const create = () => {
    const f = fixture();
    Object.assign(f.state, { operationType: "video_generation", protocol: "apimart", modelId: "doubao-seedance-2.5", kind: "video", mimeType: "video/mp4" });
    const input = { taskId, userId, executionToken: f.state.executionToken,
      source: { assetId, objectKey: f.state.objectKey, byteSize: png.length, mimeType: "video/mp4", etag: f.state.etag } };
    return { f, input };
  };
  for (const change of [{ operationType: "inpaint" }, { protocol: "openai" }, { modelId: "gpt-image-2" }, { kind: "other" },
    { owner: otherUserId }, { deleted: true }, { sourceUrls: [] }, { userStatus: "disabled" }, { byteSize: 0 }]) {
    const { f, input } = create(); const token = tokenOf(await f.access.issueMedia(input)); Object.assign(f.state, change);
    await expect(f.access.issueMedia(input)).rejects.toMatchObject({ status: 404 });
    await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
  }
  const stale = create(); stale.input.source.etag = '"stale"';
  await expect(stale.f.access.issueMedia(stale.input)).rejects.toMatchObject({ status: 404 }); expect(stale.f.writes).toHaveLength(0);
  const image = fixture();
  await expect(image.access.issueMedia({ taskId, userId, executionToken: image.state.executionToken,
    source: { assetId, objectKey: image.state.objectKey, byteSize: png.length, mimeType: "image/png", etag: image.state.etag } })).rejects.toMatchObject({ status: 404 });
});

test("public origin accepts HTTP without signatures, rejects credentials/private hosts/path/query", () => {
  expect(normalizeProviderImageOrigin()).toBe("");
  expect(normalizeProviderImageOrigin("  HTTP://ai.in-choice.com.cn/  ")).toBe(origin);
  expect(normalizeProviderImageOrigin("https://images.example.com:8443")).toBe("https://images.example.com:8443");
  for (const value of ["http://localhost", "http://127.0.0.1", "http://192.168.1.2", "http://files.internal", "ftp://images.example.com",
    "http://user:password@images.example.com", `${origin}/images`, `${origin}?secret=1`, `${origin}#fragment`]) {
    expect(() => normalizeProviderImageOrigin(value)).toThrow();
  }
});

test("issuance binds task/owner/source/active lease and stores only expiring metadata", async () => {
  const f = fixture();
  const url = await f.access.issue(f.input);
  expect(url).toMatch(/^http:\/\/ai\.in-choice\.com\.cn\/api\/provider-images\/[a-f0-9]{64}\/image$/);
  expect(url).not.toContain(assetId);
  expect(f.writes[0]!.options).toEqual({ EX: 1800 });
  expect(JSON.parse(f.writes[0]!.value).expiresAt).toBeGreaterThan(Date.now() + 1_790_000);
  expect(f.writes[0]!.value).not.toContain(png.toString("base64"));
  for (const condition of ["a.owner_user_id=$2", "a.object_key=$4", "a.status='ready'", "a.deleted_at IS NULL", "a.kind='image'",
    "t.user_id=$2", "t.status='processing'", "t.source_urls @> $5::jsonb", "t.execution_token=$6", "t.lease_expires_at>now()"])
    expect(f.queries[0]).toContain(condition);
  expect(await f.access.issue(f.input)).not.toBe(url);
});

test("real HTTP GET/HEAD/Range return the exact original bytes repeatedly, never cached", async () => {
  const f = fixture();
  const path = pathOf(await f.access.issue(f.input));
  await withServer(f, async base => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    }
    const head = await fetch(base + path, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(png.length));
    expect(head.headers.get("cache-control")).toBe("no-store"); expect(await head.text()).toBe("");
    const range = await fetch(base + path, { headers: { Range: "bytes=3-18" } });
    expect(range.status).toBe(206); expect(range.headers.get("content-range")).toBe(`bytes 3-18/${png.length}`);
    expect(range.headers.get("cache-control")).toBe("no-store"); expect(Buffer.from(await range.arrayBuffer())).toEqual(png.subarray(3, 19));
    const conditional = await fetch(base + path, { headers: { "If-None-Match": f.state.etag } });
    expect(conditional.status).toBe(304); expect(conditional.headers.get("cache-control")).toBe("no-store");
    const unsatisfiable = await fetch(base + path, { headers: { Range: "bytes=99999-" } });
    expect(unsatisfiable.status).toBe(416); expect(unsatisfiable.headers.get("cache-control")).toBe("no-store");
  });
  expect(f.reads.every(read => read.ifMatch === f.input.source.etag)).toBe(true);
});

test("normal async polling may release a worker lease without revoking its live grant", async () => {
  const f = fixture(); const token = tokenOf(await f.access.issue(f.input));
  f.state.executionToken = ""; f.state.leaseValid = false;
  expect((await f.access.resolve(token)).expectedObject.length).toBe(png.length);
  await expect(f.access.issue(f.input)).rejects.toMatchObject({ status: 404 });
});

test("disabled or deleted employee access revokes both new and existing grants", async () => {
  const f = fixture(); const token = tokenOf(await f.access.issue(f.input));
  expect(f.queries[0]).toContain("u.status='active' AND u.deleted_at IS NULL");
  for (const state of [{ userStatus: "disabled", userDeleted: false }, { userStatus: "locked", userDeleted: false }, { userStatus: "active", userDeleted: true }]) {
    Object.assign(f.state, state);
    await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
    await expect(f.access.issue(f.input)).rejects.toMatchObject({ status: 404 });
  }
});

test("expired/unknown/malformed grants and bare asset IDs fail closed without any public lookup", async () => {
  const f = fixture(); const path = pathOf(await f.access.issue(f.input));
  const [key, value] = [...f.records][0]!;
  f.records.set(key, JSON.stringify({ ...JSON.parse(value), expiresAt: Date.now() - 1 }));
  await withServer(f, async base => {
    for (const testPath of [path, `${PROVIDER_IMAGE_PATH}/${assetId}/image`, `${PROVIDER_IMAGE_PATH}/${"a".repeat(64)}/image`, `${PROVIDER_IMAGE_PATH}/bad/image`, PROVIDER_IMAGE_PATH]) {
      const response = await fetch(base + testPath); expect(response.status).toBe(404);
    }
  });
  expect(f.queries).toHaveLength(2); // issuance only; invalid/expired paths never reach SQL
});

test("ownership/deletion/source membership/object replacement and task cancellation revoke grants", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.state.owner = otherUserId; }, f => { f.state.user = otherUserId; }, f => { f.state.deleted = true; },
    f => { f.state.assetStatus = "uploading"; }, f => { f.state.kind = "video"; }, f => { f.state.sourceUrls = []; },
    f => { f.state.objectKey = "different/private-object.png"; }, f => { f.state.status = "cancelled"; },
    f => { f.state.status = "success"; }, f => { f.state.byteSize++; }, f => { f.state.mimeType = "image/jpeg"; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); const path = pathOf(await f.access.issue(f.input)); mutate(f);
    await withServer(f, async base => {
      const response = await fetch(base + path, { headers: { "If-None-Match": f.state.etag } });
      expect(response.status).toBe(404); expect(await response.text()).toBe("");
    });
    await expect(f.access.issue(f.input)).rejects.toThrow();
  }
});

test("changed storage ETag/length and mutation during GET never serve replacement bytes", async () => {
  for (const change of ["etag", "length", "delete-during-get"] as const) {
    const f = fixture(); const path = pathOf(await f.access.issue(f.input));
    if (change === "etag") f.state.etag = '"replacement"';
    else if (change === "length") f.state.bytes = Buffer.concat([png, Buffer.from("replacement")]);
    else f.onGet(() => { f.state.deleted = true; });
    await withServer(f, async base => {
      const response = await fetch(base + path);
      expect(response.status).toBe(change === "delete-during-get" ? 404 : 503);
      expect(await response.text()).toBe(""); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-disposition")).toBeNull(); expect(response.headers.get("etag")).toBeNull();
    });
  }
});

test("cache/DB/storage failures expose no sensitive details and never fall back to public assets", async () => {
  for (const failure of ["cacheFailure", "dbFailure", "storageFailure"] as const) {
    const f = fixture(); const path = pathOf(await f.access.issue(f.input)); f.state[failure] = true;
    await withServer(f, async base => {
      const response = await fetch(base + path); expect(response.status).toBe(503);
      expect(await response.text()).toBe(""); expect(response.headers.get("location")).toBeNull();
    });
    await expect(f.access.issue(f.input)).rejects.toMatchObject({ status: 503 });
  }
});

test("issuance rejects stale ETags, expired leases, non-images and unverifiable original bytes", async () => {
  const stale = fixture(); stale.input.source.etag = '"stale"';
  await expect(stale.access.issue(stale.input)).rejects.toMatchObject({ status: 404 });
  const lease = fixture(); lease.state.leaseValid = false;
  await expect(lease.access.issue(lease.input)).rejects.toMatchObject({ status: 404 });
  const invalid = fixture(); invalid.input.source.bytes = Buffer.from("<html>fake image</html>");
  await expect(invalid.access.issue(invalid.input)).rejects.toThrow();
  const missing = fixture(); missing.input.source.etag = undefined;
  expect(await missing.access.issue(missing.input)).toStartWith(origin);
  expect(missing.reads).toHaveLength(1);
  const different = fixture(); different.input.source.etag = undefined; different.state.bytes[40] ^= 1;
  await expect(different.access.issue(different.input)).rejects.toMatchObject({ status: 404 });
  expect(different.writes).toHaveLength(0);
});

test.each([...standardMimes, ...extendedMimes])("only the persisted Seedream 5.5 route grants and serves original %s bytes", async mimeType => {
  const f = fixture(), bytes = await imageReference(mimeType);
  Object.assign(f.state, seedreamRoute); setReference(f, bytes, mimeType);
  const path = pathOf(await f.access.issue(f.input));
  expect(f.queries[0]).toContain("t.tool_key,m.model_id,p.protocol");
  expect(f.queries[0]).toContain("LEFT JOIN model_configs m ON m.id=t.model_config_id LEFT JOIN providers p ON p.id=m.provider_id");
  expect(JSON.parse(f.writes[0]!.value)).toMatchObject({ mimeType, length: bytes.length });
  expect(f.writes[0]!.options).toEqual({ EX: 1800 });
  await withServer(f, async base => {
    const response = await fetch(base + path);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe(mimeType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    const range = await fetch(base + path, { headers: { Range: "bytes=3-18" } });
    expect(range.status).toBe(206); expect(Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(3, 19))).toBe(true);
    const head = await fetch(base + path, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(await head.text()).toBe("");
  });
}, 30_000);

test.each(standardMimes)("ordinary tasks retain original %s grants without a Seedream route", async mimeType => {
  const f = fixture(), bytes = await imageReference(mimeType); setReference(f, bytes, mimeType);
  const token = tokenOf(await f.access.issue(f.input));
  expect((await f.access.resolve(token)).asset.mime_type).toBe(mimeType);
});

test.each(extendedMimes)("ordinary tasks reject %s despite caller-supplied Seedream policy flags", async mimeType => {
  const f = fixture(); setReference(f, await imageReference(mimeType), mimeType);
  Object.assign(f.input, { referencePolicy: "seedream55", toolKey: "layer-studio", modelId: "seedream-5-5", protocol: "apimart" });
  await expect(f.access.issue(f.input)).rejects.toThrow("JPEG、PNG、WebP 或 GIF");
  expect(f.writes).toHaveLength(0);
});

test("all three persisted task route fields are required; route changes revoke extended grants", async () => {
  const bytes = await imageReference("image/bmp");
  for (const route of [{ toolKey: "image-edit" }, { toolKey: null }, { modelId: "seedream-5-0" }, { modelId: null }, { protocol: "openai" }, { protocol: null }]) {
    const f = fixture(); Object.assign(f.state, seedreamRoute); setReference(f, bytes, "image/bmp");
    const token = tokenOf(await f.access.issue(f.input));
    Object.assign(f.state, route);
    await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
    await expect(f.access.issue(f.input)).rejects.toThrow("JPEG、PNG、WebP 或 GIF");
    expect(f.writes).toHaveLength(1);
  }
});

test("Seedream keeps the 30 MiB limit while the same original PNG exceeds ordinary 20 MiB policy", async () => {
  const { stdout: bytes } = await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=3000x3000", "-frames:v", "1", "-c:v", "png", "-compression_level", "0", "-threads", "1", "-f", "image2pipe", "pipe:1"],
    { encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer: LAYER_STUDIO_MAX_REFERENCE_BYTES });
  expect(bytes.length).toBeGreaterThan(APIMART_IMAGE_MAX_BYTES); expect(bytes.length).toBeLessThanOrEqual(LAYER_STUDIO_MAX_REFERENCE_BYTES);
  const f = fixture(); Object.assign(f.state, seedreamRoute); setReference(f, bytes, "image/png");
  const token = tokenOf(await f.access.issue(f.input));
  expect((await f.access.resolve(token)).expectedObject.length).toBe(bytes.length);
  f.state.toolKey = "image-edit";
  await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
  await expect(f.access.issue(f.input)).rejects.toThrow("20MB");
  Object.assign(f.state, seedreamRoute); setReference(f, Buffer.alloc(LAYER_STUDIO_MAX_REFERENCE_BYTES + 1), "image/png");
  await expect(f.access.issue(f.input)).rejects.toThrow("30 MiB");
  expect(f.writes).toHaveLength(1);
}, 30_000);

test("cached grant metadata cannot widen ordinary MIME or byte limits, even with forged policy flags", async () => {
  const f = fixture(); const token = tokenOf(await f.access.issue(f.input));
  const [key, value] = [...f.records][0]!, original = JSON.parse(value);
  for (const seedream of [false, true]) {
    Object.assign(f.state, seedream ? seedreamRoute : { toolKey: null, modelId: null, protocol: null });
    const limit = seedream ? LAYER_STUDIO_MAX_REFERENCE_BYTES : APIMART_IMAGE_MAX_BYTES;
    for (const length of [limit, limit + 1]) {
      f.state.byteSize = length; f.state.mimeType = "image/png";
      f.records.set(key, JSON.stringify({ ...original, length, referencePolicy: "seedream55" }));
      if (length === limit) expect((await f.access.resolve(token)).expectedObject.length).toBe(limit);
      else await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
    }
    for (const mimeType of [...extendedMimes, "image/avif", "image/jp2", "text/html"]) {
      f.state.byteSize = png.length; f.state.mimeType = mimeType;
      f.records.set(key, JSON.stringify({ ...original, mimeType, referencePolicy: "seedream55" }));
      if (seedream && extendedMimes.includes(mimeType)) expect((await f.access.resolve(token)).asset.mime_type).toBe(mimeType);
      else await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
    }
  }
});

test("Seedream references still require real supported bytes, dimensions and decoding before granting", async () => {
  for (const [bytes, mimeType] of [[Buffer.from("<html>not an image</html>"), "image/png"], [await imageReference("image/png"), "image/bmp"],
    [await imageReference("image/bmp"), "image/avif"]] as const) {
    const f = fixture(); Object.assign(f.state, seedreamRoute); setReference(f, bytes, mimeType);
    await expect(f.access.issue(f.input)).rejects.toThrow("真实格式"); expect(f.writes).toHaveLength(0);
  }
  const damaged = Buffer.from(await imageReference("image/heic")); damaged.fill(0, damaged.indexOf("mdat") + 4);
  const f = fixture(); Object.assign(f.state, seedreamRoute); setReference(f, damaged, "image/heic");
  await expect(f.access.issue(f.input)).rejects.toThrow("无法解码"); expect(f.writes).toHaveLength(0);
}, 30_000);

test("expanded grants preserve lease, owner, TTL, live-task and ETag revocation boundaries", async () => {
  const bytes = await imageReference("image/bmp");
  const f = fixture(); Object.assign(f.state, seedreamRoute); setReference(f, bytes, "image/bmp");
  const path = pathOf(await f.access.issue(f.input)), token = tokenOf(origin + path);
  f.state.executionToken = ""; f.state.leaseValid = false;
  expect((await f.access.resolve(token)).asset.mime_type).toBe("image/bmp");
  await expect(f.access.issue(f.input)).rejects.toMatchObject({ status: 404 });
  for (const status of ["pending", "queued", "success", "cancelled", "failed", "paused"]) {
    f.state.status = status; await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
  }
  f.state.status = "processing"; f.state.owner = otherUserId;
  await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
  f.state.owner = userId; f.state.etag = '"replacement"';
  await withServer(f, async base => {
    const response = await fetch(base + path); expect(response.status).toBe(503); expect(await response.text()).toBe("");
  });
  f.state.etag = f.input.source.etag!;
  const [key, value] = [...f.records][0]!; f.records.set(key, JSON.stringify({ ...JSON.parse(value), expiresAt: Date.now() - 1 }));
  await expect(f.access.resolve(token)).rejects.toMatchObject({ status: 404 });
});

test("issuance rechecks the persisted route and lease after original-byte verification", async () => {
  const bytes = await imageReference("image/bmp");
  for (const change of [{ toolKey: "image-edit" }, { modelId: "seedream-5-0" }, { protocol: "openai" }, { leaseValid: false }]) {
    const f = fixture(); Object.assign(f.state, seedreamRoute); setReference(f, bytes, "image/bmp"); f.input.source.etag = undefined;
    f.onGet(() => { Object.assign(f.state, change); });
    await expect(f.access.issue(f.input)).rejects.toMatchObject({ status: 404 }); expect(f.writes).toHaveLength(0);
  }
});
