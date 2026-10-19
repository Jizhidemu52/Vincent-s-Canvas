import { describe, expect, test } from "bun:test";
import { transitionBatchTasks, transitionTask } from "../src/tasks";

type Task = {
  id: string; request_id: string; batch_id: string | null; status: string;
  priority: "normal"; operation_type: string; attempts: number;
  upstream_task_id: string | null; upstream_submission_started_at: string | null;
};
const task = (patch: Partial<Task> = {}): Task => ({
  id: "image", request_id: "request", batch_id: null, status: "paused", priority: "normal",
  operation_type: "image_generation", attempts: 0, upstream_task_id: null, upstream_submission_started_at: null, ...patch,
});

// Execute the actual task and settlement functions against isolated in-memory
// database/cache fixtures. Never connect to PostgreSQL, Redis or a provider.
function harness(records: Task[], afterRead?: (record: Task) => void) {
  const writes: string[] = [], settled: string[] = [], removed: string[] = [], queued: string[] = [];
  const reservations = new Map(records.map(record => [record.request_id, { id: record.request_id, status: "held", billing_disabled: true }]));
  const query = async (sql: string, values: unknown[] = []): Promise<{ rows: any[] }> => {
    const record = records.find(item => item.id === values[0]);
    if (sql.startsWith("SELECT id,request_id")) {
      const selected = record && ["waiting", "paused"].includes(record.status) ? { ...record } : undefined;
      if (record) afterRead?.(record);
      return { rows: selected ? [selected] : [] };
    }
    if (sql.startsWith("SELECT id FROM tasks")) return { rows: records.filter(item => item.batch_id === values[0] && (values[1] as string[]).includes(item.status)).map(item => ({ id: item.id })) };
    if (sql.includes("COUNT(*)::int total")) {
      const batch = records.filter(item => item.batch_id === values[0]);
      return { rows: [{ total: batch.length, ...Object.fromEntries(["success", "failed", "cancelled", "paused", "waiting", "processing"].map(status => [status, batch.filter(item => item.status === status).length])) }] };
    }
    if (sql.includes("FROM credit_reservations")) return { rows: [reservations.get(String(values[0]))] };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    writes.push(sql);
    if (sql.startsWith("UPDATE tasks SET status='cancelled'")) {
      expect(sql).toContain("upstream_task_id IS NULL");
      expect(sql).toContain("upstream_submission_started_at IS NULL");
      expect(sql).toContain("operation_type='video_generation' OR attempts=0");
      if (!record || record.status !== values[1] || record.upstream_task_id !== null || record.upstream_submission_started_at !== null
        || (record.operation_type !== "video_generation" && record.attempts !== 0)) return { rows: [] };
      record.status = "cancelled";
      return { rows: [{ id: record.id }] };
    }
    if (sql.startsWith("UPDATE tasks SET status='waiting'")) {
      if (!record || record.status !== "paused") return { rows: [] };
      record.status = "waiting";
      return { rows: [{ id: record.id }] };
    }
    if (sql.startsWith("UPDATE credit_reservations SET status=$1")) {
      reservations.get(String(values[1]))!.status = String(values[0]);
      settled.push(String(values[1]));
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE batch_tasks")) return { rows: [] };
    throw new Error(`Unexpected fixture query: ${sql}`);
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  const cache = {
    eval: async (_script: string, options: { arguments: string[] }) => {
      (options.arguments.length === 1 ? removed : queued).push(options.arguments[0]!); return 1;
    },
    zAdd: async (_key: string, member: { value: string }) => (queued.push(member.value), 1),
  };
  return { records, writes, settled, removed, queued, reservations,
    cancel: (id = records[0]!.id) => transitionTask(db as never, cache as never, id, "cancel", false),
    resume: (id = records[0]!.id) => transitionTask(db as never, cache as never, id, "resume", false),
    cancelBatch: () => transitionBatchTasks(db as never, cache as never, "batch", "cancel"),
  };
}

describe("task cancellation submission boundary", () => {
  for (const status of ["paused", "waiting"]) {
    for (const patch of [
      { attempts: 1, upstream_task_id: "original-upstream", upstream_submission_started_at: "submitted" },
      { attempts: 1, upstream_submission_started_at: "submitted" },
      { attempts: 0, upstream_task_id: "original-upstream" },
      { attempts: 0, upstream_submission_started_at: "submitted" },
      { attempts: 1 },
    ]) test(`${status} uncertain image submission is not cancelled or refunded: ${JSON.stringify(patch)}`, async () => {
      const original = task({ status, ...patch }), h = harness([original]);
      const before = structuredClone(original);
      expect(await h.cancel()).toBeNull();
      expect(original).toEqual(before);
      expect(h.reservations.get(original.request_id)?.status).toBe("held");
      expect(h.writes).toEqual([]); expect(h.settled).toEqual([]); expect(h.removed).toEqual([]);
    });
  }

  test.each(["audio_generation", "seamless_stitch"])("started synchronous %s retains its unknown outcome and held credits", async operation_type => {
    const h = harness([task({ operation_type, attempts: 1 })]);
    expect(await h.cancel()).toBeNull(); expect(h.settled).toEqual([]); expect(h.writes).toEqual([]);
  });

  test.each(["paused", "waiting"])("never-submitted %s image cancels and releases exactly once", async status => {
    const h = harness([task({ status })]);
    expect(await h.cancel()).toMatchObject({ action: "cancel", previousStatus: status });
    expect(h.records[0]!.status).toBe("cancelled");
    expect(h.reservations.get("request")?.status).toBe("released");
    expect(await h.cancel()).toBeNull();
    expect(h.settled).toEqual(["request"]); expect(h.removed).toEqual(["image"]);
  });

  test("video preparation retry is cancellable only before its persisted submission intent", async () => {
    const preparation = harness([task({ operation_type: "video_generation", attempts: 1 })]);
    expect(await preparation.cancel()).not.toBeNull(); expect(preparation.settled).toEqual(["request"]);
    const submitted = harness([task({ operation_type: "video_generation", attempts: 1, upstream_submission_started_at: "submitted" })]);
    expect(await submitted.cancel()).toBeNull(); expect(submitted.settled).toEqual([]);
  });

  test.each(["upstream_task_id", "upstream_submission_started_at"] as const)("a concurrent %s update cannot slip past cancellation's SQL guard", async field => {
    const h = harness([task()], record => { record[field] = "submitted-concurrently"; });
    expect(await h.cancel()).toBeNull(); expect(h.records[0]!.status).toBe("paused");
    expect(h.settled).toEqual([]); expect(h.removed).toEqual([]);
  });

  test("a concurrently started synchronous attempt cannot be cancelled from a stale snapshot", async () => {
    const h = harness([task()], record => { record.attempts = 1; });
    expect(await h.cancel()).toBeNull(); expect(h.records[0]!.status).toBe("paused");
    expect(h.settled).toEqual([]); expect(h.removed).toEqual([]);
  });

  test("known upstream task still resumes by original identity after cancellation is rejected", async () => {
    const h = harness([task({ attempts: 1, upstream_task_id: "original-upstream", upstream_submission_started_at: "submitted" })]);
    expect(await h.cancel()).toBeNull();
    expect(await h.resume()).toMatchObject({ action: "resume" });
    expect(h.queued).toEqual(["image"]); expect(h.records[0]!.upstream_task_id).toBe("original-upstream");
    expect(h.settled).toEqual([]);
  });

  test("batch cancellation skips submitted/uncertain tasks while releasing unsubmitted items", async () => {
    const h = harness([
      task({ id: "fresh", request_id: "fresh-request", batch_id: "batch", status: "waiting" }),
      task({ id: "submitted", request_id: "submitted-request", batch_id: "batch", attempts: 1, upstream_task_id: "original-upstream" }),
      task({ id: "uncertain", request_id: "uncertain-request", batch_id: "batch", attempts: 1 }),
    ]);
    expect(await h.cancelBatch()).toBe(1);
    expect(h.records.map(record => record.status)).toEqual(["cancelled", "paused", "paused"]);
    expect(h.settled).toEqual(["fresh-request"]); expect(h.removed).toEqual(["fresh"]);
  });
});
