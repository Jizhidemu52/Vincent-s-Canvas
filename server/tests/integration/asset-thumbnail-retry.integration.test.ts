import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateAssetThumbnails, scheduleAssetThumbnails, startAssetThumbnailMaintenance } from "../../src/asset-thumbnails";
import type { ObjectStorage } from "../../src/object-storage";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const storage = { configured: true } as ObjectStorage;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Thumbnail fixture did not reach expected state");
    await Bun.sleep(5);
  }
}
async function fixture(count = 1) {
  const sql = await createIsolatedPostgres();
  const owner = randomUUID(), ids: string[] = [];
  await sql.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Thumbnails','designer')", [owner, owner]);
  for (let i = 0; i < count; i++) {
    const id = randomUUID(); ids.push(id);
    await sql.db.query(`INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status)
      VALUES($1,$2,$3,'original.png','image/png',1024,'image','ready')`, [id, owner, `original/${id}.png`]);
  }
  const row = async (id = ids[0]) => (await sql.db.query("SELECT * FROM assets WHERE id=$1", [id])).rows[0];
  const complete: typeof generateAssetThumbnails = async (db, _storage, id, options) => {
    await db.query("UPDATE assets SET thumbnail_256_key='small',thumbnail_1024_key='large' WHERE id=$1 AND thumbnail_lease_token=$2", [id, options?.leaseToken]);
  };
  return { ...sql, ids, row, complete };
}

integration("durable backlog is scanned on startup with at most two active decoders and no duplicate claims", async () => {
  const f = await fixture(7);
  let active = 0, maximum = 0;
  const calls: string[] = [], releases: Array<() => void> = [];
  const service = startAssetThumbnailMaintenance(f.db, storage, { pollIntervalMs: 10, generate: async (...args) => {
    active++; maximum = Math.max(maximum, active); calls.push(args[2]);
    await new Promise<void>(resolve => releases.push(resolve));
    await f.complete(...args); active--;
  } });
  try {
    expect(startAssetThumbnailMaintenance(f.db, storage)).toBe(service);
    await until(() => calls.length === 2);
    for (let i = 0; i < 20; i++) scheduleAssetThumbnails(f.db, storage, f.ids[0]);
    expect(calls).toHaveLength(2);
    while (calls.length < 7 || active) {
      releases.splice(0).forEach(release => release());
      await Bun.sleep(10);
    }
    await until(async () => (await f.db.query("SELECT count(*)::int n FROM assets WHERE thumbnail_lease_token IS NOT NULL")).rows[0].n === 0);
    expect(maximum).toBe(2);
    expect(new Set(calls).size).toBe(7);
    expect((await f.db.query("SELECT count(*)::int n FROM assets WHERE thumbnail_1024_key='large'")).rows[0].n).toBe(7);
  } finally { releases.splice(0).forEach(release => release()); await service.stop(); await f.close(); }
}, 30_000);

integration("thumbnail failures persist bounded backoff and stop after four attempts without changing the original", async () => {
  const f = await fixture(); let calls = 0;
  const service = startAssetThumbnailMaintenance(f.db, storage, { pollIntervalMs: 10, generate: async () => { calls++; throw new Error("decoder fixture failure"); } });
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await until(async () => { const row = await f.row(); return row.thumbnail_attempts === attempt && row.thumbnail_lease_token === null; });
      const row = await f.row();
      expect(row.thumbnail_last_error).toBe("decoder fixture failure");
      expect(new Date(row.thumbnail_retry_at).getTime()).toBeGreaterThan(Date.now() + 10_000);
      expect(row.status).toBe("ready"); expect(row.byte_size).toBe(1024);
      await f.db.query("UPDATE assets SET thumbnail_retry_at=now()-interval '1 second' WHERE id=$1", [f.ids[0]]);
      service.wake();
    }
    await Bun.sleep(50);
    expect(calls).toBe(4);
    expect((await f.row()).object_key).toBe(`original/${f.ids[0]}.png`);
  } finally { await service.stop(); await f.close(); }
}, 30_000);

integration("expired leases recover after restart while stale workers cannot read or publish thumbnails", async () => {
  const f = await fixture(); const oldToken = randomUUID(); let calls = 0;
  await f.db.query("UPDATE assets SET thumbnail_attempts=1,thumbnail_lease_token=$2,thumbnail_retry_at=now()+interval '3 minutes' WHERE id=$1", [f.ids[0], oldToken]);
  const service = startAssetThumbnailMaintenance(f.db, storage, { pollIntervalMs: 10, generate: async (...args) => { calls++; await f.complete(...args); } });
  try {
    await Bun.sleep(30); expect(calls).toBe(0);
    await f.db.query("UPDATE assets SET thumbnail_retry_at=now()-interval '1 second' WHERE id=$1", [f.ids[0]]);
    service.wake();
    await until(async () => (await f.row()).thumbnail_1024_key === "large");
    expect(calls).toBe(1);
    await generateAssetThumbnails(f.db, { get: () => { throw new Error("stale worker accessed media"); } } as unknown as ObjectStorage, f.ids[0], { leaseToken: oldToken });
    expect((await f.row()).thumbnail_attempts).toBe(2);
  } finally { await service.stop(); await f.close(); }
}, 30_000);

integration("graceful stop aborts work and releases the lease without spending an attempt; next startup resumes", async () => {
  const f = await fixture(); let began = false;
  const service = startAssetThumbnailMaintenance(f.db, storage, { generate: async (_db, _storage, _id, options) => {
    began = true;
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
  } });
  try {
    await until(() => began);
    const stopping = service.stop(); expect(service.stop()).toBe(stopping); await stopping;
    expect(await f.row()).toMatchObject({ thumbnail_attempts: 0, thumbnail_lease_token: null, thumbnail_retry_at: null, thumbnail_last_error: null });
    const resumed = startAssetThumbnailMaintenance(f.db, storage, { generate: f.complete });
    try { await until(async () => (await f.row()).thumbnail_1024_key === "large"); }
    finally { await resumed.stop(); }
  } finally { await service.stop(); await f.close(); }
}, 30_000);

integration("unconfigured storage spends no attempts and a timeout is persisted as a retryable failure", async () => {
  const f = await fixture();
  const disabled = startAssetThumbnailMaintenance(f.db, { configured: false } as ObjectStorage);
  await disabled.stop();
  expect((await f.row()).thumbnail_attempts).toBe(0);
  const service = startAssetThumbnailMaintenance(f.db, storage, { jobTimeoutMs: 10, generate: async (_db, _storage, _id, options) => {
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
  } });
  try {
    await until(async () => (await f.row()).thumbnail_last_error === "缩略图处理超时");
    expect((await f.row()).thumbnail_attempts).toBe(1);
  } finally { await service.stop(); await f.close(); }
}, 30_000);
