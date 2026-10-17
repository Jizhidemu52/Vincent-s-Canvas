import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { MARK_IMAGE_PROVIDER_ID } from "../../../shared/mark-image-models";
import { initializeDefaultChatModel } from "../../src/chat-model-policy";
import type { Database } from "../../src/db";
import { createChatRouter } from "../../src/routes/chat";
import { encryptSecret } from "../../src/security";

const runtime = process.env.PGLITE_RUNTIME_PATH;
const integration = runtime ? describe : describe.skip;
const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));

integration("isolated PostgreSQL shared chat policy", () => {
  let database: any;
  let db: Database;
  let sonnet: string;
  let alternative: string;
  let actorId: string;
  beforeAll(async () => {
    const requireRuntime = createRequire(resolve(runtime!, "package.json"));
    const { PGlite } = requireRuntime("@electric-sql/pglite");
    const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
    const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
    database = new PGlite({ extensions: { pgcrypto, citext } });
    await database.waitReady;
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      await database.exec(await readFile(`${migrations}/${name}`, "utf8"));
    }
    db = { query: async (sql: string, values: unknown[] = []) => {
      const result = await database.query(sql, values);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    } } as unknown as Database;
    await db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Shared chat test','apimart','https://never-called.invalid')", [MARK_IMAGE_PROVIDER_ID]);
    sonnet = (await db.query("INSERT INTO model_configs(provider_id,name,model_id,capabilities) VALUES($1,'Sonnet test','claude-sonnet-5-5',ARRAY['chat']) RETURNING id", [MARK_IMAGE_PROVIDER_ID])).rows[0].id;
    alternative = (await db.query("INSERT INTO model_configs(provider_id,name,model_id,capabilities) VALUES($1,'Astra test','gpt-6-astra',ARRAY['chat']) RETURNING id", [MARK_IMAGE_PROVIDER_ID])).rows[0].id;
    actorId = (await db.query("INSERT INTO users(username,display_name) VALUES('chat-policy-designer','Chat policy designer') RETURNING id")).rows[0].id;
  }, 30000);
  afterAll(async () => { await database?.close(); });

  test("first initialization and migration seed Sonnet but preserve administrative selection and clearing", async () => {
    const row = async () => (await db.query("SELECT model_config_id,enabled,credit_cost_override,configuration_version FROM tool_api_configurations WHERE tool_key='gpt-chat'")).rows[0];
    await db.query("UPDATE tool_api_configurations SET enabled=false,credit_cost_override=11 WHERE tool_key='gpt-chat'");
    await initializeDefaultChatModel(db);
    expect(await row()).toMatchObject({ model_config_id: sonnet, enabled: false, credit_cost_override: 11, configuration_version: 2 });
    await initializeDefaultChatModel(db);
    expect((await row()).configuration_version).toBe(2);
    const migration = await readFile(`${migrations}/031_default_chat_model.sql`, "utf8");
    for (const model of [alternative, null]) {
      await db.query("UPDATE tool_api_configurations SET model_config_id=$1,updated_by=$2,configuration_version=3 WHERE tool_key='gpt-chat'", [model, actorId]);
      await initializeDefaultChatModel(db);
      await database.exec(migration);
      expect(await row()).toMatchObject({ model_config_id: model, configuration_version: 3 });
    }
    // Account deletion may clear updated_by; a configured version still blocks reseeding.
    await db.query("UPDATE tool_api_configurations SET updated_by=NULL WHERE tool_key='gpt-chat'");
    await initializeDefaultChatModel(db);
    expect((await row()).model_config_id).toBeNull();
    await db.query("UPDATE tool_api_configurations SET configuration_version=1 WHERE tool_key='gpt-chat'");
    await database.exec(migration);
    expect((await row()).model_config_id).toBe(sonnet);
  });

  test("formal HTTP chat, tool plans and canvas requests use the admin default and fail closed", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      calls.push({ path, body });
      if (path === "/v1/messages") return Response.json({ content: [{ type: "text", text: "Sonnet fixture reply" }], stop_reason: "end_turn" });
      if (path === "/v1/responses") return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Astra fixture reply" }] }] });
      return Response.json({ error: "Unexpected local provider path" }, { status: 400 });
    } });
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    await db.query("UPDATE providers SET base_url=$1,encrypted_credentials=$2 WHERE id=$3", [
      `http://127.0.0.1:${upstream.port}/v1`, encryptSecret(JSON.stringify({ apiKey: "local-fixture-only" }), encryptionKey), MARK_IMAGE_PROVIDER_ID,
    ]);
    await db.query("UPDATE tool_api_configurations SET model_config_id=$1,enabled=true,credit_cost_override=0 WHERE tool_key='gpt-chat'", [sonnet]);
    await db.query("UPDATE tool_api_configurations SET model_config_id=$1,enabled=true,credit_cost_override=8 WHERE tool_key='canvas-chat'", [alternative]);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: actorId, role: "designer", departmentId: null } }); next(); });
    app.use("/chat", createChatRouter(db, { AUTH_ENABLED: "false", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never));
    app.use(((error, _request, response, _next) => { response.status(error.status ?? 500).json({ error: error.code }); }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${address.port}/chat/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: [{ role: "user", content: "No paid call" }], ...body }),
    });
    try {
      for (const toolKey of [undefined, "gpt-chat", "canvas-chat"]) {
        const response = await post({ toolKey, modelId: alternative, tools: [{ type: "function", name: "read_node", parameters: { type: "object" } }] });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ content: "Sonnet fixture reply" });
      }
      expect(calls.every(call => call.path === "/v1/messages" && call.body.model === "claude-sonnet-5-5")).toBe(true);
      await db.query("UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='gpt-chat'", [alternative]);
      expect(await (await post({ toolKey: "canvas-chat", modelId: sonnet })).json()).toMatchObject({ content: "Astra fixture reply" });
      expect(calls.at(-1)).toMatchObject({ path: "/v1/responses", body: { model: "gpt-6-astra" } });
      await db.query("UPDATE tool_api_configurations SET model_config_id=NULL WHERE tool_key='gpt-chat'");
      const absent = await post({ toolKey: "canvas-chat", modelId: sonnet });
      expect(absent.status).toBe(503);
      expect(await absent.json()).toMatchObject({ error: "CHAT_MODEL_NOT_CONFIGURED" });
      await db.query("UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='gpt-chat'", [sonnet]);
      await db.query("UPDATE model_configs SET enabled=false WHERE id=$1", [sonnet]);
      expect((await post({ modelId: alternative })).status).toBe(400);
      expect(calls).toHaveLength(4);
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      upstream.stop(true);
    }
  }, 15000);
});
