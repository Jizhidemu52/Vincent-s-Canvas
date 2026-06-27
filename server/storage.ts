import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createServerState, type AccountWorkspace, type ServerState } from "./api";
import type { HistoryEntry, LibraryAsset, ModelDefinition, Profile, Project, PromptPreset } from "../src/domain/workspace";

interface PersistedServerState {
  version: 1;
  profile: Profile;
  models: ModelDefinition[];
  history: HistoryEntry[];
  projects: Project[];
  activeProjectId?: string;
  assets: LibraryAsset[];
  prompts: PromptPreset[];
  accounts?: Record<string, AccountWorkspace>;
  submittedRequestIds: string[];
}

function serializeServerState(state: ServerState): PersistedServerState {
  return {
    version: 1,
    profile: state.profile,
    models: state.models,
    history: state.history,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    assets: state.assets,
    prompts: state.prompts,
    accounts: state.accounts,
    submittedRequestIds: Array.from(state.submittedRequestIds)
  };
}

function hydrateServerState(data: PersistedServerState): ServerState {
  const fallback = createServerState(data.profile);
  return {
    profile: data.profile,
    models: data.models?.length ? data.models : fallback.models,
    history: Array.isArray(data.history) ? data.history : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    activeProjectId: data.activeProjectId,
    assets: Array.isArray(data.assets) ? data.assets : [],
    prompts: Array.isArray(data.prompts) && data.prompts.length ? data.prompts : fallback.prompts,
    accounts: data.accounts ?? {},
    submittedRequestIds: new Set(data.submittedRequestIds ?? [])
  };
}

function isDatabasePath(filePath: string) {
  return /\.(sqlite|sqlite3|db)$/i.test(filePath);
}

function openDatabase(filePath: string) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  mkdirSync(dirname(filePath), { recursive: true });
  return new DatabaseSync(filePath);
}

function createDatabaseSchema(db: ReturnType<typeof openDatabase>) {
  db.exec(`
    create table if not exists platform_state (
      id integer primary key check (id = 1),
      version integer not null,
      state_json text not null,
      updated_at text not null
    );
    create table if not exists accounts (
      user_id text primary key,
      designer_name text not null,
      role text not null,
      credit_balance integer not null,
      credit_used integer not null,
      credit_limit integer,
      account_json text not null
    );
    create table if not exists credit_ledger (
      id text primary key,
      user_id text not null,
      model_id text not null,
      project_id text not null,
      node_id text not null,
      credit_cost integer not null,
      created_at text not null
    );
    create table if not exists projects (
      id text primary key,
      user_id text not null,
      name text not null,
      updated_at text not null,
      project_json text not null
    );
    create table if not exists canvas_nodes (
      id text primary key,
      project_id text not null,
      user_id text not null,
      type text not null,
      kind text not null,
      name text not null,
      status text not null,
      node_json text not null
    );
    create table if not exists canvas_connections (
      id text primary key,
      project_id text not null,
      user_id text not null,
      from_node_id text not null,
      to_node_id text not null,
      connection_json text not null
    );
    create table if not exists assets (
      id text primary key,
      user_id text not null,
      title text not null,
      type text not null,
      asset_json text not null
    );
    create table if not exists generation_jobs (
      id text primary key,
      user_id text not null,
      project_id text not null,
      node_id text not null,
      model_id text not null,
      operation text,
      status text not null,
      job_json text not null
    );
    create table if not exists generation_outputs (
      id text primary key,
      job_id text not null,
      user_id text not null,
      output_json text not null
    );
    create table if not exists generation_history (
      id text primary key,
      user_id text not null,
      project_id text not null,
      node_id text not null,
      model_id text not null,
      credit_cost integer not null,
      created_at text not null,
      history_json text not null
    );
    create table if not exists model_configs (
      id text primary key,
      provider text not null,
      name text not null,
      cost integer not null,
      price_cents integer,
      currency text,
      model_json text not null
    );
    create table if not exists audit_logs (
      id text primary key,
      user_id text not null,
      event_type text not null,
      created_at text not null,
      event_json text not null
    );
    create table if not exists submitted_requests (
      request_id text primary key
    );
  `);
}

function resetDatabaseTables(db: ReturnType<typeof openDatabase>) {
  for (const table of [
    "accounts",
    "credit_ledger",
    "projects",
    "canvas_nodes",
    "canvas_connections",
    "assets",
    "generation_jobs",
    "generation_outputs",
    "generation_history",
    "model_configs",
    "audit_logs",
    "submitted_requests"
  ]) {
    db.exec(`delete from ${table}`);
  }
}

function accountEntries(state: ServerState): Array<{ userId: string; account: AccountWorkspace }> {
  const entries = new Map<string, AccountWorkspace>();
  entries.set(state.profile.userId, {
    profile: state.profile,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    history: state.history,
    assets: state.assets,
    prompts: state.prompts
  });
  for (const [userId, account] of Object.entries(state.accounts)) {
    entries.set(userId, account);
  }
  return Array.from(entries.entries()).map(([userId, account]) => ({ userId, account }));
}

function saveDatabaseState(filePath: string, state: ServerState) {
  const db = openDatabase(filePath);
  try {
    createDatabaseSchema(db);
    resetDatabaseTables(db);
    const serialized = serializeServerState(state);
    db.prepare(
      "insert or replace into platform_state (id, version, state_json, updated_at) values (1, ?, ?, ?)"
    ).run(serialized.version, JSON.stringify(serialized), new Date().toISOString());

    const insertAccount = db.prepare(
      "insert into accounts (user_id, designer_name, role, credit_balance, credit_used, credit_limit, account_json) values (?, ?, ?, ?, ?, ?, ?)"
    );
    const insertProject = db.prepare(
      "insert into projects (id, user_id, name, updated_at, project_json) values (?, ?, ?, ?, ?)"
    );
    const insertNode = db.prepare(
      "insert into canvas_nodes (id, project_id, user_id, type, kind, name, status, node_json) values (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertConnection = db.prepare(
      "insert into canvas_connections (id, project_id, user_id, from_node_id, to_node_id, connection_json) values (?, ?, ?, ?, ?, ?)"
    );
    const insertAsset = db.prepare("insert into assets (id, user_id, title, type, asset_json) values (?, ?, ?, ?, ?)");
    const insertHistory = db.prepare(
      "insert into generation_history (id, user_id, project_id, node_id, model_id, credit_cost, created_at, history_json) values (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertLedger = db.prepare(
      "insert into credit_ledger (id, user_id, model_id, project_id, node_id, credit_cost, created_at) values (?, ?, ?, ?, ?, ?, ?)"
    );
    const insertJob = db.prepare(
      "insert into generation_jobs (id, user_id, project_id, node_id, model_id, operation, status, job_json) values (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertAudit = db.prepare("insert into audit_logs (id, user_id, event_type, created_at, event_json) values (?, ?, ?, ?, ?)");

    for (const { userId, account } of accountEntries(state)) {
      insertAccount.run(
        userId,
        account.profile.designerName,
        account.profile.role,
        account.profile.creditBalance,
        account.profile.creditUsed,
        account.profile.creditLimit ?? null,
        JSON.stringify(account)
      );
      for (const project of account.projects) {
        insertProject.run(project.id, userId, project.name, project.updatedAt, JSON.stringify(project));
        for (const node of project.nodes) {
          insertNode.run(node.id, project.id, userId, node.type, node.kind, node.name, node.status, JSON.stringify(node));
        }
        for (const connection of project.connections) {
          insertConnection.run(connection.id, project.id, userId, connection.fromNodeId, connection.toNodeId, JSON.stringify(connection));
        }
      }
      for (const asset of account.assets) {
        insertAsset.run(asset.id, userId, asset.title, asset.type, JSON.stringify(asset));
      }
      for (const history of account.history) {
        insertHistory.run(history.id, userId, history.projectId, history.nodeId, history.modelId, history.creditCost, history.createdAt, JSON.stringify(history));
        insertLedger.run(history.id, userId, history.modelId, history.projectId, history.nodeId, history.creditCost, history.createdAt);
        insertJob.run(history.id, userId, history.projectId, history.nodeId, history.modelId, history.operation ?? "generate", "succeeded", JSON.stringify(history));
        insertAudit.run(history.id, userId, "generation", history.createdAt, JSON.stringify(history));
      }
    }

    const insertModel = db.prepare(
      "insert into model_configs (id, provider, name, cost, price_cents, currency, model_json) values (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const model of state.models) {
      insertModel.run(model.id, model.provider, model.name, model.cost, model.priceCents ?? null, model.currency ?? null, JSON.stringify(model));
    }
    const insertRequest = db.prepare("insert into submitted_requests (request_id) values (?)");
    for (const requestId of state.submittedRequestIds) {
      insertRequest.run(requestId);
    }
  } finally {
    db.close();
  }
}

function loadDatabaseState(filePath: string, fallback: ServerState) {
  if (!existsSync(filePath)) {
    return fallback;
  }
  const db = openDatabase(filePath);
  try {
    createDatabaseSchema(db);
    const row = db.prepare("select state_json from platform_state where id = 1").get() as { state_json?: string } | undefined;
    if (!row?.state_json) {
      return fallback;
    }
    return hydrateServerState(JSON.parse(row.state_json) as PersistedServerState);
  } finally {
    db.close();
  }
}

export function loadServerState(filePath: string, fallback: ServerState = createServerState()): ServerState {
  if (isDatabasePath(filePath)) {
    return loadDatabaseState(filePath, fallback);
  }
  try {
    const text = readFileSync(filePath, "utf8");
    return hydrateServerState(JSON.parse(text) as PersistedServerState);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export function saveServerState(filePath: string, state: ServerState) {
  if (isDatabasePath(filePath)) {
    saveDatabaseState(filePath, state);
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(serializeServerState(state), null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}
