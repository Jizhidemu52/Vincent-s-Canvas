import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createAssetsRouter } from "../src/routes/assets";
import type { Database } from "../src/db";
import type { ObjectStorage } from "../src/object-storage";
import type { AuthenticatedRequest, SessionUser } from "../src/types";

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
