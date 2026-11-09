import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
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

function fixture() {
  const state = {
    owner: userId, user: userId, userStatus: "active", userDeleted: false, assetStatus: "ready", deleted: false, kind: "image", status: "processing",
    objectKey: "private/employee/original.png", mimeType: "image/png", byteSize: png.length,
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
      && key === state.objectKey && state.assetStatus === "ready" && !state.deleted && state.kind === "image"
      && state.userStatus === "active" && !state.userDeleted
      && state.status === "processing" && JSON.parse(String(sources)).every((url: string) => state.sourceUrls.includes(url))
      && (executionToken === undefined || state.executionToken === executionToken && state.leaseValid);
    return { rows: eligible ? [{ object_key: state.objectKey, mime_type: state.mimeType, filename: "员工原件.png", byte_size: state.byteSize }] : [] };
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
