import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { getToolDefinition } from "../../../shared/feature-catalog";
import { isQuickImageAction, quickImageTaskTarget } from "../../../shared/quick-image-tools";
import type { Cache } from "../../src/db";
import { createTasksRouter } from "../../src/routes/tasks";
import { taskHistoryBoards } from "../../src/task-history";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlSuite = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
sqlSuite("owner-bound, read-only board history across browsers", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const owner = randomUUID(), other = randomUUID(), model = randomUUID(), provider = randomUUID();
  const boardTaskIds = new Map<string, string>();
  const ordinaryIds: string[] = [], otherIds: string[] = [];
  const legacyIds = new Map<string, string>();
  const longPrompt = "完整提示词与编辑要求：".repeat(200);
  const sourceUrl = `/api/assets/${randomUUID()}/content`, resultUrl = `/api/assets/${randomUUID()}/content`;
  const noSideEffects = new Proxy({}, { get: (_object, key) => { throw new Error(`Unexpected cache/provider access: ${String(key)}`); } }) as Cache;
  const get = (board: string, suffix = "", userId = owner) => fetch(`${base}/history?board=${encodeURIComponent(board)}${suffix}`, { headers: { "x-test-owner": userId } });

  async function seedTask(input: { userId?: string; toolKey?: string | null; operationType?: string; parameters?: Record<string, unknown>; projectId?: string; queuedAt?: string; status?: string }) {
    const id = randomUUID();
    await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,tool_key,model_config_id,prompt,parameters,
      source_urls,result_urls,result_document,user_input,prompt_optimized,status,queued_at,started_at,completed_at,attempts)
      VALUES($1,$1::uuid::text,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,true,$13,$14::timestamptz,$14::timestamptz,$14::timestamptz,1)`,
    [id, input.userId ?? owner, input.projectId ?? "image-workbench", input.operationType ?? "image_generation", input.toolKey ?? null, model, longPrompt,
      JSON.stringify(input.parameters ?? { size: "1024x1024", inputArchive: { version: 1, ownerId: input.userId ?? owner, modelConfigId: model, modelId: "history-model",
        prompt: longPrompt, effectivePrompt: longPrompt, config: { imageModel: model, size: "1024x1024", apiKey: "ARCHIVE_PRIVATE_API_KEY", channels: [{ api_key: "NESTED_PRIVATE_KEY", model: "history-model" }] },
        references: [{ url: sourceUrl, name: "原图.png", role: "reference", sourceAssetId: sourceUrl.split("/")[3] }],
        parameters: { quality: "high", providerCredentials: { accessToken: "PRIVATE_ACCESS_TOKEN" } } }, authorization: "PRIVATE_AUTHORIZATION" }),
      JSON.stringify([sourceUrl]), JSON.stringify([resultUrl]), JSON.stringify({ version: 1, kind: "layers", layers: [{ imageUrl: resultUrl }], apiKey: "DOCUMENT_PRIVATE_KEY" }),
      JSON.stringify({ scene: "image-generation", userText: longPrompt, fields: { material: "cotton" }, password: "PRIVATE_PASSWORD" }),
      input.status ?? "success", input.queuedAt ?? "2026-11-13T10:00:00.123456Z"]);
    return id;
  }

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,'history-owner','History owner','super_admin'),($2,'history-other','Other owner','designer')", [owner, other]);
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'history-provider','openai','https://never-called.invalid','PROVIDER_PRIVATE_SECRET')", [provider]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Saved history model','history-model',ARRAY['generate','edit','video'])", [model, provider]);
    for (let index = 0; index < 95; index++) {
      ordinaryIds.push(await seedTask({ toolKey: "image", status: ["waiting", "processing", "paused", "success", "failed", "cancelled"][index % 6], queuedAt: `2026-11-13T10:00:00.12345${index % 3}Z` }));
      if (index % 5 === 0) otherIds.push(await seedTask({ userId: other, toolKey: "image" }));
    }
    for (const board of taskHistoryBoards.filter(board => board !== "image-generation")) {
      const target = isQuickImageAction(board) ? quickImageTaskTarget(board) : { toolKey: board, operationType: getToolDefinition(board)!.operationType };
      boardTaskIds.set(board, await seedTask({ ...target, parameters: { tool: target.toolKey, ...(isQuickImageAction(board) ? { quickImageAction: board } : {}), size: "auto" } }));
    }
    legacyIds.set("image-generation", await seedTask({ parameters: { tool: "image-generation" } }));
    legacyIds.set("image-edit", await seedTask({ operationType: "inpaint", parameters: { tool: "image-edit" } }));
    legacyIds.set("remove-background", await seedTask({ operationType: "inpaint", parameters: { tool: "image-edit", quickImageAction: "remove-background" } }));
    legacyIds.set("creative-style-to-sketch", await seedTask({ operationType: "inpaint", parameters: { tool: "creative-style-to-sketch" } }));
    // Unknown origin, misleading operation, canvas/chat origins and mismatched quick actions must remain out of these boards.
    for (const input of [
      { parameters: {} }, { parameters: { tool: "unknown-original-board" } },
      { toolKey: "canvas-image", parameters: { tool: "image-generation" } },
      { toolKey: "gpt-chat-image" }, { toolKey: "canvas-video", operationType: "video_generation" },
      { toolKey: "canvas-edit", operationType: "inpaint", parameters: { quickImageAction: "remove-background" } },
      { toolKey: "image-edit", operationType: "inpaint", parameters: { quickImageAction: "hd-upscale" } },
      { toolKey: "image-edit", operationType: "inpaint", parameters: { quickImageAction: "unknown-action" } },
      { toolKey: "image", operationType: "video_generation" },
      { toolKey: "image-edit", operationType: "inpaint", projectId: "admin-quick-image-test", parameters: { quickImageAction: "remove-background" } },
      { toolKey: "detail-enhance", operationType: "upscale", parameters: { quickImageAction: "hd-upscale", quickImage: { adminTest: true } } },
    ]) await seedTask(input);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: request.header("x-test-owner") || owner, role: "super_admin", departmentId: null } }); next(); });
    app.use("/api/tasks", createTasksRouter(fixture.db, noSideEffects, false, async () => { throw new Error("Unexpected provider preflight"); }));
    app.use(((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.name })) as express.ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`;
  }, 120000);
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await fixture?.close();
  });

  test("all 96 own image records paginate past the old 60-row cap with precise stable cursors", async () => {
    const expected = (await fixture.db.query("SELECT id FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY queued_at DESC,id DESC", [[...ordinaryIds, legacyIds.get("image-generation")]])).rows.map(row => row.id);
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      // A new request has no browser-local history or request state.
      const response = await get("image-generation", cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json();
      expect(body.tasks.length).toBeLessThanOrEqual(30);
      expect(body.tasks.every((task: any) => task.userId === owner && !otherIds.includes(task.id))).toBe(true);
      seen.push(...body.tasks.map((task: any) => task.id));
      expect(body.hasMore).toBe(body.nextCursor !== null);
      cursor = body.nextCursor; pages++;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(96);
  });

  test("full owned task details restore prompts, source/result URLs, models and input archives without credentials", async () => {
    const body = await (await get("image-generation")).json();
    const task = body.tasks.find((row: any) => ordinaryIds.includes(row.id));
    expect(task).toMatchObject({ prompt: longPrompt, sourceUrls: [sourceUrl], resultUrls: [resultUrl], modelConfigId: model, modelId: "history-model", modelName: "Saved history model", optimized: true,
      parameters: { inputArchive: { prompt: longPrompt, effectivePrompt: longPrompt, modelConfigId: model, references: [{ url: sourceUrl }], config: { imageModel: model, size: "1024x1024" } } },
      userInput: { userText: longPrompt, fields: { material: "cotton" } }, resultDocument: { layers: [{ imageUrl: resultUrl }] } });
    expect(task.prompt.length).toBeGreaterThan(240);
    expect(task.cursorCreatedAt).toBeUndefined();
    const serialized = JSON.stringify(body);
    for (const value of ["PRIVATE_", "PROVIDER_PRIVATE_SECRET", "encrypted_credentials", "apiKey", "api_key", "authorization", "password", "providerCredentials"]) expect(serialized).not.toContain(value);
  });

  test("even a super-admin personal history is owner-bound and foreign cursors cannot cross owners", async () => {
    const first = await (await get("image-generation", "&limit=1")).json();
    const ownOther = await (await get("image-generation", "", other)).json();
    expect(ownOther.tasks.map((task: any) => task.id).sort()).toEqual([...otherIds].sort());
    expect(ownOther.tasks.every((task: any) => task.userId === other)).toBe(true);
    const foreignCursor = await (await get("image-generation", `&cursor=${encodeURIComponent(first.nextCursor)}`, other)).json();
    expect(foreignCursor.tasks.every((task: any) => task.userId === other && otherIds.includes(task.id))).toBe(true);
    const absent = await (await get("image-generation", "", randomUUID())).json();
    expect(absent).toEqual({ tasks: [], nextCursor: null, hasMore: false });
  });

  test("each exact business board separates canonical quick actions, canvas and ambiguous legacy origins", async () => {
    for (const [board, id] of boardTaskIds) {
      const response = await get(board);
      expect(response.status).toBe(200);
      const body = await response.json();
      const expected = [id, ...(legacyIds.has(board) ? [legacyIds.get(board)!] : [])].sort();
      expect(body.tasks.map((task: any) => task.id).sort()).toEqual(expected);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
    }
  });

  test("invalid boards, oversized pages and invalid cursors reject before reading the database", async () => {
    const before = fixture.statements.length;
    for (const suffix of ["", "?board=unknown", "?board=canvas-image", "?board=gpt-chat-image", "?board=creative-unknown", "?board=image-generation&limit=31", "?board=image-generation&limit=0", "?board=image-generation&cursor=bad", "?board=image-generation&cursor=" + Buffer.from(JSON.stringify(["2026-11-13T00:00:00Z", "not-a-uuid"])).toString("base64url")]) {
      const response = await fetch(`${base}/history${suffix}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(fixture.statements.length).toBe(before);
  });

  test("history never submits, requeues, bills, modifies saved tasks or reads provider secrets", async () => {
    const before = await fixture.db.query("SELECT row_to_json(t) AS row FROM tasks t ORDER BY id");
    const start = fixture.statements.length;
    expect((await get("image-generation")).status).toBe(200);
    expect((await get("remove-background")).status).toBe(200);
    expect((await get("video")).status).toBe(200);
    expect((await fetch(`${base}/history`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: "image-generation" }) })).status).toBe(404);
    const statements = fixture.statements.slice(start);
    expect(statements).toHaveLength(3);
    for (const sql of statements) {
      expect(sql.trim()).toStartWith("SELECT ");
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|providers|encrypted_credentials|credit_reservations|wallets)\b/i);
    }
    expect((await fixture.db.query("SELECT row_to_json(t) AS row FROM tasks t ORDER BY id")).rows).toEqual(before.rows);
  });
});
