import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import express, { type ErrorRequestHandler } from "express";
import { MARK_IMAGE_PROVIDER_ID } from "../../../shared/mark-image-models";
import { initializeCanvasDesignChatModel } from "../../src/chat-model-policy";
import { createChatRouter } from "../../src/routes/chat";
import { encryptSecret } from "../../src/security";
import { resolveToolExecution } from "../../src/tool-configuration";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

sqlTest("independent design discussion initializes real Sol UUID, preserves existing chat and fails closed", async () => {
  const postgres = await createIsolatedPostgres();
  const { db } = postgres;
  const calls: Array<{ model: string; messages?: unknown[] }> = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages?: unknown[] };
    calls.push(body);
    return Response.json({ choices: [{ message: { role: "assistant", content: "本地模型回执" }, finish_reason: "stop" }] });
  } });
  const encryptionKey = Buffer.alloc(32, 23).toString("base64");
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  try {
    const row = async () => (await db.query("SELECT model_config_id,enabled,configuration_version,updated_by FROM tool_api_configurations WHERE tool_key='canvas-design-chat'")).rows[0];
    expect(await row()).toMatchObject({ model_config_id: null, enabled: true, configuration_version: 1 });
    await initializeCanvasDesignChatModel(db);
    await expect(resolveToolExecution(db, { toolKey: "canvas-design-chat", operationType: "chat", modelId: "gpt-6.2-sol" })).rejects.toMatchObject({ code: "CHAT_MODEL_NOT_CONFIGURED", status: 503 });
    await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Design fixture','apimart',$2,$3)", [MARK_IMAGE_PROVIDER_ID, `http://127.0.0.1:${upstream.port}/v1`, encryptSecret(JSON.stringify({ apiKey: "local-fixture-only" }), encryptionKey)]);
    const sol = (await db.query("INSERT INTO model_configs(provider_id,name,model_id,capabilities) VALUES($1,'aplmart-gpt-6.2-sol','gpt-6.2-sol',ARRAY['chat','vision','tools']) RETURNING id", [MARK_IMAGE_PROVIDER_ID])).rows[0].id;
    const alternative = (await db.query("INSERT INTO model_configs(provider_id,name,model_id,capabilities) VALUES($1,'Other discussion model','alternative-chat',ARRAY['chat','vision','tools']) RETURNING id", [MARK_IMAGE_PROVIDER_ID])).rows[0].id;
    const actorId = (await db.query("INSERT INTO users(username,display_name) VALUES('design-chat-fixture','Design chat fixture') RETURNING id")).rows[0].id;
    await db.query("UPDATE tool_api_configurations SET model_config_id=$1,configuration_version=7,updated_by=$2 WHERE tool_key='gpt-chat'", [alternative, actorId]);
    const prior = (await db.query("SELECT * FROM tool_api_configurations WHERE tool_key IN ('gpt-chat','canvas-chat') ORDER BY tool_key")).rows;
    await db.query("UPDATE model_configs SET enabled=false WHERE id=$1", [sol]);
    await initializeCanvasDesignChatModel(db);
    expect((await row()).model_config_id).toBeNull();
    await db.query("UPDATE model_configs SET enabled=true WHERE id=$1", [sol]);
    await initializeCanvasDesignChatModel(db);
    expect(await row()).toMatchObject({ model_config_id: sol, configuration_version: 2 });
    expect(sol).not.toBe("gpt-6.2-sol");
    await db.query("DELETE FROM tool_api_configurations WHERE tool_key='canvas-design-chat'");
    const migration = await readFile(new URL("../../src/migrations/053_canvas_design_chat.sql", import.meta.url), "utf8");
    const seedsAt = migration.indexOf("INSERT INTO module_flags");
    expect(seedsAt).toBeGreaterThan(0);
    const client = await db.connect();
    try { await client.query(`DO $design_chat_seed_replay$ BEGIN\n${migration.slice(seedsAt)}\nEND; $design_chat_seed_replay$`); } finally { client.release(); }
    expect((await db.query("SELECT enabled FROM module_flags WHERE module_key='canvas-tryout'")).rows).toEqual([{ enabled: false }]);
    expect(await row()).toMatchObject({ model_config_id: null, configuration_version: 1 });
    await initializeCanvasDesignChatModel(db);
    expect(await row()).toMatchObject({ model_config_id: sol, configuration_version: 2 });
    expect((await db.query("SELECT * FROM tool_api_configurations WHERE tool_key IN ('gpt-chat','canvas-chat') ORDER BY tool_key")).rows).toEqual(prior);
    expect((await db.query("SELECT enabled FROM module_flags WHERE module_key='canvas-design-chat'")).rows[0].enabled).toBe(true);
    app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: actorId, role: "designer", departmentId: null } }); next(); });
    app.use("/chat", createChatRouter(db, { AUTH_ENABLED: "false", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never));
    app.use(((error, _request, response, _next) => { response.status(error.status ?? 500).json({ error: error.code, message: error.message }); }) as ErrorRequestHandler);
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const post = (patch: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${address.port}/chat/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        requestId: crypto.randomUUID(), toolKey: "canvas-design-chat", modelId: alternative, profile: "creative-chat", tools: [],
        claude: { stream: false }, input: [{ role: "user", content: "先讨论配色，不生成" }],
        profileContext: { stage: "plan", currentUserText: "先讨论配色，不生成", newCreation: true, imageCatalog: [], previewImageIds: [], workNote: "" }, ...patch,
      }), signal: AbortSignal.timeout(10000),
    });
    expect((await post()).status).toBe(200);
    expect(calls.at(-1)?.model).toBe("gpt-6.2-sol");
    expect((await resolveToolExecution(db, { toolKey: "canvas-chat", operationType: "chat" })).modelConfigId).toBe(alternative);
    await db.query("UPDATE tool_api_configurations SET model_config_id=$1,updated_by=$2,configuration_version=3 WHERE tool_key='canvas-design-chat'", [alternative, actorId]);
    await initializeCanvasDesignChatModel(db);
    expect((await row()).model_config_id).toBe(alternative);
    expect((await post({ modelId: sol })).status).toBe(200);
    expect(calls.at(-1)?.model).toBe("alternative-chat");
    await db.query("UPDATE tool_api_configurations SET model_config_id=NULL,updated_by=NULL WHERE tool_key='canvas-design-chat'");
    await initializeCanvasDesignChatModel(db);
    expect((await row()).model_config_id).toBeNull();
    const missing = await post();
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: "CHAT_MODEL_NOT_CONFIGURED", message: "管理员尚未配置自由画布设计讨论模型" });
    await db.query("UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='canvas-design-chat'", [sol]);
    await db.query("UPDATE providers SET enabled=false WHERE id=$1", [MARK_IMAGE_PROVIDER_ID]);
    expect((await post()).status).toBe(400);
    expect(calls).toHaveLength(2);
    expect((await db.query("SELECT * FROM tool_api_configurations WHERE tool_key IN ('gpt-chat','canvas-chat') ORDER BY tool_key")).rows).toEqual(prior);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    upstream.stop(true);
    await postgres.close();
  }
}, 30000);
