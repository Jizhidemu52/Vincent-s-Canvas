import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";

export const INITIAL_BATCH_ID = "initial";
export type BatchAllocation = { single: number; sequence: number; reserve: number };
export type BudgetAuthorization = {
  version: 1; authorizationId: string; sourceReference: string; authorizedAt: string;
  userStatement: string; scope: "prompt-chain-evaluation"; allowAdditionalPaidBatches: true;
};
export type BatchApproval = { batchId: string; allocation: BatchAllocation; approveBudget: true };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value) ?? "null";
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
// Bun 1.3's query cache is bounded. Explicitly finalize these additive queries so
// authorization cannot leave evicted statements holding a Windows SQLite handle.
function one(db: Database, sql: string, ...bindings: SQLQueryBindings[]): any {
  const statement = db.prepare(sql);
  try { return statement.get(...bindings); } finally { statement.finalize(); }
}
function all(db: Database, sql: string, ...bindings: SQLQueryBindings[]): any[] {
  const statement = db.prepare(sql);
  try { return statement.all(...bindings); } finally { statement.finalize(); }
}

export function validateBatchId(value: string) {
  if (typeof value !== "string" || value === INITIAL_BATCH_ID || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(value)) throw new Error("INVALID_ADDITIONAL_BATCH_ID");
}
export function validateBatchAllocation(value: BatchAllocation) {
  if (!value || Object.keys(value).sort().join(",") !== "reserve,sequence,single" || Object.values(value).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("INVALID_BATCH_ALLOCATION");
  const total = Object.values(value).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total < 1) throw new Error("INVALID_BATCH_ALLOCATION");
  return total;
}
export function validateBudgetAuthorization(value: BudgetAuthorization) {
  if (!value || Object.keys(value).sort().join(",") !== "allowAdditionalPaidBatches,authorizationId,authorizedAt,scope,sourceReference,userStatement,version"
    || value.version !== 1 || value.scope !== "prompt-chain-evaluation" || value.allowAdditionalPaidBatches !== true
    || typeof value.authorizationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/.test(value.authorizationId)
    || typeof value.sourceReference !== "string" || !value.sourceReference.trim() || value.sourceReference.length > 1000
    || typeof value.userStatement !== "string" || !value.userStatement.trim() || value.userStatement.length > 8000
    || typeof value.authorizedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.authorizedAt) || !Number.isFinite(Date.parse(value.authorizedAt)))
    throw new Error("EXPLICIT_USER_BUDGET_AUTHORIZATION_REQUIRED");
}
export function hasBudgetExtension(db: Database) {
  return Boolean(one(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='budget_batches'"));
}
export function attemptBatchId(db: Database, key: string) {
  return hasBudgetExtension(db) ? one(db, "SELECT batch_id FROM attempt_batch_allocations WHERE attempt_key=?", key)?.batch_id ?? INITIAL_BATCH_ID : INITIAL_BATCH_ID;
}
export function readBudgetBatches(db: Database) {
  const initial = one(db, "SELECT allocation_json,max_images FROM budget WHERE id=1");
  if (!initial) throw new Error("BUDGET_MISSING");
  const extended = hasBudgetExtension(db);
  const records = [{ batchId: INITIAL_BATCH_ID, allocation: JSON.parse(initial.allocation_json) as BatchAllocation, imageLimit: initial.max_images as number, authorizationId: null as string | null },
    ...(extended ? all(db, "SELECT * FROM budget_batches ORDER BY approved_at,batch_id").map(row => ({ batchId: row.batch_id as string, allocation: JSON.parse(row.allocation_json) as BatchAllocation,
      imageLimit: row.max_images as number, authorizationId: row.authorization_id as string })) : [])];
  return records.map(record => {
    const groups = extended ? all(db, `SELECT a.group_name,count(*) AS count FROM attempts a LEFT JOIN attempt_batch_allocations b ON b.attempt_key=a.attempt_key
      WHERE COALESCE(b.batch_id,'initial')=? GROUP BY a.group_name`, record.batchId) : all(db, "SELECT group_name,count(*) AS count FROM attempts GROUP BY group_name");
    const used: BatchAllocation = { single: 0, sequence: 0, reserve: 0 };
    for (const row of groups) used[row.group_name as keyof BatchAllocation] = Number(row.count);
    const reservedImageAttempts = Object.values(used).reduce((a, b) => a + b, 0);
    return { ...record, reservedImageAttempts, remainingImageAttempts: record.imageLimit - reservedImageAttempts, used,
      remaining: { single: record.allocation.single - used.single, sequence: record.allocation.sequence - used.sequence, reserve: record.allocation.reserve - used.reserve } };
  });
}
export function assertApprovedBatch(db: Database, batchId: string) {
  const batch = readBudgetBatches(db).find(batch => batch.batchId === batchId);
  if (!batch) throw new Error("BATCH_BUDGET_NOT_APPROVED");
  return batch;
}
function originalHistory(db: Database) {
  const attempts = all(db, "SELECT * FROM attempts ORDER BY attempt_key");
  const events = all(db, "SELECT * FROM events ORDER BY id");
  return { count: attempts.length, events: events.length, sha256: digest({ attempts, events,
    budget: all(db, "SELECT * FROM budget ORDER BY id"), binding: all(db, "SELECT * FROM binding ORDER BY id") }) };
}

/** Only explicit approval installs this additive schema. Ordinary open/status/run never migrates the ledger. */
export function authorizeBudgetBatch(db: Database, authorization: BudgetAuthorization, approval: BatchApproval) {
  validateBudgetAuthorization(authorization);
  if (approval?.approveBudget !== true) throw new Error("EXPLICIT_BATCH_APPROVAL_REQUIRED");
  validateBatchId(approval.batchId);
  const imageLimit = validateBatchAllocation(approval.allocation);
  return db.transaction(() => {
    if (!one(db, "SELECT 1 FROM binding WHERE id=1")) throw new Error("BUDGET_BINDING_REQUIRED");
    const before = originalHistory(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS budget_authorizations(
        authorization_id TEXT PRIMARY KEY,record_json TEXT NOT NULL CHECK(json_valid(record_json)),record_sha256 TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_batches(
        batch_id TEXT PRIMARY KEY CHECK(batch_id<>'initial'),authorization_id TEXT NOT NULL REFERENCES budget_authorizations(authorization_id),
        allocation_json TEXT NOT NULL CHECK(json_valid(allocation_json)),max_images INTEGER NOT NULL CHECK(max_images>0),approved_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt_batch_allocations(
        attempt_key TEXT PRIMARY KEY REFERENCES attempts(attempt_key) DEFERRABLE INITIALLY DEFERRED,
        batch_id TEXT NOT NULL REFERENCES budget_batches(batch_id));
      CREATE TRIGGER IF NOT EXISTS budget_authorizations_no_update BEFORE UPDATE ON budget_authorizations BEGIN SELECT RAISE(ABORT,'AUTHORIZATION_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS budget_authorizations_no_delete BEFORE DELETE ON budget_authorizations BEGIN SELECT RAISE(ABORT,'AUTHORIZATION_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS budget_batches_no_update BEFORE UPDATE ON budget_batches BEGIN SELECT RAISE(ABORT,'BATCH_BUDGET_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS budget_batches_no_delete BEFORE DELETE ON budget_batches BEGIN SELECT RAISE(ABORT,'BATCH_BUDGET_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS attempt_batch_no_update BEFORE UPDATE ON attempt_batch_allocations BEGIN SELECT RAISE(ABORT,'ATTEMPT_BATCH_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS attempt_batch_no_delete BEFORE DELETE ON attempt_batch_allocations BEGIN SELECT RAISE(ABORT,'ATTEMPT_BATCH_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS attempt_batch_no_reassign BEFORE INSERT ON attempt_batch_allocations
        WHEN EXISTS(SELECT 1 FROM attempts WHERE attempt_key=NEW.attempt_key) BEGIN SELECT RAISE(ABORT,'ATTEMPT_BATCH_IMMUTABLE'); END;
    `);
    const record = canonical(authorization), recordHash = digest(authorization), at = new Date().toISOString();
    db.run("INSERT OR IGNORE INTO budget_authorizations VALUES(?,?,?,?)", [authorization.authorizationId, record, recordHash, at]);
    const savedAuthorization = one(db, "SELECT record_json FROM budget_authorizations WHERE authorization_id=?", authorization.authorizationId);
    if (savedAuthorization.record_json !== record) throw new Error("USER_AUTHORIZATION_CHANGED");
    const allocation = canonical(approval.allocation);
    const previous = one(db, "SELECT * FROM budget_batches WHERE batch_id=?", approval.batchId);
    if (previous && (previous.authorization_id !== authorization.authorizationId || previous.allocation_json !== allocation)) throw new Error("BATCH_APPROVAL_CHANGED");
    if (!previous) {
      const total = readBudgetBatches(db).reduce((sum, batch) => sum + batch.imageLimit, 0) + imageLimit;
      if (!Number.isSafeInteger(total)) throw new Error("AUTHORIZED_BUDGET_TOO_LARGE");
      db.run("INSERT INTO budget_batches VALUES(?,?,?,?,?)", [approval.batchId, authorization.authorizationId, allocation, imageLimit, at]);
    }
    // Original rows stay untouched. New membership must be inserted in the same transaction
    // before its attempt, and cannot later be assigned to an existing historical attempt.
    db.exec(`DROP TRIGGER IF EXISTS attempt_limit;
      CREATE TRIGGER attempt_limit BEFORE INSERT ON attempts BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM budget WHERE id=1) THEN RAISE(ABORT,'BUDGET_MISSING') END;
        SELECT CASE WHEN (SELECT count(*) FROM attempts)>=(SELECT max_images FROM budget WHERE id=1)+(SELECT COALESCE(sum(max_images),0) FROM budget_batches) THEN RAISE(ABORT,'IMAGE_BUDGET_EXHAUSTED') END;
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key)
          AND (SELECT count(*) FROM attempts a WHERE NOT EXISTS(SELECT 1 FROM attempt_batch_allocations b WHERE b.attempt_key=a.attempt_key))>=(SELECT max_images FROM budget WHERE id=1)
          THEN RAISE(ABORT,'IMAGE_BUDGET_EXHAUSTED') END;
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key)
          AND (SELECT count(*) FROM attempts a WHERE a.group_name=NEW.group_name AND NOT EXISTS(SELECT 1 FROM attempt_batch_allocations b WHERE b.attempt_key=a.attempt_key))>=json_extract((SELECT allocation_json FROM budget WHERE id=1),'$.'||NEW.group_name)
          THEN RAISE(ABORT,'GROUP_BUDGET_EXHAUSTED') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key)
          AND (SELECT count(*) FROM attempts a JOIN attempt_batch_allocations b ON b.attempt_key=a.attempt_key WHERE b.batch_id=(SELECT batch_id FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key))
            >=(SELECT max_images FROM budget_batches WHERE batch_id=(SELECT batch_id FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key))
          THEN RAISE(ABORT,'BATCH_BUDGET_EXHAUSTED') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key)
          AND (SELECT count(*) FROM attempts a JOIN attempt_batch_allocations b ON b.attempt_key=a.attempt_key WHERE a.group_name=NEW.group_name AND b.batch_id=(SELECT batch_id FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key))
            >=json_extract((SELECT allocation_json FROM budget_batches WHERE batch_id=(SELECT batch_id FROM attempt_batch_allocations WHERE attempt_key=NEW.attempt_key)),'$.'||NEW.group_name)
          THEN RAISE(ABORT,'GROUP_BUDGET_EXHAUSTED') END;
      END;`);
    const after = originalHistory(db);
    if (before.sha256 !== after.sha256 || before.count !== after.count || before.events !== after.events) throw new Error("EXISTING_HISTORY_CHANGED");
    return { created: !previous, batchId: approval.batchId, authorizationId: authorization.authorizationId, authorizationSha256: recordHash, imageLimit,
      preservedAttemptCount: before.count, preservedEventCount: before.events, historyBeforeSha256: before.sha256, historyAfterSha256: after.sha256,
      authorizedImageLimit: readBudgetBatches(db).reduce((sum, batch) => sum + batch.imageLimit, 0) };
  }).immediate();
}

export function parseBatchApprovalArguments(args: string[]) {
  const valueNames = ["--authorization", "--batch-id", "--single", "--sequence", "--reserve"];
  if (args[0] !== "authorize-batch" || args.filter(arg => arg === "--approve-budget").length !== 1) throw new Error("EXPLICIT_BATCH_APPROVAL_REQUIRED");
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index++) {
    const name = args[index]!;
    if (name === "--approve-budget") continue;
    if (!valueNames.includes(name) || values[name] !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("INVALID_BATCH_APPROVAL_ARGUMENTS");
    values[name] = args[++index]!;
  }
  if (valueNames.some(name => values[name] === undefined)) throw new Error("EXPLICIT_BATCH_LIMITS_REQUIRED");
  const allocation = Object.fromEntries(["single", "sequence", "reserve"].map(group => {
    const value = values[`--${group}`]!;
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("INVALID_BATCH_ALLOCATION");
    return [group, Number(value)];
  })) as BatchAllocation;
  validateBatchId(values["--batch-id"]!); validateBatchAllocation(allocation);
  return { authorizationFile: values["--authorization"]!, approval: { batchId: values["--batch-id"]!, allocation, approveBudget: true as const } };
}
