import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { INITIAL_BATCH_ID, attemptBatchId, assertApprovedBatch, authorizeBudgetBatch, readBudgetBatches, type BudgetAuthorization, type BatchApproval } from "./budget-extension";

export const HARD_IMAGE_LIMIT = 100;
export const defaultAllocation = { single: 80, sequence: 12, reserve: 8 };
export type Allocation = typeof defaultAllocation;
export type Group = keyof Allocation;
export type Status = "reserved" | "running" | "success" | "failed" | "uncertain";
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function codeOf(error: unknown) {
  const value = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : "UNCLASSIFIED_ERROR";
}
export function validateAllocation(value: Allocation, maximum = HARD_IMAGE_LIMIT) {
  if (Object.keys(value).sort().join(",") !== "reserve,sequence,single" || Object.values(value).some(n => !Number.isSafeInteger(n) || n < 0)
    || !Number.isSafeInteger(Object.values(value).reduce((a, b) => a + b, 0)) || Object.values(value).reduce((a, b) => a + b, 0) > maximum) throw new Error("INVALID_ALLOCATION");
}
export function costOf(value: any = {}) {
  const amount = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  return { actual: amount(value.actualCost), estimated: amount(value.estimatedCost), currency: typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) ? value.currency : null };
}
export type Attempt = {
  key: string; requestId: string; compilationRequestId: string; group: Group; batchId: string; inputHash: string; input: any;
  status: Status; planningStarted: boolean; imagePostStarted: boolean; createdAt: string; updatedAt: string; evidence: any;
};

/** One SQLite file is the entire campaign budget, not a per-run ledger. Never delete/reset it to retry. */
export class EvalLedger {
  private db: Database;
  constructor(readonly path: string, allocation?: Allocation) {
    if (allocation !== undefined) validateAllocation(allocation);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budget(id INTEGER PRIMARY KEY CHECK(id=1), allocation_json TEXT NOT NULL, max_images INTEGER NOT NULL CHECK(max_images<=100 AND max_images>=0));
      CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY CHECK(id=1), binding_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(
        attempt_key TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, compilation_request_id TEXT NOT NULL UNIQUE,
        group_name TEXT NOT NULL CHECK(group_name IN ('single','sequence','reserve')), input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
        status TEXT NOT NULL, planning_started INTEGER NOT NULL DEFAULT 0, image_post_started INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_key TEXT NOT NULL REFERENCES attempts(attempt_key), at TEXT NOT NULL, event_json TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS budget_no_update BEFORE UPDATE ON budget BEGIN SELECT RAISE(ABORT,'BUDGET_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS budget_no_delete BEFORE DELETE ON budget BEGIN SELECT RAISE(ABORT,'BUDGET_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS attempt_no_delete BEFORE DELETE ON attempts BEGIN SELECT RAISE(ABORT,'ATTEMPT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS attempt_identity_no_update BEFORE UPDATE OF attempt_key,request_id,compilation_request_id,group_name,input_hash,input_json,created_at ON attempts BEGIN SELECT RAISE(ABORT,'ATTEMPT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS attempt_flags_monotonic BEFORE UPDATE ON attempts WHEN NEW.planning_started<OLD.planning_started OR NEW.image_post_started<OLD.image_post_started BEGIN SELECT RAISE(ABORT,'ATTEMPT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS attempt_limit BEFORE INSERT ON attempts BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM budget WHERE id=1) THEN RAISE(ABORT,'BUDGET_MISSING') END;
        SELECT CASE WHEN (SELECT count(*) FROM attempts)>=(SELECT max_images FROM budget WHERE id=1) OR (SELECT count(*) FROM attempts)>=100 THEN RAISE(ABORT,'IMAGE_BUDGET_EXHAUSTED') END;
        SELECT CASE WHEN (SELECT count(*) FROM attempts WHERE group_name=NEW.group_name)>=json_extract((SELECT allocation_json FROM budget WHERE id=1),'$.'||NEW.group_name) THEN RAISE(ABORT,'GROUP_BUDGET_EXHAUSTED') END;
      END;
    `);
    try { this.db.transaction(() => {
      const initial = allocation ?? defaultAllocation;
      this.db.query("INSERT OR IGNORE INTO budget VALUES(1,?,?)").run(canonical(initial), Object.values(initial).reduce((a, b) => a + b, 0));
      const stored = this.db.query("SELECT allocation_json FROM budget WHERE id=1").get() as any;
      if (allocation !== undefined && stored.allocation_json !== canonical(allocation)) throw new Error("ALLOCATION_CHANGED_EXISTING_BUDGET");
    }).immediate(); } catch (error) { this.db.close(); throw error; }
  }
  authorizeBatch(authorization: BudgetAuthorization, approval: BatchApproval) { return authorizeBudgetBatch(this.db, authorization, approval); }
  batch(batchId = INITIAL_BATCH_ID) { return assertApprovedBatch(this.db, batchId); }
  bind(binding: { apiOrigin: string; ownerHash: string }) {
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO binding VALUES(1,?)").run(canonical(binding));
      if ((this.db.query("SELECT binding_json FROM binding WHERE id=1").get() as any).binding_json !== canonical(binding)) throw new Error("BUDGET_OWNER_OR_ORIGIN_CHANGED");
    }).immediate();
  }
  get(key: string): Attempt | null {
    const row = this.db.query("SELECT * FROM attempts WHERE attempt_key=?").get(key) as any;
    return row ? { key: row.attempt_key, requestId: row.request_id, compilationRequestId: row.compilation_request_id, group: row.group_name, batchId: attemptBatchId(this.db, key),
      inputHash: row.input_hash, input: JSON.parse(row.input_json), status: row.status, planningStarted: !!row.planning_started,
      imagePostStarted: !!row.image_post_started, createdAt: row.created_at, updatedAt: row.updated_at, evidence: JSON.parse(row.evidence_json) } : null;
  }
  reserve(key: string, group: Group, input: unknown, batchId?: string): { created: boolean; attempt: Attempt } {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(key)) throw new Error("INVALID_ATTEMPT_KEY");
    return this.db.transaction(() => {
      const previous = this.get(key), inputHash = sha256(canonical(input));
      if (previous) {
        if (previous.inputHash !== inputHash || previous.group !== group || batchId !== undefined && previous.batchId !== batchId) throw new Error("ATTEMPT_INPUT_CHANGED");
        return { created: false, attempt: previous };
      }
      const selectedBatch = batchId ?? INITIAL_BATCH_ID;
      assertApprovedBatch(this.db, selectedBatch);
      const id = randomUUID(), at = new Date().toISOString();
      if (selectedBatch !== INITIAL_BATCH_ID) this.db.query("INSERT INTO attempt_batch_allocations(attempt_key,batch_id) VALUES(?,?)").run(key, selectedBatch);
      this.db.query("INSERT INTO attempts(attempt_key,request_id,compilation_request_id,group_name,input_hash,input_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'reserved',?,?)")
        .run(key, `pce:${id}`, `pce:${id}:compile`, group, inputHash, canonical(input), at, at);
      this.db.query("INSERT INTO events(attempt_key,at,event_json) VALUES(?,?,?)").run(key, at, canonical({ type: "reserved", imageUnits: 1, ...(selectedBatch !== INITIAL_BATCH_ID ? { batchId: selectedBatch } : {}) }));
      return { created: true, attempt: this.get(key)! };
    }).immediate(); // COMMIT + synchronous=FULL completes before any external POST.
  }
  mark(key: string, status: Status, patch: Record<string, unknown> = {}, flags: { planningStarted?: boolean; imagePostStarted?: boolean } = {}) {
    return this.db.transaction(() => {
      const row = this.get(key); if (!row) throw new Error("ATTEMPT_NOT_FOUND");
      const at = new Date().toISOString();
      // Concurrent recovery may not downgrade a known terminal result.
      const nextStatus = row.status === "success" ? "success" : row.status === "failed" && status !== "success" ? "failed" : status;
      this.db.query("UPDATE attempts SET status=?,planning_started=?,image_post_started=?,updated_at=?,evidence_json=? WHERE attempt_key=?")
        .run(nextStatus, Number(Boolean(row.planningStarted || flags.planningStarted)), Number(Boolean(row.imagePostStarted || flags.imagePostStarted)), at, canonical({ ...row.evidence, ...patch }), key);
      this.db.query("INSERT INTO events(attempt_key,at,event_json) VALUES(?,?,?)").run(key, at, canonical({ status: nextStatus, ...patch }));
      return this.get(key)!;
    }).immediate();
  }
  list(): Attempt[] { return (this.db.query("SELECT attempt_key FROM attempts ORDER BY created_at,attempt_key").all() as any[]).map(row => this.get(row.attempt_key)!); }
  report() {
    const rows = this.list();
    const batches = readBudgetBatches(this.db), authorizedImageLimit = batches.reduce((sum, batch) => sum + batch.imageLimit, 0);
    const sumCosts = (kind: "imageCost" | "planningCost") => {
      const selected = kind === "planningCost" ? rows.filter(row => row.planningStarted) : rows;
      const currencies: Record<string, number> = {};
      for (const row of selected) { const c = row.evidence[kind]; if (c?.actual !== null && c?.actual !== undefined && c.currency) currencies[c.currency] = (currencies[c.currency] ?? 0) + c.actual; }
      return { knownActualByCurrency: currencies, unknownCount: selected.filter(row => !row.evidence[kind] || row.evidence[kind].actual === null || !row.evidence[kind].currency).length };
    };
    return { hardImageLimit: authorizedImageLimit, initialImageLimit: batches[0]!.imageLimit, authorizedImageLimit, budgetMode: batches.length > 1 ? "approved-batches" : "initial", batches,
      allocation: JSON.parse((this.db.query("SELECT allocation_json FROM budget").get() as any).allocation_json),
      reservedImageAttempts: rows.length, imagePostAttempts: rows.filter(row => row.imagePostStarted).length,
      planningAttempts: rows.filter(row => row.planningStarted).length,
      compilationApiAttempts: rows.filter(row => row.planningStarted).length,
      confirmedPlanningModelCalls: rows.filter(row => row.evidence.planningModelCalled === true).length,
      unknownPlanningCallCount: rows.filter(row => row.planningStarted && row.evidence.planningModelCalled !== true && row.evidence.planningModelCalled !== false).length,
      images: sumCosts("imageCost"), planning: sumCosts("planningCost"), attempts: rows };
  }
  close() { this.db.close(); }
}

export interface AttemptTransport {
  submit(attempt: Attempt): Promise<void>;
  query(attempt: Attempt): Promise<void>;
}
/** Only the process that created the durable reservation receives permission to POST. */
export async function executeAttempt(ledger: EvalLedger, key: string, group: Group, input: unknown, transport: AttemptTransport, batchId?: string) {
  const reservation = ledger.reserve(key, group, input, batchId);
  try {
    if (reservation.created) await transport.submit(reservation.attempt);
    else await transport.query(reservation.attempt);
  } catch (error) {
    ledger.mark(key, "uncertain", { errorCode: codeOf(error), elapsedMs: Date.now() - Date.parse(reservation.attempt.createdAt) });
  }
  return ledger.get(key)!;
}
