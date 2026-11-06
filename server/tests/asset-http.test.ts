import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createAssetsRouter } from "../src/routes/assets";
import type { Database } from "../src/db";
import type { ObjectStorage } from "../src/object-storage";
import type { AuthenticatedRequest, SessionUser } from "../src/types";
import * as XLSX from "xlsx";

const id = "10000000-0000-4000-8000-000000000001", otherId = "10000000-0000-4000-8000-000000000002";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
async function serve(db: unknown, storage: unknown, run: (url: string) => Promise<void>) {
  const app = express(); app.use(express.json());
  app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { id: request.header('x-test-owner') || 'employee-a', role: 'designer', departmentId: null } as SessionUser; next(); });
  app.use('/api/assets', createAssetsRouter(db as Database, storage as ObjectStorage));
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error.name === 'ZodError' ? 400 : 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('content authorizes before HEAD/304 and streams untouched bytes with safe headers', async () => {
  let gets = 0, heads = 0;
  const db = { query: async (_sql: string, values: unknown[]) => ({ rows: values[1] === 'employee-a' ? [{ object_key: 'original', mime_type: 'image/jpeg', filename: '原图.png' }] : [] }) };
  const storage = { head: async () => { heads++; return { ETag: '"stored"' }; }, get: async () => { gets++; return { ETag: '"stored"', ContentLength: png.length, Body: Readable.from([png.subarray(0, 8), png.subarray(8)]) }; } };
  await serve(db, storage, async url => {
    const cached = await fetch(`${url}/api/assets/${id}/content`, { headers: { 'if-none-match': 'W/"stored"' } });
    expect(cached.status).toBe(304); expect(gets).toBe(0); expect(heads).toBe(1);
    const forbidden = await fetch(`${url}/api/assets/${id}/content`, { headers: { 'x-test-owner': 'employee-b', 'if-none-match': '"stored"' } });
    expect(forbidden.status).toBe(404); expect(heads).toBe(1); expect(forbidden.headers.get('etag')).toBeNull();
    const original = await fetch(`${url}/api/assets/${id}/content`);
    expect(original.status).toBe(200); expect(original.headers.get('content-type')).toBe('image/png');
    expect(original.headers.get('x-content-type-options')).toBe('nosniff');
    expect(original.headers.get('cache-control')).toBe('private, no-cache');
    expect(Buffer.from(await original.arrayBuffer())).toEqual(png);
  });
});

test('document sources upload and download unchanged with employee isolation and attachment-only headers', async () => {
  const assets = new Map<string, { owner: string; object_key: string; filename: string; mime_type: string; byte_size: number; status: string; metadata: Record<string, unknown> }>();
  const objects = new Map<string, Buffer>();
  let reads = 0, writes = 0;
  const query = async (sql: string, values: any[] = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.startsWith("INSERT INTO assets")) {
      assets.set(values[0], { owner: values[1], object_key: values[4], filename: values[5], mime_type: values[6], byte_size: values[7], status: "pending", metadata: JSON.parse(values[10]) });
      return { rows: [] };
    }
    const asset = assets.get(values[0]);
    if (sql.startsWith("UPDATE assets SET status='ready'")) {
      if (asset && asset.owner === values[4]) { asset.status = "ready"; asset.mime_type = values[1]; }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT")) return { rows: asset && asset.owner === values[1] && asset.status === (sql.includes("status='pending'") ? "pending" : "ready") ? [asset] : [] };
    throw new Error(`Unexpected document fixture query: ${sql}`);
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  const storage = { configured: true,
    put: async (key: string, bytes: Buffer) => { writes++; objects.set(key, Buffer.from(bytes)); },
    head: async (key: string) => { reads++; return { ETag: '"document"', ContentLength: objects.get(key)!.length }; },
    get: async (key: string) => { reads++; const bytes = objects.get(key)!; return { ETag: '"document"', ContentLength: bytes.length, Body: Readable.from([bytes]) }; },
  };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Style"], ["A01"]]), "Design");
  const cases = [
    { mimeType: "text/csv", name: "款式.csv", bytes: Buffer.from("款号,颜色\r\nA01,红色\r\n") },
    { mimeType: "text/markdown", name: "需求.md", bytes: Buffer.from("# 需求\n保留纽扣，不要口袋\n") },
    { mimeType: "application/vnd.ms-excel", name: "原件.xls", bytes: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "biff8" })) },
  ];
  await serve(db, storage, async url => {
    for (const item of cases) {
      const reserved = await fetch(`${url}/api/assets/upload-request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: item.name, mimeType: item.mimeType, byteSize: item.bytes.length, kind: "other" }) });
      expect(reserved.status).toBe(201);
      const asset = await reserved.json();
      const upload = (owner: string) => fetch(url + asset.uploadUrl, { method: "PUT", headers: { "content-type": item.mimeType, "x-test-owner": owner }, body: item.bytes });
      expect((await upload("employee-b")).status).toBe(404);
      expect((await upload("employee-a")).status).toBe(204);
      const before = reads;
      expect((await fetch(`${url}/api/assets/${asset.assetId}/content`, { headers: { "x-test-owner": "employee-b", "if-none-match": '"document"' } })).status).toBe(404);
      expect(reads).toBe(before);
      const original = await fetch(`${url}/api/assets/${asset.assetId}/content`);
      expect(original.status).toBe(200);
      expect(original.headers.get("content-type")?.split(";")[0]).toBe(item.mimeType);
      expect(original.headers.get("content-disposition")).toStartWith("attachment;");
      expect(original.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await original.arrayBuffer())).toEqual(item.bytes);
    }
    expect(writes).toBe(cases.length);
  });
});

test('authorized missing originals have an explicit repair code; storage failures and denied assets do not', async () => {
  let reads = 0, error: unknown;
  const db = { query: async (_sql: string, values: unknown[]) => ({ rows: values[1] === 'employee-a' ? [{ object_key: 'private-original', mime_type: 'image/png', filename: 'original.png' }] : [] }) };
  const storage = { head: async () => { reads++; throw error; } };
  await serve(db, storage, async url => {
    for (const method of ['HEAD', 'GET']) {
      error = Object.assign(new Error('private bucket and key'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      const missing = await fetch(`${url}/api/assets/${id}/content`, { method });
      expect(missing.status).toBe(404); expect(missing.headers.get('X-Canvas-Asset-Error')).toBe('ASSET_OBJECT_MISSING');
      if (method === 'GET') { const body = await missing.json(); expect(body.error).toBe('ASSET_OBJECT_MISSING'); expect(JSON.stringify(body)).not.toContain('private'); }
      for (const cause of [Object.assign(new Error('private bucket forbidden'), { name: 'NotFound', $metadata: { httpStatusCode: 403 } }), Object.assign(new Error('private endpoint timed out'), { name: 'TimeoutError' })]) {
        error = cause;
        const unavailable = await fetch(`${url}/api/assets/${id}/content`, { method });
        expect(unavailable.status).toBe(503); expect(unavailable.headers.get('X-Canvas-Asset-Error')).toBe('ASSET_STORAGE_UNAVAILABLE');
        expect(await unavailable.text()).not.toContain('private');
      }
      const before = reads;
      const denied = await fetch(`${url}/api/assets/${id}/content`, { method, headers: { 'x-test-owner': 'employee-b' } });
      expect(denied.status).toBe(404); expect(denied.headers.get('X-Canvas-Asset-Error')).toBeNull(); expect(reads).toBe(before);
    }
  });
});

test('batch delete denies an unauthorized member without mutating any authorized item', async () => {
  const deleted = new Set<string>();
  let updates = 0, begins = 0, rollbacks = 0;
  const client = { release() {}, query: async (sql: string, values: unknown[] = []) => {
    if (sql === 'BEGIN') begins++;
    if (sql === 'ROLLBACK') rollbacks++;
    if (sql.startsWith('SELECT a.id')) return { rows: (values[0] as string[]).filter(value => value === id).map(id => ({ id })) };
    if (sql.startsWith('UPDATE assets')) { updates++; for (const value of values[0] as string[]) deleted.add(value); }
    return { rows: [] };
  } };
  await serve({ connect: async () => client }, {}, async url => {
    const post = (assetIds: string[]) => fetch(`${url}/api/assets/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', assetIds }) });
    const bad = await post([id, otherId]); expect(bad.status).toBe(403); expect(deleted.size).toBe(0); expect(updates).toBe(0); expect(rollbacks).toBe(1);
    const excess = await post(Array(51).fill(id)); expect(excess.status).toBe(400); expect(begins).toBe(1);
    const good = await post([id]); expect(good.status).toBe(200); expect(deleted.has(id)).toBe(true); expect(updates).toBe(1);
  });
});

test('batch move validates the target project before updating any asset', async () => {
  let updates = 0, rolledBack = false;
  const client = { release() {}, query: async (sql: string) => {
    if (sql.startsWith('SELECT a.id')) return { rows: [{ id }] };
    if (sql === 'ROLLBACK') rolledBack = true;
    if (sql.startsWith('UPDATE assets')) updates++;
    return { rows: [] };
  } };
  await serve({ connect: async () => client }, {}, async url => {
    const result = await fetch(`${url}/api/assets/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'move-project', assetIds: [id], projectId: otherId }) });
    expect(result.status).toBe(403); expect(updates).toBe(0); expect(rolledBack).toBe(true);
  });
});
