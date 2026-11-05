import { expect, test } from "bun:test";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createAssetsRouter } from "../../src/routes/assets";
import { createAssetVideoPreviewService, VideoPreviewError } from "../../src/asset-video-preview";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { playbackBytes, playbackFixture, playbackMetadata, until } from "../helpers/video-playback";
import type { ObjectStorage } from "../../src/object-storage";
import type { AuthenticatedRequest } from "../../src/types";

const integration = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

integration("video playback checks current asset access before reporting an unavailable preview service", async () => {
  const fixture = await createIsolatedPostgres();
  const owner = randomUUID(), other = randomUUID(), id = randomUUID();
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'playback-owner','Owner','designer'),($2,'playback-other','Other','designer')", [owner, other]);
  await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,'video/original.mp4','original.mp4','video/mp4',100,'video','ready')", [id, owner]);
  let reads = 0;
  const storage = { configured: true, head: async () => { reads++; throw new Error("must not read without a configured preview service"); } } as unknown as ObjectStorage;
  const app = express();
  app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { id: request.header("x-test-owner") || owner, role: "designer", departmentId: null } as AuthenticatedRequest["auth"]; next(); });
  app.use("/api/assets", createAssetsRouter(fixture.db, storage));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/assets/${id}/playback`;
  try {
    expect((await fetch(url, { headers: { "x-test-owner": other } })).status).toBe(404);
    const unavailable = await fetch(url);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: "VIDEO_PREVIEW_UNAVAILABLE" });
    expect(reads).toBe(0);
    await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [id]);
    expect((await fetch(url)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fixture.close();
  }
}, 30_000);

integration("private playback honors current SQL ACL, 202/200/206/HEAD/304, source changes and exact deletion cleanup", async () => {
  const fixture = await createIsolatedPostgres(), f = playbackFixture(), other = randomUUID();
  const { id, owner_user_id: owner } = f.asset;
  await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'playback-owner','Owner','designer'),($2,'playback-other','Other','designer')", [owner, other]);
  await fixture.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'original.mp4','video/mp4',$4,'video','ready')", [id, owner, f.asset.object_key, playbackBytes.length]);
  let runs = 0, invalid = false;
  const service = createAssetVideoPreviewService(fixture.db, f.cache, f.storage, { log: f.log, prepare: async (_input, output) => {
    runs++; if (invalid) throw new VideoPreviewError(422, "VIDEO_PREVIEW_UNSUPPORTED", "Invalid synthetic media");
    await writeFile(output, playbackBytes); return { kind: "derived", metadata: playbackMetadata, byteSize: playbackBytes.length };
  } });
  const invalidations: string[] = [], invalidate = service.invalidate;
  service.invalidate = (asset, reason) => { invalidations.push(reason); invalidate(asset, reason); };
  const app = express(); app.use(express.json());
  app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { id: request.header("x-test-owner") || owner, role: "designer", departmentId: null } as AuthenticatedRequest["auth"]; next(); });
  app.use("/api/assets", createAssetsRouter(fixture.db, f.storage, service));
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => { if (!response.headersSent) response.status(500).json({ error: error.message }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/assets/${id}`;
  try {
    const heads = f.calls.heads.length;
    for (const method of ["GET", "HEAD"]) {
      const denied = await fetch(`${base}/playback`, { method, headers: { "x-test-owner": other, "If-None-Match": '"derived"' } });
      expect(denied.status).toBe(404); expect(denied.headers.get("etag")).not.toBe('"derived"');
    }
    expect(f.calls.heads.length).toBe(heads);
    const coldHead = await fetch(`${base}/playback`, { method: "HEAD" });
    expect(coldHead.status).toBe(202); expect(coldHead.headers.get("Retry-After")).toBe("3"); expect(runs).toBe(0);
    expect((await fetch(`${base}/playback`)).status).toBe(202); await until(() => runs === 1 && !f.entries.has(f.lockKey));
    const previewKey = f.calls.puts[0]!;
    const full = await fetch(`${base}/playback`);
    expect(full.status).toBe(200); expect(full.headers.get("Content-Type")).toBe("video/mp4"); expect(full.headers.get("Cache-Control")).toBe("no-store");
    expect(full.headers.get("X-Canvas-Media-Width")).toBe("160"); expect(full.headers.get("X-Canvas-Media-Height")).toBe("224"); expect(full.headers.get("X-Canvas-Media-Duration-Ms")).toBe("1000");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(playbackBytes);
    const partial = await fetch(`${base}/playback`, { headers: { Range: "bytes=9000-9015" } });
    expect(partial.status).toBe(206); expect(partial.headers.get("Content-Range")).toBe("bytes 9000-9015/16384");
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(playbackBytes.subarray(9000, 9016));
    const head = await fetch(`${base}/playback`, { method: "HEAD", headers: { Range: "bytes=9000-9015" } });
    expect(head.status).toBe(200); expect(head.headers.get("Content-Length")).toBe("16384"); expect(head.headers.get("Content-Range")).toBeNull(); expect(await head.text()).toBe("");
    for (const method of ["GET", "HEAD"]) {
      const cached = await fetch(`${base}/playback`, { method, headers: { "If-None-Match": '"derived"' } });
      expect(cached.status).toBe(304); expect(cached.headers.get("Vary")).toBe("Cookie"); expect(await cached.text()).toBe("");
    }
    const download = await fetch(`${base}/content?download=1`);
    expect(download.status).toBe(200); expect(download.headers.get("Content-Disposition")).toStartWith("attachment;"); expect(download.headers.get("etag")).toBe('"original"');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(playbackBytes); expect(runs).toBe(1);

    // A shared reader can lose access while an object response is in-flight.
    for (const phase of ["conditional", "head", "range"] as const) {
      await fixture.db.query("UPDATE assets SET visibility_scope='company' WHERE id=$1", [id]);
      let derivedHeads = 0;
      const revoke = () => fixture.db.query("UPDATE assets SET visibility_scope='private' WHERE id=$1", [id]).then(() => undefined);
      f.hooks.head = async key => { if (phase === "conditional" && key === previewKey && ++derivedHeads === 2) await revoke(); };
      f.hooks.get = async key => { if (phase !== "conditional" && key === previewKey) await revoke(); };
      const denied = await fetch(`${base}/playback`, { method: phase === "head" ? "HEAD" : "GET", headers: { "x-test-owner": other, ...(phase === "conditional" ? { "If-None-Match": '"derived"' } : { Range: "bytes=9000-9015" }) } });
      expect(denied.status).toBe(404); expect(denied.headers.get("ETag")).not.toBe('"derived"'); expect(denied.headers.get("X-Canvas-Media-Width")).toBeNull();
      f.hooks.head = undefined; f.hooks.get = undefined;
    }
    f.hooks.get = async key => { if (key === previewKey) f.objects.get(f.asset.object_key)!.etag = '"repaired-during-read"'; };
    const changed = await fetch(`${base}/playback`, { headers: { Range: "bytes=9000-9015" } });
    expect(changed.status).toBe(503); expect(await changed.json()).toMatchObject({ error: "VIDEO_PREVIEW_SOURCE_CHANGED" });
    f.hooks.get = undefined; f.objects.get(f.asset.object_key)!.etag = '"original"';
    let derivedHeads = 0;
    f.hooks.head = async key => { if (key === previewKey && ++derivedHeads === 2) f.objects.delete(previewKey); };
    expect((await fetch(`${base}/playback`)).status).toBe(503);
    f.hooks.head = undefined;
    f.objects.set(previewKey, { bytes: playbackBytes, etag: '"derived"' });
    const deleted = await fetch(base, { method: "DELETE" }); expect(deleted.status).toBe(204);
    await until(() => f.calls.removes.includes(previewKey));
    expect((await fetch(`${base}/playback`, { headers: { "If-None-Match": '"derived"' } })).status).toBe(404);
    expect(f.objects.has(f.asset.object_key)).toBe(true);
    expect((await fixture.db.query("SELECT object_key,byte_size FROM assets WHERE id=$1", [id])).rows[0]).toEqual({ object_key: f.asset.object_key, byte_size: playbackBytes.length });
    await fixture.db.query("UPDATE assets SET deleted_at=NULL WHERE id=$1", [id]);
    invalid = true; f.objects.get(f.asset.object_key)!.etag = '"unsupported-source"';
    expect((await fetch(`${base}/playback`)).status).toBe(202); await until(() => runs === 2 && !f.entries.has(f.lockKey));
    const unsupported = await fetch(`${base}/playback`); expect(unsupported.status).toBe(422); expect(await unsupported.json()).toMatchObject({ error: "VIDEO_PREVIEW_UNSUPPORTED" });
    expect((await fixture.db.query("SELECT status FROM assets WHERE id=$1", [id])).rows[0].status).toBe("ready");
    f.objects.delete(f.asset.object_key); expect((await fetch(`${base}/playback`)).status).toBe(404);
    f.hooks.head = async () => { throw new Error("fixture unavailable"); }; expect((await fetch(`${base}/playback`)).status).toBe(503);
    f.hooks.head = undefined;
    await fixture.db.query("UPDATE assets SET content_sha256=$2 WHERE id=$1", [id, createHash("sha256").update(playbackBytes).digest("hex")]);
    f.storage.put = async (key, body, _mime, options) => {
      expect(key).toBe(f.asset.object_key); expect(options?.ifNoneMatch).toBe("*");
      f.objects.set(key, { bytes: Buffer.from(body), etag: '"repaired-exact-bytes"' });
    };
    const repaired = await fetch(`${base}/upload?repair=1`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: playbackBytes });
    expect(repaired.status).toBe(204); expect(invalidations).toEqual(["deleted", "repaired"]);
    expect(f.objects.get(f.asset.object_key)?.bytes).toEqual(playbackBytes);
  } finally {
    await service.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close();
  }
}, 30_000);
