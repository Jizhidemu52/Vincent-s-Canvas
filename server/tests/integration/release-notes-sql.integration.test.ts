import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { Cache } from "../../src/db";
import { requireSameOrigin } from "../../src/http-security";
import { createAdminReleaseNotesRouter, createReleaseNotesRouter } from "../../src/routes/release-notes";
import { hashToken } from "../../src/security";
import { requireAccountReady, sessionMiddleware } from "../../src/session";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
const config = { AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "true", CREDITS_ENABLED: "false", SESSION_COOKIE_NAME: "release_notes_fixture", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test" } as AppConfig;

integration("release announcements with real HTTP, sessions and isolated PostgreSQL", () => {
  let postgres: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let url: string;
  let admin: string, designer: string, otherDesigner: string, departmentAdmin: string, localDesigner: string, onboarding: string;
  const cache = { get: async () => null, set: async () => "OK", del: async () => 0 } as unknown as Cache;

  beforeAll(async () => {
    postgres = await createIsolatedPostgres();
    await postgres.db.query("INSERT INTO credit_policy(singleton,credits_enabled) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET credits_enabled=false");
    const department = randomUUID();
    await postgres.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Release fixture','release-fixture')", [department]);
    const actor = async (role: string, provider: string, mustChange = false) => {
      const id = randomUUID(), token = randomUUID();
      await postgres.db.query("INSERT INTO users(id,username,display_name,role,must_change_password,department_id) VALUES($1,$2::text,$2::text,$3,$4,$5)", [id, `release-${id}`, role, mustChange, department]);
      await postgres.db.query("INSERT INTO sessions(id,user_id,token_hash,auth_provider,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')", [randomUUID(), id, hashToken(token), provider]);
      return `${config.SESSION_COOKIE_NAME}=${token}`;
    };
    admin = await actor("super_admin", "local");
    designer = await actor("designer", "oa");
    otherDesigner = await actor("designer", "oa");
    departmentAdmin = await actor("department_admin", "local");
    localDesigner = await actor("designer", "local");
    onboarding = await actor("super_admin", "local", true);
    await postgres.db.query(`CREATE FUNCTION fail_release_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = current_setting('canvas_test.fail_release_audit', true)
        THEN RAISE EXCEPTION 'injected release audit failure'; END IF; RETURN NEW; END $$`);
    await postgres.db.query("CREATE TRIGGER fail_release_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_release_test_audit()");
    const app = express().use(express.json()).use(cookieParser()).use(requireSameOrigin);
    app.use("/api/release-notes", sessionMiddleware(postgres.db, cache, config, { allowPersonalWorkspace: true }), requireAccountReady, createReleaseNotesRouter(postgres.db));
    app.use("/api/admin/release-notes", sessionMiddleware(postgres.db, cache, config, { allowGuest: false }), requireAccountReady, createAdminReleaseNotesRouter(postgres.db));
    app.use(((error, _request, response, _next) => {
      response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.name, message: error.message });
    }) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await postgres?.close();
  });
  const request = (path: string, cookie = admin, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  const save = (version: string, expectedRevision: number | null = null, title = "体验更新", content = "创作体验持续进阶。") => request(`/api/admin/release-notes/${version}/draft`, admin, "PUT", { title, content, expectedRevision });
  const publish = (version: string, expectedRevision = 1) => request(`/api/admin/release-notes/${version}/publish`, admin, "POST", { expectedRevision });
  const stored = async (version: string) => (await postgres.db.query("SELECT * FROM release_notes WHERE version=$1", [version])).rows[0];
  const auditCount = async (version: string, action = "release_note.published") => Number((await postgres.db.query("SELECT count(*) AS count FROM audit_logs WHERE target_type='release_note' AND target_id=$1 AND action=$2", [version, action])).rows[0].count);
  const failAudit = (action: string) => postgres.db.query("SELECT set_config('canvas_test.fail_release_audit',$1,false)", [action]);

  test("uses existing OA/session/account-ready boundaries and permits only super admins to author", async () => {
    for (const path of ["/api/release-notes", "/api/admin/release-notes"]) {
      expect((await request(path, "")).status).toBe(401);
      const denied = await request(path, onboarding);
      expect(denied.status).toBe(403);
      expect((await denied.json()).error).toBe("PASSWORD_CHANGE_REQUIRED");
    }
    expect((await request("/api/release-notes", localDesigner)).status).toBe(401);
    expect((await request("/api/release-notes", designer)).status).toBe(200);
    for (const cookie of [designer, departmentAdmin]) {
      expect((await request("/api/admin/release-notes", cookie)).status).toBe(403);
      expect((await request("/api/admin/release-notes/v1.0.0/draft", cookie, "PUT", { title: "No", content: "No", expectedRevision: null })).status).toBe(403);
      expect((await request("/api/admin/release-notes/v1.0.0/publish", cookie, "POST", { expectedRevision: 1 })).status).toBe(403);
    }
    expect(await stored("v1.0.0")).toBeUndefined();
    const deniedOrigin = await request("/api/admin/release-notes/v1.0.0/draft", admin, "PUT", { title: "No", content: "No", expectedRevision: null }, { origin: "https://foreign.invalid" });
    expect(deniedOrigin.status).toBe(403);
    expect((await deniedOrigin.json()).error).toBe("INVALID_ORIGIN");
    expect(await stored("v1.0.0")).toBeUndefined();
  });

  test("drafts stay private; published DTO contains only the four public fields for all users", async () => {
    const created = await save("v1.0.1", null, " 体验跃升 ", " <script>plain text</script>\n第二行 ");
    expect(created.status).toBe(200);
    const { note } = await created.json();
    expect(note).toMatchObject({ version: "v1.0.1", title: "体验跃升", content: "<script>plain text</script>\n第二行", revision: 1, publishedAt: null });
    expect(typeof note.createdAt).toBe("string");
    expect(typeof note.updatedAt).toBe("string");
    expect((await (await request("/api/release-notes", designer)).json()).notes).toEqual([]);
    expect((await (await request("/api/admin/release-notes")).json()).notes).toHaveLength(1);
    expect((await publish("v1.0.1")).status).toBe(200);
    for (const cookie of [designer, otherDesigner, admin]) {
      const response = await request("/api/release-notes", cookie);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { notes, hasMore } = await response.json();
      expect(hasMore).toBe(false);
      expect(notes).toHaveLength(1);
      expect(Object.keys(notes[0]).sort()).toEqual(["content", "publishedAt", "title", "version"]);
      expect(notes[0]).toMatchObject({ version: note.version, title: note.title, content: note.content });
      expect(typeof notes[0].publishedAt).toBe("string");
    }
    expect(await auditCount("v1.0.1", "release_note.draft_saved")).toBe(1);
    expect(await auditCount("v1.0.1")).toBe(1);
  });

  test("validates versions, text limits, revision types and pagination before writing", async () => {
    const input = { title: "x", content: "y", expectedRevision: null };
    for (const body of [
      { ...input, title: "x".repeat(81) }, { ...input, content: "x".repeat(4001) },
      { ...input, title: "nul\0" }, { ...input, title: 42 }, { ...input, content: null },
      { ...input, expectedRevision: "1" }, { ...input, expectedRevision: 0 }, { ...input, expectedRevision: 1.5 },
      { title: "x", content: "y" }, { ...input, publishedAt: "2026-01-01" },
    ]) expect((await request("/api/admin/release-notes/v1.0.2/draft", admin, "PUT", body)).status).toBe(400);
    for (const version of ["1.0.2", "v1.2", "v1.0.2-beta", "v-1.0.2"]) expect((await save(version)).status).toBe(400);
    for (const query of ["limit=0", "limit=101", "limit=1.5", "offset=-1", "offset=no", "limit=1&limit=2"]) {
      expect((await request(`/api/release-notes?${query}`, designer)).status).toBe(400);
      expect((await request(`/api/admin/release-notes?${query}`)).status).toBe(400);
    }
    expect(await stored("v1.0.2")).toBeUndefined();
    expect((await publish("v1.0.2")).status).toBe(404);
    expect((await save("v1.0.2", null, "x".repeat(80), "y".repeat(4000))).status).toBe(200);
    expect((await save("v1.0.3", null, " \n ", " \t ")).status).toBe(200);
    const empty = await publish("v1.0.3");
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("RELEASE_NOTE_EMPTY");
    expect((await stored("v1.0.3")).published_at).toBeNull();
  });

  test("rejects stale edits and keeps retrying publish idempotent and published notes immutable", async () => {
    // PGlite serializes whole transactions; this verifies competing HTTP revisions,
    // not contention between independent PostgreSQL connections.
    const created = await Promise.all([save("v1.0.4"), save("v1.0.4")]);
    expect(created.map(result => result.status).sort()).toEqual([200, 409]);
    const edited = await Promise.all([save("v1.0.4", 1, "First"), save("v1.0.4", 1, "Second")]);
    expect(edited.map(result => result.status).sort()).toEqual([200, 409]);
    const current = await stored("v1.0.4");
    expect(current.revision).toBe(2);
    const stalePublish = await publish("v1.0.4", 1);
    expect(stalePublish.status).toBe(409);
    expect((await stalePublish.json()).error).toBe("RELEASE_NOTE_CONFLICT");
    const published = await Promise.all([publish("v1.0.4", 2), publish("v1.0.4", 2)]);
    expect(published.map(result => result.status)).toEqual([200, 200]);
    expect(await published[0].json()).toEqual(await published[1].json());
    expect(await auditCount("v1.0.4")).toBe(1);
    expect(await auditCount("v1.0.4", "release_note.draft_saved")).toBe(2);
    const before = await stored("v1.0.4");
    const immutable = await save("v1.0.4", 2, "Overwrite");
    expect(immutable.status).toBe(409);
    expect((await immutable.json()).error).toBe("RELEASE_NOTE_PUBLISHED");
    expect((await save("v1.0.4", null)).status).toBe(409);
    expect(await stored("v1.0.4")).toEqual(before);
  });

  test("audit failures roll back draft creation, edits and publication without losing revisions", async () => {
    try {
      await failAudit("release_note.draft_saved");
      expect((await save("v1.0.5")).status).toBe(500);
      expect(await stored("v1.0.5")).toBeUndefined();
      expect(await auditCount("v1.0.5", "release_note.draft_saved")).toBe(0);
      await failAudit("");
      expect((await save("v1.0.5")).status).toBe(200);
      const before = await stored("v1.0.5");
      await failAudit("release_note.draft_saved");
      expect((await save("v1.0.5", 1, "Do not save")).status).toBe(500);
      expect(await stored("v1.0.5")).toEqual(before);
      expect(await auditCount("v1.0.5", "release_note.draft_saved")).toBe(1);
      await failAudit("release_note.published");
      expect((await publish("v1.0.5")).status).toBe(500);
      expect(await stored("v1.0.5")).toEqual(before);
      expect(await auditCount("v1.0.5")).toBe(0);
      await failAudit("");
      expect((await publish("v1.0.5")).status).toBe(200);
      expect(await auditCount("v1.0.5")).toBe(1);
      await failAudit("release_note.published");
      expect((await publish("v1.0.5")).status).toBe(200); // no duplicate audit is attempted
    } finally { await failAudit(""); }
  });

  test("stable tied timestamps paginate without duplicating notes and keep drafts out of public pages", async () => {
    for (const version of ["v9.0.1", "v9.0.2", "v9.0.3"]) {
      await postgres.db.query("INSERT INTO release_notes(version,title,content,created_at,updated_at,published_at) VALUES($1,'Page','Visible','2099-01-01','2099-01-01','2099-01-01')", [version]);
    }
    await postgres.db.query("INSERT INTO release_notes(version,title,content,updated_at) VALUES('v9.0.4','Private','Draft','2099-01-01')");
    const publicOne = await (await request("/api/release-notes?limit=2", designer)).json();
    const publicTwo = await (await request("/api/release-notes?limit=2&offset=2", designer)).json();
    expect(publicOne.notes.map((note: { version: string }) => note.version)).toEqual(["v9.0.3", "v9.0.2"]);
    expect(publicOne.hasMore).toBe(true);
    expect(publicTwo.notes[0].version).toBe("v9.0.1");
    expect(publicTwo.notes.some((note: { version: string }) => ["v9.0.2", "v9.0.3", "v9.0.4"].includes(note.version))).toBe(false);
    const adminOne = await (await request("/api/admin/release-notes?limit=2")).json();
    const adminTwo = await (await request("/api/admin/release-notes?limit=2&offset=2")).json();
    expect(adminOne.notes.map((note: { version: string }) => note.version)).toEqual(["v9.0.4", "v9.0.3"]);
    expect(adminTwo.notes.map((note: { version: string }) => note.version)).toEqual(["v9.0.2", "v9.0.1"]);
    expect((await (await request("/api/release-notes?offset=100", designer)).json())).toEqual({ notes: [], hasMore: false });
  });
});
