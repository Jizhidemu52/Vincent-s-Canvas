import { expect, test } from "bun:test";
import express from "express";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { startAssetThumbnailMaintenance } from "../../src/asset-thumbnails";
import { createAssetsRouter } from "../../src/routes/assets";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import type { ObjectStorage } from "../../src/object-storage";
import type { AuthenticatedRequest } from "../../src/types";

const integration = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

integration("video poster queue derives first frame/duration, retains original bytes and checks current ownership before every response", async () => {
  const original = await new Promise<Buffer>((resolve, reject) => execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=6', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'],
    { windowsHide: true, encoding: 'buffer', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const fixture = await createIsolatedPostgres();
  const owner = randomUUID(), other = randomUUID(), id = randomUUID(), key = `video/${id}.mp4`;
  const objects = new Map([[key, original]]), reads: string[] = [], writes: string[] = [];
  const storage = {
    configured: true,
    head: async (objectKey: string) => ({ ContentLength: objects.get(objectKey)!.length, ETag: `"${hash(objects.get(objectKey)!)}"` }),
    get: async (objectKey: string) => { reads.push(objectKey); const bytes = objects.get(objectKey)!; return { Body: Readable.from([bytes]), ContentLength: bytes.length, ETag: `"${hash(bytes)}"` }; },
    put: async (objectKey: string, bytes: Buffer) => { writes.push(objectKey); objects.set(objectKey, Buffer.from(bytes)); },
  } as unknown as ObjectStorage;
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'poster-owner','Owner','designer'),($2,'poster-other','Other','designer')", [owner, other]);
  await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status,metadata) VALUES($1,$2,$3,'video.mp4','video/mp4',$4,'video','ready',$5)", [id, owner, key, original.length, JSON.stringify({ title: 'Original video', customField: 'keep me' })]);
  const app = express();
  app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { id: request.header('x-test-owner') || owner, role: 'designer', departmentId: null } as AuthenticatedRequest['auth']; next(); });
  app.use('/api/assets', createAssetsRouter(fixture.db, storage));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/assets/${id}`;
  const get = (suffix: string, actor = owner, etag?: string) => fetch(base + suffix, { headers: { 'x-test-owner': actor, ...(etag ? { 'If-None-Match': etag } : {}) } });
  let service: ReturnType<typeof startAssetThumbnailMaintenance> | undefined;
  try {
    const pending = await get('/thumb?w=256');
    expect(pending.status).toBe(202); expect(pending.headers.get('Retry-After')).toBe('3'); expect((await pending.arrayBuffer()).byteLength).toBe(0);
    expect((await get('/thumb?w=256', other)).status).toBe(404); expect(reads).toEqual([]);
    service = startAssetThumbnailMaintenance(fixture.db, storage, { pollIntervalMs: 10 });
    const deadline = Date.now() + 10_000;
    let row: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      row = (await fixture.db.query('SELECT thumbnail_256_key,thumbnail_1024_key,thumbnail_lease_token,metadata FROM assets WHERE id=$1', [id])).rows[0];
      if (row?.thumbnail_256_key && row.thumbnail_1024_key && !row.thumbnail_lease_token) break;
      await Bun.sleep(20);
    }
    expect(row?.metadata).toMatchObject({ title: 'Original video', customField: 'keep me', width: 640, height: 360, durationMs: 1000 });
    expect(writes).toEqual([`${key}.thumb-256.webp`, `${key}.thumb-1024.webp`]);
    expect(hash(objects.get(key)!)).toBe(hash(original));
    const ready = await get('/thumb?w=256');
    expect(ready.status).toBe(200); expect(ready.headers.get('Content-Type')).toBe('image/webp');
    expect(ready.headers.get('X-Canvas-Media-Duration-Ms')).toBe('1000');
    expect(hash(new Uint8Array(await ready.arrayBuffer()))).toBe(hash(objects.get(`${key}.thumb-256.webp`)!));
    const beforeForbidden = reads.length;
    expect((await get('/thumb?w=256', other, ready.headers.get('ETag')!)).status).toBe(404); expect(reads).toHaveLength(beforeForbidden);
    const detail = await (await get('')).json();
    expect(detail.asset.thumbnailUrl).toBe(`/api/assets/${id}/thumb?w=256`); expect(detail.asset.metadata.durationMs).toBe(1000);
    expect(hash(new Uint8Array(await (await get('/content')).arrayBuffer()))).toBe(hash(original));
    await service.stop(); service = undefined;
    await fixture.db.query('UPDATE assets SET thumbnail_256_key=NULL,thumbnail_1024_key=NULL,thumbnail_attempts=4 WHERE id=$1', [id]);
    expect((await get('/thumb?w=256')).status).toBe(422);
    await fixture.db.query('UPDATE assets SET deleted_at=now() WHERE id=$1', [id]);
    expect((await get('/thumb?w=256', owner, ready.headers.get('ETag')!)).status).toBe(404);
  } finally {
    await service?.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close();
  }
}, 30_000);
