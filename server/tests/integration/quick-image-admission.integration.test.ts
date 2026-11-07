import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { MARK_IMAGE_PROVIDER_ID } from "../../../shared/mark-image-models";
import { quickImageModelId, quickImageTaskTarget, type QuickImageAction } from "../../../shared/quick-image-tools";
import type { Cache } from "../../src/db";
import type { PromptCompiler } from "../../src/prompt-compiler";
import { createTasksRouter } from "../../src/routes/tasks";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { preflightStoredQuickImageTask } from "../../src/stored-quick-image-preflight";
import { quickImageDefaultParameters } from "../../src/quick-image-tools";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("quick image HTTP admission through real schema, recipes, SQL and reservations", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>, base = "";
  let fetchGuard: { mockRestore(): void };
  const realFetch = globalThis.fetch.bind(globalThis);
  const ordinaryProvider = randomUUID(), ordinaryModel = randomUUID(), nanoModel = randomUUID(), maiModel = randomUUID(), flareModel = randomUUID(), decoyNano = randomUUID();
  const users = new Map<string, SessionUser>(), queued = new Set<string>();
  const sourceByUser = new Map<string, string>();
  let latestUser = "";
  const sourceBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGPkEpH77+ziyrhl1YL/x/8lOgIAM2oHblsijkgAAAAASUVORK5CYII=", "base64");
  let optimizerCalls = 0, externalCalls = 0;
  const cache = { eval: async (_script: string, options: { arguments: string[] }) => { queued.add(options.arguments[0]!); return 1; } } as unknown as Cache;
  const compiler = { compile: async () => { optimizerCalls++; throw new Error("Quick actions must not call a prompt optimizer"); } } as unknown as PromptCompiler;
  const query = (sql: string, values: unknown[] = []) => fixture.db.query<Record<string, any>>(sql, values);
  const send = (actor: string, body: unknown) => fetch(`${base}/api/tasks`, { method: "POST", headers: { "Content-Type": "application/json", "x-fixture-user": actor }, body: JSON.stringify(body) });
  const input = (action: QuickImageAction, canvas = false, owner = latestUser) => ({ requestId: randomUUID(), projectId: "quick-image-isolated", ...quickImageTaskTarget(action, canvas),
    parameters: { quickImageAction: action }, sourceUrls: [sourceByUser.get(owner)!] });
  async function user() {
    const id = randomUUID();
    await query("INSERT INTO users(id,username,display_name,role,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Quick image fixture','designer',1000,1000,1000)", [id, `quick-${id}`]);
    users.set(id, { id, role: "designer", departmentId: null, groupId: null, groupRole: null, status: "active", displayName: "Quick image fixture" } as SessionUser);
    const asset = randomUUID();
    await query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'source.png','image/png',$4,'image','ready')", [asset, id, `quick/${asset}`, sourceBytes.byteLength]);
    sourceByUser.set(id, `/api/assets/${asset}/content`); latestUser = id;
    return id;
  }
  const counts = async (actor: string) => ({
    tasks: Number((await query("SELECT count(*)::int AS count FROM tasks WHERE user_id=$1", [actor])).rows[0]!.count),
    reservations: Number((await query("SELECT count(*)::int AS count FROM credit_reservations WHERE user_id=$1", [actor])).rows[0]!.count),
    compilations: Number((await query("SELECT count(*)::int AS count FROM prompt_compilations WHERE user_id=$1", [actor])).rows[0]!.count),
  });

  beforeAll(async () => {
    fetchGuard = spyOn(globalThis, "fetch").mockImplementation(Object.assign((resource: string | URL | Request, init?: RequestInit) => {
      const url = resource instanceof Request ? resource.url : String(resource);
      if (!base || new URL(url).origin !== base) { externalCalls++; throw new Error("QUICK_IMAGE_TEST_EXTERNAL_IO_BLOCKED"); }
      return realFetch(resource, init);
    }, { preconnect: () => { throw new Error("No external preconnect allowed"); } }));
    fixture = await createIsolatedPostgres();
    for (const [id, name] of [[MARK_IMAGE_PROVIDER_ID, "Quick fixed provider"], [ordinaryProvider, "Quick ordinary provider"]]) {
      await query("INSERT INTO providers(id,name,protocol,base_url,enabled) VALUES($1,$2,'apimart','https://no-network.invalid/v1',true) ON CONFLICT(id) DO UPDATE SET enabled=true,protocol='apimart'", [id, name]);
    }
    for (const [id, provider, model] of [[nanoModel, MARK_IMAGE_PROVIDER_ID, quickImageModelId("hd-upscale")], [maiModel, MARK_IMAGE_PROVIDER_ID, quickImageModelId("remove-background")], [flareModel, MARK_IMAGE_PROVIDER_ID, quickImageModelId("item-extract")], [ordinaryModel, ordinaryProvider, "ordinary-model"], [decoyNano, ordinaryProvider, quickImageModelId("remove-background")]]) {
      await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,enabled,credit_cost,rmb_cost) VALUES($1,$2,$3,$3,ARRAY['generate','edit'],true,2,0)", [id, provider, model]);
    }
    await query("UPDATE module_flags SET enabled=true");
    await query("UPDATE tool_api_configurations SET enabled=true,model_config_id=$1,credit_cost_override=7,rmb_cost_override=0 WHERE tool_key=ANY($2::text[])", [ordinaryModel, ["image-edit", "detail-enhance", "canvas-edit"]]);
    const app = express(); app.use(express.json());
    // Authentication identity alone is fixture-owned; RBAC, task ownership and all business code remain real.
    app.use((req, res, next) => {
      const actor = users.get(req.get("x-fixture-user") || "");
      if (!actor) { res.status(401).json({ error: "UNAUTHENTICATED" }); return; }
      (req as AuthenticatedRequest).auth = actor; next();
    });
    app.use("/api/tasks", createTasksRouter(fixture.db, cache, true, undefined, { promptCompiler: compiler,
      quickImagePreflight: (db, value) => preflightStoredQuickImageTask(db, value, { readSource: async () => sourceBytes }) }));
    app.use(((error, _req, res, _next) => res.status(error instanceof ZodError ? 400 : error.status ?? 500).json({ error: error.code ?? "VALIDATION_ERROR", message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30_000);
  afterAll(async () => {
    try {
      if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
      await fixture?.close();
    } finally { fetchGuard?.mockRestore(); }
    expect(externalCalls).toBe(0); expect(optimizerCalls).toBe(0);
  });

  for (const action of ["remove-background", "hd-upscale", "item-extract"] as const) for (const canvas of [false, true]) {
    test(`${action} ${canvas ? "canvas" : "standalone"} accepts no prompt/model and persists only the fixed recipe`, async () => {
      const actor = await user(), value = input(action, canvas);
      const expectedModel = action === "remove-background" ? maiModel : action === "item-extract" ? flareModel : nanoModel;
      expect(value).not.toHaveProperty("prompt"); expect(value).not.toHaveProperty("modelConfigId");
      const response = await send(actor, value), body = await response.json();
      expect({ status: response.status, body }).toMatchObject({ status: 201, body: { task: { modelConfigId: expectedModel, toolKey: value.toolKey, credits: 7, optimized: false } } });
      const stored = (await query("SELECT model_config_id,prompt,parameters,source_urls,user_input,prompt_optimized FROM tasks WHERE id=$1", [body.task.id])).rows[0]!;
      expect(stored).toMatchObject({ model_config_id: expectedModel, source_urls: value.sourceUrls, user_input: null, prompt_optimized: false,
        parameters: { quickImageAction: action, ...quickImageDefaultParameters[action], n: 1, count: 1, quickImage: { action, recipeVersion: 1 } } });
      if (action === "remove-background") { expect(stored.parameters).not.toHaveProperty("size"); expect(stored.parameters).not.toHaveProperty("resolution"); }
      expect(stored.prompt).toContain(action === "hd-upscale" ? "configured output resolution" : action === "item-extract" ? "flat-lay presentation" : "foreground alpha matte");
      expect(stored.prompt).toBe(body.task.prompt); expect(queued.has(body.task.id)).toBe(true);
      const duplicate = await send(actor, value);
      expect(duplicate.status).toBe(200); expect((await duplicate.json()).task.id).toBe(body.task.id);
      expect(await counts(actor)).toEqual({ tasks: 1, reservations: 1, compilations: 0 });
      expect((await query("SELECT model_config_id FROM tool_api_configurations WHERE tool_key=$1", [value.toolKey])).rows[0]!.model_config_id).toBe(ordinaryModel);
    });
  }

  test.each(["remove-background", "hd-upscale", "item-extract"] as const)("%s twelve parallel duplicates share one task/reservation and remain employee-isolated", async action => {
    const actor = await user(), other = await user(), value = input(action, true, actor);
    const responses = await Promise.all(Array.from({ length: 12 }, () => send(actor, value)));
    expect(responses.every(response => response.status === 200 || response.status === 201)).toBe(true);
    const ids = await Promise.all(responses.map(async response => (await response.json()).task.id));
    expect(new Set(ids).size).toBe(1); expect(await counts(actor)).toEqual({ tasks: 1, reservations: 1, compilations: 0 });
    const stolen = await send(other, value); expect(stolen.status).toBe(400); expect((await stolen.json()).error).toBe("DUPLICATE_REQUEST");
    expect((await fetch(`${base}/api/tasks/${ids[0]}`, { headers: { "x-fixture-user": other } })).status).toBe(404);
    expect(await counts(other)).toEqual({ tasks: 0, reservations: 0, compilations: 0 });
    expect((await query("SELECT credit_balance FROM users WHERE id=$1", [actor])).rows[0]!.credit_balance).toBe(993);
  });

  test("module, parent, binding, role and fixed-provider gates fail before reservation/queue even with a decoy Nano model", async () => {
    const actor = await user(), queueBefore = queued.size;
    const gates = [
      ["UPDATE module_flags SET enabled=false WHERE module_key='image-edit'", "UPDATE module_flags SET enabled=true WHERE module_key='image-edit'", input("remove-background"), 403, "MODULE_DISABLED"],
      ["UPDATE module_flags SET enabled=false WHERE module_key='canvas'", "UPDATE module_flags SET enabled=true WHERE module_key='canvas'", input("hd-upscale", true), 403, "MODULE_DISABLED"],
      ["UPDATE tool_api_configurations SET enabled=false WHERE tool_key='detail-enhance'", "UPDATE tool_api_configurations SET enabled=true WHERE tool_key='detail-enhance'", input("hd-upscale"), 403, "TOOL_DISABLED"],
      [`UPDATE model_configs SET enabled=false WHERE id='${maiModel}'`, `UPDATE model_configs SET enabled=true WHERE id='${maiModel}'`, input("remove-background"), 400, "MODEL_DISABLED"],
    ] as const;
    for (const [disable, restore, value, status, code] of gates) {
      await query(disable);
      try { const response = await send(actor, value); expect(response.status).toBe(status); expect((await response.json()).error).toBe(code); }
      finally { await query(restore); }
    }
    expect((await send(actor, { ...input("remove-background"), priority: "urgent" })).status).toBe(403);
    expect((await send(actor, { ...input("remove-background"), toolKey: "creative-style-to-sketch" })).status).toBe(400);
    expect((await send(actor, { ...input("remove-background"), sourceUrls: [] })).status).toBe(400);
    expect((await send(actor, { ...input("remove-background"), requestId: "short" })).status).toBe(400);
    expect(await counts(actor)).toEqual({ tasks: 0, reservations: 0, compilations: 0 }); expect(queued.size).toBe(queueBefore);
  });

  test("forged execution settings are removed across the actual HTTP/SQL boundary", async () => {
    const actor = await user(), value = input("hd-upscale", true);
    const response = await send(actor, { ...value, prompt: "FORGED client prompt", modelConfigId: decoyNano,
      parameters: { ...value.parameters, size: "1:1", resolution: "1k", output_format: "jpeg", n: 20, inputArchive: { maskReferenceIndex: 1 }, imageAgentProfile: "creative-chat" },
      promptInput: { scene: "free-optimize", mode: "edit", userText: "FORGED optimize", fields: {}, referenceRoles: [], outputLanguage: "en", hasMask: false } });
    const body = await response.json(); expect(response.status).toBe(201);
    const stored = (await query("SELECT model_config_id,prompt,parameters,user_input,prompt_compilation_id FROM tasks WHERE id=$1", [body.task.id])).rows[0]!;
    expect(stored.model_config_id).toBe(nanoModel); expect(stored.prompt).not.toContain("FORGED");
    expect(stored.parameters).toEqual({ tool: "canvas-edit", n: 1, count: 1, size: "auto", resolution: "4k", quickImageAction: "hd-upscale", quickImage: { action: "hd-upscale", recipeVersion: 1, configurationVersion: 0 } });
    expect(stored.user_input).toBeNull(); expect(stored.prompt_compilation_id).toBeNull(); expect(optimizerCalls).toBe(0);
  });

  test("quick normalization cannot silently discard invalid document/profile input before admission", async () => {
    const actor = await user(), queueBefore = queued.size;
    const designDocumentCatalog = [{ id: "brief", name: "需求.pdf", kind: "pdf", sectionCount: 1, figureCount: 0,
      sections: [{ id: "brief:page-1", figureIds: [] }] }];
    const designRequirements = { title: "开衫", documentIds: ["brief"], subject: "女士开衫", colors: "蓝色", materials: "棉", must: [], avoid: [], unknowns: [],
      referenceFigureIds: [], sources: [{ documentId: "brief", sectionId: "brief:page-1" }] };
    for (const action of ["remove-background", "hd-upscale", "item-extract"] as const) for (const parameters of [
      { designRequirements, designDocumentCatalog },
      { imageAgentProfile: "creative-chat", designRequirements },
      { imageAgentProfile: "creative-chat", designDocumentCatalog },
    ]) {
      const value = input(action);
      const response = await send(actor, { ...value, parameters: { ...value.parameters, ...parameters } });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("imageAgentProfile" in parameters && !["image_generation", "inpaint"].includes(value.operationType)
        ? "IMAGE_AGENT_PROFILE_INVALID" : "IMAGE_AGENT_REQUIREMENTS_INVALID");
    }
    expect(await counts(actor)).toEqual({ tasks: 0, reservations: 0, compilations: 0 });
    expect(queued.size).toBe(queueBefore);
    expect((await query("SELECT credit_balance FROM users WHERE id=$1", [actor])).rows[0]!.credit_balance).toBe(1000);
  });
});
