import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import type { Database } from "../../src/db";
import { createIsolatedPostgres } from "./isolated-postgres";

type TestEnvironment = Record<string, string | undefined>;
export type ConversationDatabaseMode = "postgres" | "pglite" | null;
export type ConversationPostgres = {
  db: Database; backend: Exclude<ConversationDatabaseMode, null>; schema: string | null;
  statements: string[]; transactions: string[][]; close: () => Promise<void>;
};

export function conversationDatabaseMode(env: TestEnvironment = process.env): ConversationDatabaseMode {
  if (env.CONVERSATION_TEST_DATABASE_URL !== undefined || env.RUN_INTEGRATION_TESTS === "true") return "postgres";
  return env.PGLITE_RUNTIME_PATH ? "pglite" : null;
}

export function validateConversationTestDatabase(env: TestEnvironment = process.env) {
  const explicit = env.CONVERSATION_TEST_DATABASE_URL !== undefined;
  const fail = (): never => { throw new Error("Conversation PostgreSQL tests require an explicitly isolated loopback test database; no database connection was opened"); };
  if (env.NODE_ENV !== "test" || !explicit && env.RUN_INTEGRATION_TESTS !== "true") return fail();
  const connectionString = explicit ? env.CONVERSATION_TEST_DATABASE_URL : env.DATABASE_URL;
  if (!connectionString) return fail();
  let url: URL, database: string, username: string, password: string;
  try { url = new URL(connectionString); database = decodeURIComponent(url.pathname.slice(1)); username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { return fail(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.search || url.hash || !/^[A-Za-z0-9_-]+$/.test(database) || !username) return fail();
  if (explicit) {
    if (!/(?:^|[_-])(?:test|ci)(?:[_-]|$)/i.test(database)) return fail();
  } else if (url.hostname !== "127.0.0.1" || url.port !== "5432" || database !== "wireless_canvas"
    || username !== "wireless_canvas" || password !== "integration-postgres-password") return fail();
  return { connectionString, database, username };
}

function recordConversationQueries(db: Database, statements: string[], alreadyRecorded = false) {
  const transactions: string[][] = [];
  const recordClient = (client: PoolClient, transaction: string[]) => new Proxy(client, { get(target, key) {
    if (key === "query") return (...args: unknown[]) => {
      if (typeof args[0] === "string") { transaction.push(args[0]); if (!alreadyRecorded) statements.push(args[0]); }
      return Reflect.apply(target.query, target, args);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const recorded = new Proxy(db, { get(target, key) {
    if (key === "query") return (...args: unknown[]) => {
      if (!alreadyRecorded && typeof args[0] === "string") statements.push(args[0]);
      return Reflect.apply(target.query, target, args);
    };
    if (key === "connect") return async () => {
      const client = await target.connect(), transaction: string[] = [];
      transactions.push(transaction);
      return recordClient(client, transaction);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { db: recorded, statements, transactions };
}

export async function createConversationPostgres(options: { planner?: boolean } = {}): Promise<ConversationPostgres> {
  const fixture = await openConversationPostgres();
  if (!options.planner) return fixture;
  try {
    const provider = randomUUID(), model = randomUUID();
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Admission fixture','apimart','https://no-network.invalid','fixture-not-a-secret')", [provider]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Admission planner','gpt-6.2-sol',ARRAY['chat','vision'])", [model, provider]);
    await fixture.db.query("INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled) VALUES('gpt-chat',$1,true) ON CONFLICT(tool_key) DO UPDATE SET model_config_id=$1,enabled=true", [model]);
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

async function openConversationPostgres(): Promise<ConversationPostgres> {
  const mode = conversationDatabaseMode();
  if (mode === "pglite") {
    const fixture = await createIsolatedPostgres();
    return { ...recordConversationQueries(fixture.db, fixture.statements, true), backend: mode, schema: null, close: fixture.close };
  }
  if (mode !== "postgres") throw new Error("Enable the isolated conversation PostgreSQL or PGlite test runtime explicitly");
  const target = validateConversationTestDatabase();
  const control = new Pool({ connectionString: target.connectionString, max: 1, connectionTimeoutMillis: 5_000, options: "-c statement_timeout=15000 -c lock_timeout=5000" });
  const schema = `conversation_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool | undefined, created = false, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await pool?.end();
    try { if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await control.end(); }
  };
  try {
    const identity = (await control.query<{ database: string; username: string; version: number }>(
      "SELECT current_database() AS database,current_user AS username,current_setting('server_version_num')::int AS version",
    )).rows[0];
    if (!identity || identity.database !== target.database || identity.username !== target.username || identity.version < 170000 || identity.version >= 180000)
      throw new Error("Conversation integration tests require the validated isolated database identity running PostgreSQL 17");
    await control.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await control.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
    await control.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ connectionString: target.connectionString, max: 8, connectionTimeoutMillis: 5_000, application_name: schema,
      options: `-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=10000` });
    const migrations = new URL("../../src/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(name, migrations), "utf8"));
    return { ...recordConversationQueries(pool, []), backend: mode, schema, close };
  } catch (error) {
    await close();
    throw error;
  }
}
