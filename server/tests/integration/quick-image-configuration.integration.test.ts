import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import type { Cache } from "../../src/db";
import type { AppConfig } from "../../src/config";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createModelConfigurationRouter } from "../../src/routes/model-configuration";
import { createTasksRouter } from "../../src/routes/tasks";
import { preflightStoredQuickImageTask } from "../../src/stored-quick-image-preflight";
import { prepareConfiguredQuickImageTask } from "../../src/quick-image-configuration";
import { QUICK_IMAGE_SNAPSHOT } from "../../src/quick-image-tools";
import { MARK_IMAGE_PROVIDER_ID } from "../../../shared/mark-image-models";
import { quickImageTaskTarget, type QuickImageAction } from "../../../shared/quick-image-tools";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGPkEpH77+ziyrhl1YL/x/8lOgIAM2oHblsijkgAAAAASUVORK5CYII=", "base64");

integration("administrator quick image configuration through real SQL and queue admission", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>, server: ReturnType<ReturnType<typeof express>["listen"]>, base = "";
  let guard: { mockRestore(): void }, externalCalls = 0;
  let onRead: (() => Promise<void>) | undefined;
  const realFetch = globalThis.fetch.bind(globalThis);
  const identities = new Map<string, SessionUser>(), objects = new Map<string, Uint8Array>(), queued = new Set<string>();
  const admin = randomUUID(), designer = randomUUID(), department = randomUUID(), departmentId = randomUUID(), other = randomUUID();
  const provider = randomUUID(), nano = randomUUID(), mai = randomUUID(), alternative = randomUUID(), ordinary = randomUUID(), mj = randomUUID(), disabled = randomUUID();
  const query = (sql: string, values: unknown[] = []) => fixture.db.query<Record<string, any>>(sql, values);
  const cache = { eval: async (_script: string, options: { arguments: string[] }) => { queued.add(options.arguments[0]!); return 1; } } as unknown as Cache;
  const preflight: typeof preflightStoredQuickImageTask = (db, input) => preflightStoredQuickImageTask(db, input, { readSource: async key => {
    const hook = onRead; onRead = undefined; await hook?.();
    const source = objects.get(key); if (!source) throw new Error("Missing fixture-owned object"); return source;
  } });
  const request = (actor: string | null, path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(actor ? { "x-user": actor } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const route = (action: QuickImageAction) => `/api/admin/model-configuration/quick-images/${action}`;
  const configuration = (modelConfigId = alternative, prompt = "Restore the existing product faithfully.", parameters: Record<string, unknown> = { resolution: "2k", size: "auto", quality: "high" }) => ({ modelConfigId, prompt, parameters });
  const save = (action: QuickImageAction, expectedVersion: number, value = configuration()) => request(admin, route(action), "PUT", { ...value, expectedVersion });
  const ordinaryRequest = (action: QuickImageAction, sourceUrl: string, overrides = {}) => ({ requestId: randomUUID(), projectId: "quick-config-fixture", ...quickImageTaskTarget(action), parameters: { quickImageAction: action }, sourceUrls: [sourceUrl], ...overrides });
  async function source(owner = designer, bytes: Uint8Array = png, mimeType = "image/png") {
    const id = randomUUID(), objectKey = `quick/${id}`; objects.set(objectKey, bytes);
    await query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'source.png',$4,$5,'image','ready')", [id, owner, objectKey, mimeType, bytes.byteLength]);
    return `/api/assets/${id}/content`;
  }
  const counts = async () => ({ tasks: Number((await query("SELECT count(*)::int AS n FROM tasks")).rows[0]!.n), holds: Number((await query("SELECT count(*)::int AS n FROM credit_reservations")).rows[0]!.n), queued: queued.size });
  beforeAll(async () => {
    guard = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!base || new URL(url).origin !== base) { externalCalls++; throw new Error("QUICK_CONFIGURATION_EXTERNAL_IO_BLOCKED"); }
      return realFetch(input, init);
    }, { preconnect: () => { throw new Error("No external preconnect"); } }));
    fixture = await createIsolatedPostgres();
    await query("INSERT INTO departments(id,name,code) VALUES($1,'Quick configuration department',$2)", [departmentId, `quick-${departmentId}`]);
    for (const [id, role] of [[admin, "super_admin"], [designer, "designer"], [department, "department_admin"], [other, "designer"]] as const) {
      await query("INSERT INTO users(id,username,display_name,role,department_id,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Quick config test',$3,$4,1000,1000,1000)", [id, `quick-config-${id}`, role, role === "department_admin" ? departmentId : null]);
      identities.set(id, { id, role, departmentId: role === "department_admin" ? departmentId : null, groupId: null, groupRole: null, status: "active", displayName: "Quick config test" } as SessionUser);
    }
    for (const id of [MARK_IMAGE_PROVIDER_ID, provider]) await query("INSERT INTO providers(id,name,protocol,base_url,enabled) VALUES($1,$2,'apimart','https://no-network.invalid/v1',true) ON CONFLICT(id) DO UPDATE SET protocol='apimart',enabled=true", [id, `Quick provider ${id}`]);
    for (const [id, owner, modelId] of [[nano, MARK_IMAGE_PROVIDER_ID, "gemini-nano-banana-2.1"], [mai, MARK_IMAGE_PROVIDER_ID, "mai-image-2.6-flash"], [alternative, provider, "gpt-image-2.6-flare"], [ordinary, provider, "ordinary-model"], [mj, provider, "midjourney"], [disabled, provider, "gpt-image-2.5-flare"]]) {
      await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,enabled,credit_cost,rmb_cost) VALUES($1,$2,$3,$3,ARRAY['generate','edit'],true,2,0)", [id, owner, modelId]);
    }
    await query("UPDATE model_configs SET enabled=false WHERE id=$1", [disabled]);
    await query("UPDATE module_flags SET enabled=true");
    await query("UPDATE tool_api_configurations SET enabled=true,model_config_id=$1,credit_cost_override=7,rmb_cost_override=0 WHERE tool_key=ANY($2::text[])", [ordinary, ["image-edit", "detail-enhance", "canvas-edit"]]);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const actor = identities.get(req.get("x-user") || ""); if (actor) (req as AuthenticatedRequest).auth = actor; next(); });
    app.use("/api/admin/model-configuration", createModelConfigurationRouter(fixture.db, {} as AppConfig, { cache, quickImagePreflight: preflight }));
    app.use("/api/tasks", (req, res, next) => { if (!(req as AuthenticatedRequest).auth) { res.status(401).json({ error: "UNAUTHENTICATED" }); return; } next(); }, createTasksRouter(fixture.db, cache, true, undefined, { quickImagePreflight: preflight }));
    app.use(((error, _req, res, _next) => res.status(error instanceof ZodError ? 400 : error.status ?? 500).json({ error: error.code ?? "VALIDATION_ERROR", message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30_000);
  beforeEach(async () => { onRead = undefined; await query("DELETE FROM quick_image_configurations"); });
  afterAll(async () => {
    try { if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } await fixture?.close(); }
    finally { guard?.mockRestore(); }
    expect(externalCalls).toBe(0);
  });

  test("absence keeps separate defaults; only supported edit models are listed without credentials", async () => {
    const response = await request(admin, "/api/admin/model-configuration/quick-images"), body = await response.json();
    expect(response.status).toBe(200); expect(body.configurations).toHaveLength(2);
    expect(body.configurations.find((value: any) => value.action === "remove-background")).toMatchObject({ modelConfigId: mai, configurationVersion: 0, isDefault: true, parameters: {} });
    expect(body.configurations.find((value: any) => value.action === "hd-upscale")).toMatchObject({ modelConfigId: nano, configurationVersion: 0, parameters: { resolution: "4k" } });
    const ids = body.models.map((model: any) => model.id); expect(ids).toContain(alternative); expect(ids).not.toContain(mj); expect(ids).not.toContain(disabled); expect(ids).not.toContain(ordinary);
    expect(JSON.stringify(body)).not.toMatch(/baseUrl|credentials|apiKey/);
    expect((await query("SELECT count(*)::int AS n FROM quick_image_configurations")).rows[0]!.n).toBe(0);
  });

  test("all endpoints require real super-admin identity, including draft tests", async () => {
    for (const actor of [null, designer, department]) for (const [method, suffix, body] of [["GET", "", undefined], ["PUT", "/hd-upscale", { ...configuration(), expectedVersion: 0 }], ["POST", "/hd-upscale/test", { requestId: randomUUID(), sourceUrl: "unused", configuration: configuration() }]] as const) {
      expect((await request(actor, `/api/admin/model-configuration/quick-images${suffix}`, method, body)).status).toBe(actor ? 403 : 401);
    }
  });

  test("CAS create/update is atomic, separate per action, audited without raw prompt, and leaves ordinary bindings unchanged", async () => {
    const before = (await query("SELECT * FROM tool_api_configurations ORDER BY tool_key")).rows;
    const prompt = "PRIVATE_ADMIN_QUICK_PROMPT preserve product";
    const responses = await Promise.all([save("hd-upscale", 0, configuration(alternative, prompt)), save("hd-upscale", 0, configuration(alternative, "parallel"))]);
    expect(responses.map(result => result.status).sort()).toEqual([200, 409]);
    const current = (await query("SELECT * FROM quick_image_configurations WHERE action='hd-upscale'")).rows[0]!;
    expect(current.configuration_version).toBe(1);
    const updated = await save("hd-upscale", 1, configuration(alternative, prompt)); expect(updated.status).toBe(200);
    expect((await updated.json()).configuration).toMatchObject({ configurationVersion: 2, isDefault: false, modelConfigId: alternative, prompt });
    expect((await save("remove-background", 0, configuration(mai, "Only the product, exclude hands", {}))).status).toBe(200);
    expect((await query("SELECT * FROM tool_api_configurations ORDER BY tool_key")).rows).toEqual(before);
    const audits = (await query("SELECT detail FROM audit_logs WHERE action='quick_image_configuration.updated'")).rows;
    expect(audits.length).toBeGreaterThanOrEqual(3); expect(JSON.stringify(audits)).not.toContain("PRIVATE_ADMIN_QUICK_PROMPT"); expect(audits.at(-1)!.detail.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("parameter and protocol injection, invalid model/params and unsafe output reject before saving", async () => {
    for (const parameters of [{ image_urls: "https://evil.invalid" }, { mask_url: "https://evil.invalid" }, { markup: "<svg/>" }, { userId: admin }, { operationType: "chat" }, { n: 2 }, { count: 2 }, { safety_identifier: "employee" }, { quality: {} }, { resolution: "8k" }, { output_format: "gif" }, { output_format: "svg" }, { size: "bad" }]) {
      expect((await save("hd-upscale", 0, configuration(alternative, "valid prompt", parameters))).status).toBe(400);
    }
    expect((await save("hd-upscale", 0, configuration(mj, "valid", {}))).status).toBe(400);
    expect((await save("hd-upscale", 0, configuration(disabled, "valid", {}))).status).toBe(400);
    expect((await save("hd-upscale", 0, configuration(mai, "valid", { resolution: "4k" }))).status).toBe(400);
    expect((await save("hd-upscale", 0, configuration(alternative, " ", {}))).status).toBe(400);
    expect((await save("hd-upscale", 0, configuration(alternative, "x".repeat(4001), {}))).status).toBe(400);
    expect((await query("SELECT count(*)::int AS n FROM quick_image_configurations")).rows[0]!.n).toBe(0);
  });

  test("ordinary requests cannot forge snapshots, prompt or parameters, and preserve one frozen configuration across concurrent edits", async () => {
    expect((await save("hd-upscale", 0, configuration(alternative, "VERSION_ONE", { resolution: "2k", size: "auto" }))).status).toBe(200);
    const src = await source();
    onRead = async () => { expect((await save("hd-upscale", 1, configuration(nano, "VERSION_TWO", { resolution: "4k", size: "auto" }))).status).toBe(200); };
    const input = ordinaryRequest("hd-upscale", src, { modelConfigId: ordinary, prompt: "FORGED", toolConfiguration: { modelConfigId: ordinary },
      quickImageConfiguration: configuration(ordinary, "FORGED"), parameters: { quickImageAction: "hd-upscale", quickImage: { configurationVersion: 999 }, resolution: "1k", n: 9, mask_url: "https://evil.invalid" } });
    const response = await request(designer, "/api/tasks", "POST", input), body = await response.json();
    expect({ status: response.status, body }).toMatchObject({ status: 201, body: { task: { modelConfigId: alternative, prompt: "VERSION_ONE", parameters: { n: 1, resolution: "2k", quickImage: { configurationVersion: 1 } } } } });
    const stored = (await query("SELECT model_config_id,prompt,parameters FROM tasks WHERE id=$1", [body.task.id])).rows[0]!;
    expect(stored).toMatchObject({ model_config_id: alternative, prompt: "VERSION_ONE", parameters: { resolution: "2k" } }); expect(JSON.stringify(stored)).not.toMatch(/FORGED|mask_url|999/);
    const repeat = await request(designer, "/api/tasks", "POST", input); expect(repeat.status).toBe(200); expect((await repeat.json()).task.id).toBe(body.task.id);
    const prepared = await prepareConfiguredQuickImageTask(fixture.db, { ...ordinaryRequest("hd-upscale", src), prompt: "" });
    expect(Object.isFrozen(prepared[QUICK_IMAGE_SNAPSHOT])).toBe(true); expect(Object.isFrozen(prepared[QUICK_IMAGE_SNAPSHOT]!.parameters)).toBe(true);
  });

  test("draft tests use real tasks/credits and are idempotent without saving or selecting the published config", async () => {
    const initial = await counts(), src = await source(admin);
    const input = { requestId: randomUUID(), sourceUrl: src, configuration: configuration(alternative, "DRAFT_ONLY", { resolution: "2k", size: "auto" }) };
    const responses = await Promise.all([request(admin, `${route("remove-background")}/test`, "POST", input), request(admin, `${route("remove-background")}/test`, "POST", input)]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(responses.every(response => [200, 201].includes(response.status))).toBe(true); expect(new Set(bodies.map(body => body.task.id)).size).toBe(1);
    const stored = (await query("SELECT * FROM tasks WHERE request_id=$1", [input.requestId])).rows[0]!;
    expect(stored).toMatchObject({ user_id: admin, model_config_id: alternative, credits: 7, prompt_optimized: false, parameters: { n: 1, count: 1, quickImage: { adminTest: true, recipeVersion: 1 } } });
    expect(stored.prompt).toContain("DRAFT_ONLY"); expect(stored.prompt).toContain("original RGB pixels"); expect(stored.prompt).toContain("Mandatory output contract");
    expect((await query("SELECT count(*)::int AS n FROM quick_image_configurations")).rows[0]!.n).toBe(0);
    expect(await counts()).toEqual({ tasks: initial.tasks + 1, holds: initial.holds + 1, queued: initial.queued + 1 });
    await query("UPDATE tasks SET status='paused',upstream_submission_started_at=now(),attempts=1 WHERE id=$1", [stored.id]);
    const recovered = await request(admin, `/api/tasks/by-request/${encodeURIComponent(input.requestId)}`); expect(recovered.status).toBe(200); expect((await recovered.json()).task.id).toBe(stored.id);
    const repeated = await request(admin, `${route("remove-background")}/test`, "POST", { ...input, configuration: configuration(nano, "CHANGED", {}) });
    expect(repeated.status).toBe(200); expect((await repeated.json()).task.status).toBe("paused"); expect(await counts()).toEqual({ tasks: initial.tasks + 1, holds: initial.holds + 1, queued: initial.queued + 1 });
  });

  test("foreign, corrupt, unsafe and changed source assets fail before a task, reservation or queue entry", async () => {
    const initial = await counts(), foreign = await source(other), corrupt = await source(designer, Buffer.from("broken")), svg = await source(designer, Buffer.from("<svg/>"), "image/svg+xml");
    for (const src of [foreign, corrupt, svg, "https://evil.invalid/image.png"]) {
      expect((await request(designer, "/api/tasks", "POST", ordinaryRequest("remove-background", src))).status).toBe(400);
    }
    const changed = await source();
    onRead = async () => { await query("UPDATE assets SET status='failed' WHERE id=$1", [changed.split("/")[3]]); };
    expect((await request(designer, "/api/tasks", "POST", ordinaryRequest("remove-background", changed))).status).toBe(400);
    expect(await counts()).toEqual(initial);
  });

  test("selected adapter reference limits and model changes fail before task or credit admission", async () => {
    expect((await save("hd-upscale", 0, configuration())).status).toBe(200);
    const initial = await counts();
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1); png.copy(oversized);
    const src = await source(designer, oversized);
    const rejected = await request(designer, "/api/tasks", "POST", ordinaryRequest("hd-upscale", src));
    expect(rejected.status).toBe(400); expect((await rejected.json()).message).toContain("20MB");
    const valid = await source();
    onRead = async () => { await query("UPDATE model_configs SET enabled=false WHERE id=$1", [alternative]); };
    try { expect((await request(designer, "/api/tasks", "POST", ordinaryRequest("hd-upscale", valid))).status).toBe(400); }
    finally { await query("UPDATE model_configs SET enabled=true WHERE id=$1", [alternative]); }
    expect(await counts()).toEqual(initial);
  });
});
