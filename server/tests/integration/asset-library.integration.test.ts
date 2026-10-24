import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { createAssetsRouter } from "../../src/routes/assets";
import type { ObjectStorage } from "../../src/object-storage";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const owner = "71000000-0000-4000-8000-000000000001";
const peer = "71000000-0000-4000-8000-000000000002";
const manager = "71000000-0000-4000-8000-000000000003";
const outsider = "71000000-0000-4000-8000-000000000004";
const department = "72000000-0000-4000-8000-000000000001";
const otherDepartment = "72000000-0000-4000-8000-000000000002";
const project = "73000000-0000-4000-8000-000000000001";

async function harness() {
  const fixture = await createIsolatedPostgres();
  await fixture.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Asset team','ASSET'),($2,'Other team','OTHER')", [department, otherDepartment]);
  await fixture.db.query(`INSERT INTO users(id,username,display_name,role,department_id) VALUES
    ($1,'asset-owner','Owner','designer',$5),($2,'asset-peer','Peer','designer',$5),
    ($3,'asset-manager','Manager','department_admin',$5),($4,'asset-outside','Outside','department_admin',$6)`,
    [owner, peer, manager, outsider, department, otherDepartment]);
  await fixture.db.query("INSERT INTO projects(id,external_id,name,owner_user_id,department_id) VALUES($1,'asset-project','Asset project',$2,$3)", [project, owner, department]);
  const files = new Set<string>(), reads: string[] = [];
  let beforeHead: ((key: string) => Promise<void>) | undefined;
  const storage = { head: async (key: string) => {
    reads.push(key); await beforeHead?.(key);
    if (!files.has(key)) throw Object.assign(new Error("Missing object"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    return { ContentLength: 3, ETag: '"asset-fixture"' };
  } } as unknown as ObjectStorage;
  const app = express().use(express.json());
  app.use((req, _res, next) => {
    const id = req.header("x-test-owner") || owner;
    (req as AuthenticatedRequest).auth = { id, role: id === manager || id === outsider ? "department_admin" : "designer",
      departmentId: id === outsider ? otherDepartment : department } as SessionUser;
    next();
  });
  app.use("/api/assets", createAssetsRouter(fixture.db, storage));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.name === "ZodError" ? 400 : 500).json({ message: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = "GET", actor = owner) => fetch(`${origin}/api/assets${path}`, { method, headers: { "x-test-owner": actor } });
  return { ...fixture, files, reads, request, setHead: (fn?: typeof beforeHead) => { beforeHead = fn; },
    add: async (options: { tags?: string[]; projectId?: string; createdAt?: string; clientReferenceId?: string } = {}) => {
      const id = crypto.randomUUID(), key = `assets/${id}.txt`; files.add(key);
      await fixture.db.query(`INSERT INTO assets(id,owner_user_id,department_id,project_id,object_key,filename,mime_type,byte_size,kind,status,metadata,created_at,client_reference_id)
        VALUES($1,$2,$3,$4,$5,'asset.txt','text/plain',3,'text','ready',$6::jsonb,COALESCE($7::timestamptz,now()),$8)`,
        [id, owner, department, options.projectId || null, key, JSON.stringify({ title: id, tags: options.tags || [] }), options.createdAt || null, options.clientReferenceId || null]);
      return { id, key };
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close(); },
  };
}

integration("formal asset trash and restore retain ownership, project and sharing while denying shared readers", async () => {
  const fixture = await harness();
  try {
    const asset = await fixture.add({ tags: ["retain"], projectId: project });
    await fixture.db.query("UPDATE assets SET visibility_scope='company' WHERE id=$1", [asset.id]);
    await fixture.db.query("INSERT INTO asset_shares(asset_id,scope,user_id,created_by) VALUES($1,'user',$2,$3)", [asset.id, peer, owner]);
    expect((await fixture.request(`/${asset.id}`, "DELETE")).status).toBe(204);
    expect((await (await fixture.request("/")).json()).assets).toHaveLength(0);
    const trash = await (await fixture.request("/trash")).json();
    expect(trash.assets).toHaveLength(1);
    expect(trash.assets[0]).toMatchObject({ id: asset.id, ownerUserId: owner, projectId: project, visibilityScope: "company" });
    expect(Date.parse(trash.assets[0].purgeAfter) - Date.parse(trash.assets[0].deletedAt)).toBe(30 * 86_400_000);
    expect((await fixture.request(`/${asset.id}/content`)).status).toBe(404);
    expect((await (await fixture.request("/trash", "GET", peer)).json()).assets).toHaveLength(0);
    expect((await fixture.request(`/${asset.id}/restore`, "POST", peer)).status).toBe(404);
    expect((await fixture.request(`/${asset.id}/restore`, "POST", outsider)).status).toBe(404);
    expect(fixture.reads).toEqual([]);
    expect((await fixture.request(`/${asset.id}/restore`, "POST", manager)).status).toBe(204);
    expect(fixture.reads).toEqual([asset.key]);
    const result = await fixture.db.query("SELECT owner_user_id,project_id,visibility_scope,deleted_at,purge_after,metadata FROM assets WHERE id=$1", [asset.id]);
    expect(result.rows[0]).toMatchObject({ owner_user_id: owner, project_id: project, visibility_scope: "company", deleted_at: null, purge_after: null, metadata: { tags: ["retain"] } });
    expect((await fixture.db.query("SELECT count(*)::int AS n FROM asset_shares WHERE asset_id=$1", [asset.id])).rows[0].n).toBe(1);
    expect((await (await fixture.request("/trash")).json()).assets).toHaveLength(0);
    expect((await (await fixture.request("/")).json()).assets).toHaveLength(1);
  } finally { await fixture.close(); }
}, 30_000);

integration("asset tag, project and time filters apply before stable newest or oldest cursor pagination", async () => {
  const fixture = await harness();
  try {
    const first = await fixture.add({ tags: ["服装", "优选"], projectId: project, createdAt: "2026-10-01T00:00:00.000001Z" });
    const second = await fixture.add({ tags: ["服装"], projectId: project, createdAt: "2026-10-01T00:00:00.000002Z" });
    await fixture.add({ tags: ["服装细节"], projectId: project, createdAt: "2026-10-01T00:00:00.000003Z" });
    await fixture.add({ tags: ["服装"], createdAt: "2026-10-01T00:00:00.000004Z" });
    await fixture.add({ tags: ["服装"], projectId: project, createdAt: "2026-09-01T00:00:00Z" });
    const query = new URLSearchParams({ tag: "服装", projectId: project, createdFrom: "2026-10-01T00:00:00Z", createdBefore: "2026-10-02T00:00:00Z", limit: "1" });
    for (const [sort, ids] of [["newest", [second.id, first.id]], ["oldest", [first.id, second.id]]] as const) {
      query.set("sort", sort); query.delete("cursor");
      const page = await (await fixture.request(`/?${query}`)).json();
      expect(page.assets.map((item: { id: string }) => item.id)).toEqual([ids[0]]);
      expect(page.hasMore).toBe(true);
      query.set("cursor", page.nextCursor);
      const next = await (await fixture.request(`/?${query}`)).json();
      expect(next.assets.map((item: { id: string }) => item.id)).toEqual([ids[1]]);
      expect(next.hasMore).toBe(false);
    }
    expect((await fixture.request("/?sort=invalid")).status).toBe(400);
    expect((await fixture.request("/?createdFrom=2026-10-02T00:00:00Z&createdBefore=2026-10-01T00:00:00Z")).status).toBe(400);
  } finally { await fixture.close(); }
}, 30_000);

integration("restore rejects expired, missing, unavailable and concurrently changed originals without clearing deletion", async () => {
  const fixture = await harness();
  try {
    const expired = await fixture.add();
    await fixture.db.query("UPDATE assets SET deleted_at=now()-interval '31 days',purge_after=now()-interval '1 day' WHERE id=$1", [expired.id]);
    expect((await fixture.request(`/${expired.id}/restore`, "POST")).status).toBe(410);
    expect(fixture.reads).toEqual([]);
    const missing = await fixture.add();
    await fixture.request(`/${missing.id}`, "DELETE"); fixture.files.delete(missing.key);
    expect((await fixture.request(`/${missing.id}/restore`, "POST")).status).toBe(410);
    const unavailable = await fixture.add(); await fixture.request(`/${unavailable.id}`, "DELETE");
    fixture.setHead(async () => { throw new Error("Storage unavailable"); });
    expect((await fixture.request(`/${unavailable.id}/restore`, "POST")).status).toBe(503);
    const raced = await fixture.add(); await fixture.request(`/${raced.id}`, "DELETE");
    fixture.setHead(async () => { await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [raced.id]); });
    expect((await fixture.request(`/${raced.id}/restore`, "POST")).status).toBe(409);
    const remaining = await fixture.db.query("SELECT id FROM assets WHERE deleted_at IS NOT NULL");
    expect(remaining.rows).toHaveLength(4);
    const trash = await (await fixture.request("/trash")).json();
    expect(trash.assets.some((item: { id: string }) => item.id === expired.id)).toBe(false);
  } finally { await fixture.close(); }
}, 30_000);

integration("restore conflicts preserve deletion and trash cursors retain microseconds in both sort orders", async () => {
  const fixture = await harness();
  try {
    const first = await fixture.add({ clientReferenceId: 'restore-conflict' });
    await fixture.request(`/${first.id}`, 'DELETE');
    await fixture.add({ clientReferenceId: 'restore-conflict' });
    expect((await fixture.request(`/${first.id}/restore`, 'POST')).status).toBe(409);
    expect((await fixture.db.query('SELECT deleted_at FROM assets WHERE id=$1', [first.id])).rows[0].deleted_at).not.toBeNull();
    const second = await fixture.add(); await fixture.request(`/${second.id}`, 'DELETE');
    const base = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.00000');
    for (const [index, asset] of [first, second].entries()) await fixture.db.query('UPDATE assets SET deleted_at=$2::timestamptz,purge_after=$2::timestamptz+interval \'30 days\' WHERE id=$1', [asset.id, `${base}${index + 1}Z`]);
    for (const [sort, ids] of [['newest', [second.id, first.id]], ['oldest', [first.id, second.id]]] as const) {
      const page = await (await fixture.request(`/trash?sort=${sort}&limit=1`)).json();
      expect(page.assets.map((asset: { id: string }) => asset.id)).toEqual([ids[0]]);
      const next = await (await fixture.request(`/trash?sort=${sort}&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
      expect(next.assets.map((asset: { id: string }) => asset.id)).toEqual([ids[1]]);
      expect(next.hasMore).toBe(false);
    }
  } finally { await fixture.close(); }
}, 30_000);
