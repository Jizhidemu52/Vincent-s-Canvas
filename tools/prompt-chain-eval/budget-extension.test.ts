import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EvalLedger, canonical, executeAttempt, sha256 } from "./ledger";
import { parseBatchApprovalArguments, validateBudgetAuthorization, type BudgetAuthorization } from "./budget-extension";
import { buildJobs, namespaceJobs, starterConfig } from "./cases";
import { ApplicationClient, EvaluationTransport, selectedBatchArgument, validateRunBatch } from "../prompt-chain-eval";

const directories: string[] = [];
async function temporary() { const directory = await mkdtemp(resolve(tmpdir(), "prompt-chain-budget-test-")); directories.push(directory); return { directory, path: resolve(directory, "budget.sqlite") }; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const authorization: BudgetAuthorization = { version: 1, authorizationId: "test-user-approval", sourceReference: "offline-test-fixture",
  authorizedAt: "2026-11-11T00:00:00Z", userStatement: "OFFLINE TEST ONLY: authorize bounded additional evaluation batches.", scope: "prompt-chain-evaluation", allowAdditionalPaidBatches: true };
const approval = { batchId: "iteration-01", allocation: { single: 40, sequence: 0, reserve: 0 }, approveBudget: true as const };
function bind(ledger: EvalLedger) { ledger.bind({ apiOrigin: "http://127.0.0.1:13100", ownerHash: "a".repeat(64) }); }
function history(db: Database) {
  return canonical({ budget: db.query("SELECT * FROM budget ORDER BY id").all(), binding: db.query("SELECT * FROM binding ORDER BY id").all(),
    attempts: db.query("SELECT * FROM attempts ORDER BY attempt_key").all(), events: db.query("SELECT * FROM events ORDER BY id").all() });
}

test("explicit extension preserves all 96 original attempts, events, budget and binding byte-for-byte", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path); bind(ledger);
  const db = new Database(path);
  try {
    for (let index = 0; index < 96; index++) {
      const group = index < 80 ? "single" : index < 92 ? "sequence" : "reserve";
      ledger.reserve(`old:${index}`, group, { index, originalPrompt: "原始约束不能变" });
      ledger.mark(`old:${index}`, index % 3 === 0 ? "success" : index % 3 === 1 ? "failed" : "uncertain", { oldEvidence: index }, { imagePostStarted: index % 4 !== 0 });
    }
    const before = history(db), receipt = ledger.authorizeBatch(authorization, approval);
    expect(receipt).toMatchObject({ created: true, imageLimit: 40, preservedAttemptCount: 96, preservedEventCount: 192, authorizedImageLimit: 140 });
    expect(receipt.historyBeforeSha256).toBe(sha256(before)); expect(receipt.historyAfterSha256).toBe(receipt.historyBeforeSha256);
    expect(history(db)).toBe(before);
    expect(ledger.batch()).toMatchObject({ imageLimit: 100, reservedImageAttempts: 96, remainingImageAttempts: 4 });
    expect(ledger.batch("iteration-01")).toMatchObject({ imageLimit: 40, reservedImageAttempts: 0, remainingImageAttempts: 40 });
    expect(ledger.list().every(attempt => attempt.batchId === "initial")).toBe(true);
    const tables = canonical(db.query("SELECT * FROM budget_authorizations").all());
    expect(ledger.authorizeBatch(authorization, approval).created).toBe(false);
    expect(history(db)).toBe(before); expect(canonical(db.query("SELECT * FROM budget_authorizations").all())).toBe(tables);
    expect(() => ledger.authorizeBatch({ ...authorization, userStatement: "changed" }, approval)).toThrow("USER_AUTHORIZATION_CHANGED");
    expect(() => ledger.authorizeBatch({ ...authorization, authorizationId: "new-auth" }, { ...approval, allocation: { single: 41, sequence: 0, reserve: 0 } })).toThrow("BATCH_APPROVAL_CHANGED");
    expect(db.query("SELECT 1 FROM budget_authorizations WHERE authorization_id='new-auth'").get()).toBeNull();
    expect(history(db)).toBe(before);
    for (let index = 0; index < 40; index++) ledger.reserve(`batch:iteration-01:new-${index}`, "single", { index }, "iteration-01");
    const afterNew = JSON.parse(history(db));
    afterNew.attempts = afterNew.attempts.filter((row: any) => row.attempt_key.startsWith("old:"));
    afterNew.events = afterNew.events.filter((row: any) => row.attempt_key.startsWith("old:"));
    expect(canonical(afterNew)).toBe(before);
    expect(ledger.report().reservedImageAttempts).toBe(136); expect(ledger.batch().remainingImageAttempts).toBe(4);
  } finally { db.close(); ledger.close(); }
});

test("extension is opt-in and rejects missing authorization, approval, binding and unknown batch", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path), db = new Database(path);
  try {
    expect(() => ledger.reserve("new", "single", {}, "iteration-01")).toThrow("BATCH_BUDGET_NOT_APPROVED");
    expect(() => ledger.authorizeBatch(authorization, approval)).toThrow("BUDGET_BINDING_REQUIRED");
    bind(ledger);
    expect(() => ledger.authorizeBatch({ ...authorization, allowAdditionalPaidBatches: false } as any, approval)).toThrow("EXPLICIT_USER_BUDGET_AUTHORIZATION_REQUIRED");
    expect(() => ledger.authorizeBatch(authorization, { ...approval, approveBudget: false } as any)).toThrow("EXPLICIT_BATCH_APPROVAL_REQUIRED");
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name='budget_batches'").get()).toBeNull();
    expect(ledger.report()).toMatchObject({ authorizedImageLimit: 100, budgetMode: "initial", reservedImageAttempts: 0 });
    expect(() => validateBudgetAuthorization({ ...authorization, authorizationId: undefined } as any)).toThrow("EXPLICIT_USER_BUDGET_AUTHORIZATION_REQUIRED");
  } finally { db.close(); ledger.close(); }
});

test("old cap and each added group stay independent; failures never release slots or select another batch", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path, { single: 1, sequence: 0, reserve: 0 }); bind(ledger);
  try {
    ledger.reserve("old", "single", {}); ledger.mark("old", "failed");
    ledger.authorizeBatch(authorization, { ...approval, allocation: { single: 1, sequence: 1, reserve: 1 } });
    ledger.authorizeBatch(authorization, { ...approval, batchId: "later", allocation: { single: 20, sequence: 0, reserve: 0 } });
    expect(() => ledger.reserve("old-more", "single", {})).toThrow("IMAGE_BUDGET_EXHAUSTED");
    for (const group of ["single", "sequence", "reserve"] as const) {
      ledger.reserve(`new:${group}`, group, {}, "iteration-01"); ledger.mark(`new:${group}`, "failed");
      expect(() => ledger.reserve(`new:${group}:more`, group, {}, "iteration-01")).toThrow(group === "reserve" ? "BATCH_BUDGET_EXHAUSTED" : "GROUP_BUDGET_EXHAUSTED");
    }
    expect(ledger.batch("later").reservedImageAttempts).toBe(0);
    expect(ledger.report().reservedImageAttempts).toBe(4);
  } finally { ledger.close(); }
});

test("authorization, batch and membership cannot be mutated; historical attempts cannot be reallocated", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path); bind(ledger);
  ledger.reserve("old", "single", {}); ledger.authorizeBatch(authorization, approval); ledger.reserve("new", "single", {}, "iteration-01");
  const db = new Database(path); db.exec("PRAGMA foreign_keys=ON");
  try {
    for (const sql of ["UPDATE budget_authorizations SET record_json='{}'", "DELETE FROM budget_authorizations"])
      expect(() => db.exec(sql)).toThrow("AUTHORIZATION_IMMUTABLE");
    for (const sql of ["UPDATE budget_batches SET max_images=999", "DELETE FROM budget_batches"])
      expect(() => db.exec(sql)).toThrow("BATCH_BUDGET_IMMUTABLE");
    for (const sql of ["UPDATE attempt_batch_allocations SET batch_id='another'", "DELETE FROM attempt_batch_allocations", "INSERT INTO attempt_batch_allocations VALUES('old','iteration-01')"])
      expect(() => db.exec(sql)).toThrow("ATTEMPT_BATCH_IMMUTABLE");
    expect(() => ledger.reserve("new", "single", {}, "initial")).toThrow("ATTEMPT_INPUT_CHANGED");
    expect(() => ledger.reserve("bad", "single", {}, "unapproved")).toThrow("BATCH_BUDGET_NOT_APPROVED");
    expect(db.query("SELECT count(*) AS count FROM attempt_batch_allocations").get()).toEqual({ count: 1 });
  } finally { db.close(); ledger.close(); }
});

test("8 processes share the same additional 40 slots beyond the filled original 100", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path, { single: 100, sequence: 0, reserve: 0 }); bind(ledger);
  for (let index = 0; index < 100; index++) ledger.reserve(`old-${index}`, "single", { index });
  ledger.authorizeBatch(authorization, approval); ledger.close();
  const outcomes = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "test-worker.ts"), path, `batch-worker-${index}`, "12", "", "iteration-01"], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }));
  expect(outcomes.map(result => ({ code: result.code, err: result.err }))).toEqual(Array.from({ length: 8 }, () => ({ code: 0, err: "" })));
  expect(outcomes.reduce((sum, result) => sum + JSON.parse(result.out).created, 0)).toBe(40);
  const after = new EvalLedger(path);
  try { expect(after.batch().reservedImageAttempts).toBe(100); expect(after.batch("iteration-01").reservedImageAttempts).toBe(40); expect(after.report().reservedImageAttempts).toBe(140); }
  finally { after.close(); }
}, 30_000);

test("batch CLI flags and authorization arguments require explicit bounded decisions", () => {
  const args = ["authorize-batch", "--authorization", "approval.json", "--batch-id", "iteration-01", "--single", "40", "--sequence", "0", "--reserve", "0", "--approve-budget"];
  expect(parseBatchApprovalArguments(args)).toEqual({ authorizationFile: "approval.json", approval });
  for (const altered of [args.slice(0, -1), [...args, "--approve-budget"], [...args, "--single", "40"], [...args, "--execute"], args.filter(arg => arg !== "--reserve"), args.map(arg => arg === "40" ? "1e3" : arg)])
    expect(() => parseBatchApprovalArguments(altered)).toThrow();
  expect(selectedBatchArgument(["run"])).toBe("initial"); expect(selectedBatchArgument(["run", "--batch-id", "iteration-01"])).toBe("iteration-01");
  for (const args of [["run", "--batch-id"], ["run", "--batch-id", "--execute"], ["run", "--batch-id", "a", "--batch-id", "b"], ["run", "--batch-id", "bad:id"]]) expect(() => selectedBatchArgument(args)).toThrow();
});

test("batch namespace isolates old jobs and every prior-round dependency without changing original config", () => {
  const config = starterConfig(), before = canonical(config), initial = buildJobs(config), jobs = namespaceJobs(initial, "iteration-01");
  expect(canonical(config)).toBe(before); expect(namespaceJobs(initial, "initial")).toEqual(initial);
  expect(jobs.every(job => job.key.startsWith("batch:iteration-01:"))).toBe(true);
  const round2 = jobs.find(job => job.round === 2)!;
  expect(round2.sample.sources[0]!.fromAttempt).toBe(`batch:iteration-01:${initial.find(job => job.key === round2.key.replace("batch:iteration-01:", ""))!.sample.sources[0]!.fromAttempt}`);
  expect(jobs.find(job => job.round === 3 && job.sample.id === "garment-color")!.sample.sources[0]!.fromAttempt).toBeUndefined();
  expect(jobs.some(job => initial.some(old => old.key === job.key))).toBe(false);
});

test("run batch approval and remaining quota are checked before network; config cannot borrow another batch", async () => {
  const { path } = await temporary(), ledger = new EvalLedger(path), config = starterConfig(); bind(ledger);
  config.models = config.models.slice(0, 1); config.samples = config.samples.slice(0, 1); config.strategies = ["raw"]; config.sequenceSampleIds = [];
  config.allocation = { single: 1, sequence: 0, reserve: 0 };
  const jobs = namespaceJobs(buildJobs(config), "small");
  try {
    expect(() => validateRunBatch(ledger, config, jobs, "small")).toThrow("BATCH_BUDGET_NOT_APPROVED");
    ledger.authorizeBatch(authorization, { batchId: "small", allocation: config.allocation, approveBudget: true });
    expect(() => validateRunBatch(ledger, config, jobs, "small")).not.toThrow();
    expect(() => validateRunBatch(ledger, { ...config, allocation: { single: 2, sequence: 0, reserve: 0 } }, jobs, "small")).toThrow("CONFIG_BATCH_ALLOCATION_MISMATCH");
    ledger.reserve("other", "single", {}, "small");
    expect(() => validateRunBatch(ledger, config, jobs, "small")).toThrow("SELECTED_JOBS_EXCEED_REMAINING_BATCH");
  } finally { ledger.close(); }
});

test("additional batch survives restart and is still GET-only after a pre-submit interruption", async () => {
  const { path, directory } = await temporary(), config = starterConfig(), job = namespaceJobs(buildJobs(config), "iteration-01")[0]!;
  let ledger = new EvalLedger(path); bind(ledger); ledger.authorizeBatch(authorization, approval);
  const calls: string[] = [], client = new ApplicationClient(config.apiOrigin, "", async (url: any, init: any) => { calls.push(`${init.method} ${new URL(url).pathname}`); return Response.json({}, { status: 404 }); });
  const input = await new EvaluationTransport(config, client, ledger, directory).prepare(job);
  const before = ledger.reserve(job.key, "single", input, "iteration-01").attempt; ledger.close(); ledger = new EvalLedger(path);
  try {
    await executeAttempt(ledger, job.key, "single", input, new EvaluationTransport(config, client, ledger, directory), "iteration-01");
    expect(calls.length).toBe(1); expect(calls.every(call => call.startsWith("GET /api/tasks/by-request/"))).toBe(true);
    expect(ledger.get(job.key)).toMatchObject({ requestId: before.requestId, batchId: "iteration-01", status: "uncertain", imagePostStarted: false });
    expect(ledger.batch("iteration-01").reservedImageAttempts).toBe(1); expect(ledger.batch().reservedImageAttempts).toBe(0);
  } finally { ledger.close(); }
});
