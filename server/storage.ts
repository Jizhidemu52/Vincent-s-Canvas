import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createServerState, type AccountWorkspace, type AdminAuditEntry, type AssetBlob, type GenerationJob, type ServerState } from "./api";
import type { ProviderRuntimeSettingsMap } from "./providers";
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
  providerSettings?: ProviderRuntimeSettingsMap;
  adminAudit?: AdminAuditEntry[];
  generationJobs?: GenerationJob[];
  assetBlobs?: Record<string, AssetBlob>;
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
    submittedRequestIds: Array.from(state.submittedRequestIds),
    providerSettings: state.providerSettings,
    adminAudit: state.adminAudit,
    generationJobs: state.generationJobs,
    assetBlobs: state.assetBlobs
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
    submittedRequestIds: new Set(data.submittedRequestIds ?? []),
    providerSettings: data.providerSettings ?? {},
    adminAudit: data.adminAudit ?? [],
    generationJobs: data.generationJobs ?? [],
    assetBlobs: data.assetBlobs ?? {}
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

function ensureColumn(db: ReturnType<typeof openDatabase>, tableName: string, columnName: string, definition: string) {
  const columns = db.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`alter table ${tableName} add column ${columnName} ${definition}`);
  }
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
      price_cents integer,
      currency text,
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
    create table if not exists asset_blobs (
      asset_id text primary key,
      user_id text not null,
      mime_type text not null,
      base64 text not null,
      byte_size integer not null,
      created_at text not null
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
      operation text,
      output_count integer not null default 1,
      reference_count integer not null default 0,
      designer_name text,
      prompt text,
      credit_cost integer not null,
      price_cents integer,
      currency text,
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
  ensureColumn(db, "generation_history", "operation", "text");
  ensureColumn(db, "generation_history", "output_count", "integer not null default 1");
  ensureColumn(db, "generation_history", "reference_count", "integer not null default 0");
  ensureColumn(db, "generation_history", "designer_name", "text");
  ensureColumn(db, "generation_history", "prompt", "text");
}

function resetDatabaseTables(db: ReturnType<typeof openDatabase>) {
  for (const table of [
    "accounts",
    "credit_ledger",
    "projects",
    "canvas_nodes",
    "canvas_connections",
    "assets",
    "asset_blobs",
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
    const insertAssetBlob = db.prepare(
      "insert into asset_blobs (asset_id, user_id, mime_type, base64, byte_size, created_at) values (?, ?, ?, ?, ?, ?)"
    );
    const insertHistory = db.prepare(
      "insert into generation_history (id, user_id, project_id, node_id, model_id, operation, output_count, reference_count, designer_name, prompt, credit_cost, price_cents, currency, created_at, history_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertLedger = db.prepare(
      "insert into credit_ledger (id, user_id, model_id, project_id, node_id, credit_cost, price_cents, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertJob = db.prepare(
      "insert into generation_jobs (id, user_id, project_id, node_id, model_id, operation, status, job_json) values (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertOutput = db.prepare(
      "insert into generation_outputs (id, job_id, user_id, output_json) values (?, ?, ?, ?)"
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
        const blob = state.assetBlobs[asset.id];
        if (blob) {
          insertAssetBlob.run(asset.id, userId, blob.mimeType, blob.base64, blob.byteSize, blob.createdAt);
        }
      }
      for (const history of account.history) {
        insertHistory.run(
          history.id,
          userId,
          history.projectId,
          history.nodeId,
          history.modelId,
          history.operation ?? null,
          history.outputCount,
          history.referenceCount ?? history.references?.length ?? 0,
          history.designerName ?? account.profile.designerName,
          history.prompt,
          history.creditCost,
          history.priceCents ?? null,
          history.currency ?? null,
          history.createdAt,
          JSON.stringify(history)
        );
        insertLedger.run(
          history.id,
          userId,
          history.modelId,
          history.projectId,
          history.nodeId,
          history.creditCost,
          history.priceCents ?? null,
          history.currency ?? null,
          history.createdAt
        );
        insertAudit.run(history.id, userId, "generation", history.createdAt, JSON.stringify(history));
      }
    }
    for (const job of state.generationJobs) {
      insertJob.run(job.id, job.userId, job.projectId, job.nodeId, job.modelId, job.operation, job.status, JSON.stringify(job));
      job.outputs.forEach((output, index) => {
        insertOutput.run(`${job.id}-output-${index + 1}`, job.id, job.userId, JSON.stringify(output));
      });
    }
    for (const audit of state.adminAudit) {
      if (audit.eventType === "credit-adjustment" && audit.targetUserId && audit.creditDelta !== undefined) {
        insertLedger.run(
          audit.id,
          audit.targetUserId,
          "admin-credit-adjustment",
          "admin",
          "admin-credit",
          audit.creditDelta,
          null,
          null,
          audit.createdAt
        );
      }
      insertAudit.run(audit.id, audit.actorUserId ?? "system", audit.eventType, audit.createdAt, JSON.stringify(audit));
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
      return loadDatabaseTables(db, fallback);
    }
    return hydrateServerState(JSON.parse(row.state_json) as PersistedServerState);
  } finally {
    db.close();
  }
}

function loadJsonColumn<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return JSON.parse(value) as T;
}

function loadDatabaseTables(db: ReturnType<typeof openDatabase>, fallback: ServerState): ServerState {
  const state = createServerState(fallback.profile);
  const accountRows = db.prepare("select user_id, account_json from accounts order by user_id").all() as Array<{ user_id: string; account_json: string }>;
  const accounts = new Map<string, AccountWorkspace>();
  for (const row of accountRows) {
    const account = loadJsonColumn<AccountWorkspace>(row.account_json);
    if (account) {
      accounts.set(row.user_id, account);
    }
  }
  const primaryAccount = accounts.get(fallback.profile.userId) ?? accounts.values().next().value;
  if (primaryAccount) {
    state.profile = primaryAccount.profile;
    state.projects = primaryAccount.projects;
    state.activeProjectId = primaryAccount.activeProjectId;
    state.history = primaryAccount.history;
    state.assets = primaryAccount.assets;
    state.prompts = primaryAccount.prompts.length ? primaryAccount.prompts : state.prompts;
  }
  state.accounts = Object.fromEntries(
    Array.from(accounts.entries()).filter(([userId]) => userId !== state.profile.userId)
  );

  const modelRows = db.prepare("select model_json from model_configs order by id").all() as Array<{ model_json: string }>;
  const models = modelRows.map((row) => loadJsonColumn<ModelDefinition>(row.model_json)).filter((model): model is ModelDefinition => Boolean(model));
  if (models.length) {
    state.models = models;
  }

  const jobRows = db.prepare("select job_json from generation_jobs order by id").all() as Array<{ job_json: string }>;
  state.generationJobs = jobRows
    .map((row) => loadJsonColumn<GenerationJob>(row.job_json))
    .filter((job): job is GenerationJob => Boolean(job));

  const blobRows = db
    .prepare("select asset_id, user_id, mime_type, base64, byte_size, created_at from asset_blobs")
    .all() as Array<{ asset_id: string; user_id: string; mime_type: string; base64: string; byte_size: number; created_at: string }>;
  state.assetBlobs = Object.fromEntries(
    blobRows.map((row) => [
      row.asset_id,
      {
        mimeType: row.mime_type,
        base64: row.base64,
        byteSize: row.byte_size,
        createdAt: row.created_at,
        userId: row.user_id
      }
    ])
  );

  const auditRows = db.prepare("select event_json from audit_logs where event_type != 'generation' order by created_at desc").all() as Array<{ event_json: string }>;
  state.adminAudit = auditRows
    .map((row) => loadJsonColumn<AdminAuditEntry>(row.event_json))
    .filter((entry): entry is AdminAuditEntry => Boolean(entry));

  const requestRows = db.prepare("select request_id from submitted_requests").all() as Array<{ request_id: string }>;
  state.submittedRequestIds = new Set(requestRows.map((row) => row.request_id));
  return state;
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
