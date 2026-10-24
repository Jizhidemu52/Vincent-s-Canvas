import type { PromptDatabase } from "./prompt-recipe-store";
import { PromptOptimizationError } from "./prompt-safety";

type Failure = { index: number; reason: string; code?: string };
type BatchDetails = { prompt: string; optimized: boolean; projectId: string; operationType: string; modelConfigId: string; totalItems: number; failures: Failure[] };
type BatchRow = { id: string; user_id: string; request_id: string; input_hash: string; status: "admitting" | "complete" | "interrupted"; details: string; created_at: string };
export type DemoPromptBatch = BatchDetails & { id: string; userId: string; requestId: string; inputHash: string; status: BatchRow["status"]; createdAt: string };
const present = (row: BatchRow): DemoPromptBatch => ({ ...JSON.parse(row.details), id: row.id, userId: row.user_id, requestId: row.request_id, inputHash: row.input_hash, status: row.status, createdAt: row.created_at });

/** Durable admission ledger only. Provider work stays in the existing task store. */
export class DemoPromptBatchStore {
  constructor(private readonly database: PromptDatabase) {}
  async initialize() {
    await this.database.query(`CREATE TABLE IF NOT EXISTS demo_prompt_batches (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('admitting','complete','interrupted')),
      details TEXT NOT NULL CHECK(json_valid(details)),created_at TEXT NOT NULL,UNIQUE(user_id,request_id))`);
    // Restart cannot know whether unrecorded items were submitted. Recover only known task IDs.
    await this.database.query("UPDATE demo_prompt_batches SET status='interrupted' WHERE status='admitting'");
  }
  async get(userId: string, requestId: string) {
    const row = (await this.database.query<BatchRow>("SELECT * FROM demo_prompt_batches WHERE user_id=$1 AND request_id=$2", [userId, requestId])).rows[0];
    return row ? present(row) : null;
  }
  async create(userId: string, requestId: string, inputHash: string, details: Omit<BatchDetails, "failures">) {
    return this.database.transaction(async client => {
      const previous = (await client.query<BatchRow>("SELECT * FROM demo_prompt_batches WHERE user_id=$1 AND request_id=$2", [userId, requestId])).rows[0];
      if (previous) {
        if (previous.input_hash !== inputHash) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "同一批次编号的输入已改变，请新建批次", 409);
        return present(previous);
      }
      const inserted = await client.query<BatchRow>("INSERT INTO demo_prompt_batches(id,user_id,request_id,input_hash,status,details,created_at) VALUES($1,$2,$3,$4,'admitting',$5,$6) RETURNING *", [crypto.randomUUID(), userId, requestId, inputHash, JSON.stringify({ ...details, failures: [] }), new Date().toISOString()]);
      return present(inserted.rows[0]!);
    });
  }
  async failure(batch: DemoPromptBatch, failure: Failure) {
    const failures = [...batch.failures.filter(item => item.index !== failure.index), failure].sort((a, b) => a.index - b.index);
    const { id: _id, userId: _user, requestId: _request, inputHash: _hash, status: _status, createdAt: _created, ...details } = batch;
    await this.database.query("UPDATE demo_prompt_batches SET details=$1 WHERE id=$2", [JSON.stringify({ ...details, failures }), batch.id]);
    batch.failures = failures;
  }
  async finish(batch: DemoPromptBatch) {
    await this.database.query("UPDATE demo_prompt_batches SET status='complete' WHERE id=$1", [batch.id]);
    batch.status = "complete";
  }
  result<T extends { id: string; requestId: string; ownerUserId: string; batchId?: string }>(batch: DemoPromptBatch, allTasks: Iterable<T>) {
    const tasks = [...allTasks].filter(task => task.ownerUserId === batch.userId && task.batchId === batch.id)
      .map(task => ({ ...task, itemIndex: Number(task.requestId.slice(batch.requestId.length + 1)) })).sort((a, b) => a.itemIndex - b.itemIndex);
    const failures = [...batch.failures];
    if (batch.status === "interrupted") for (let index = 0; index < batch.totalItems; index++) {
      if (!tasks.some(task => task.itemIndex === index) && !failures.some(item => item.index === index)) failures.push({ index, reason: "批次提交已中断，此项没有已保存任务；不会自动重新提交", code: "BATCH_SUBMISSION_INTERRUPTED" });
    }
    return { batchId: batch.id, tasks, failures, prompt: batch.prompt, optimized: batch.optimized, totalItems: batch.totalItems, submissionComplete: batch.status !== "admitting" };
  }
}

/** Only in-process callers can supply the operation; there is no trusted-client flag. */
export class DemoAdmissionGate {
  private readonly running = new Map<string, { hash: string; result: Promise<Response> }>();
  async run(key: string, hash: string, action: () => Promise<Response>) {
    const previous = this.running.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "同一请求编号的输入已改变，请新建请求", 409);
      return (await previous.result).clone();
    }
    const result = Promise.resolve().then(action);
    this.running.set(key, { hash, result });
    try { return (await result).clone(); }
    finally { if (this.running.get(key)?.result === result) this.running.delete(key); }
  }
}
