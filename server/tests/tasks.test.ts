import { describe, expect, test } from "bun:test";
import {
  deriveBatchStatus,
  queueScore,
  restoreWaitingTasksToQueue,
  canAutomaticallyRetryTask,
  transitionTask,
  transitionBatchTasks,
  type BatchTaskCounts,
} from "../src/tasks";

describe("task queue priority", () => {
  test("does not replay image, audio or workflow work after an uncertain failure", () => {
    for (const operation of ["image_generation", "image_edit", "audio_generation", "seamless_stitch", "workflow"]) {
      expect(canAutomaticallyRetryTask(operation, null, 1)).toBe(false);
    }
    expect(canAutomaticallyRetryTask("video_generation", null, 1)).toBe(true);
    expect(canAutomaticallyRetryTask("video_generation", "2026-09-10T00:00:00Z", 1)).toBe(false);
    expect(canAutomaticallyRetryTask("video_generation", null, 3)).toBe(false);
  });

  test("single and batch resume cannot replay previously started non-video work", async () => {
    const task = { id: "image-1", request_id: "request-1", batch_id: "batch-1", status: "paused", priority: "normal", operation_type: "image_generation", attempts: 1 };
    const writes: string[] = [];
    const database = { query: async (sql: string) => {
      if (sql.startsWith("SELECT id FROM tasks")) return { rows: [{ id: task.id }] };
      if (sql.startsWith("SELECT id,request_id")) return { rows: [task] };
      if (sql.includes("COUNT(*)::int total")) return { rows: [{ total: 1, paused: 1 }] };
      writes.push(sql);
      return { rows: [] };
    } };
    const queued: string[] = [];
    const cache = { zAdd: async (_key: string, value: { value: string }) => (queued.push(value.value), 1) };
    expect(await transitionTask(database as never, cache as never, task.id, "resume")).toBeNull();
    expect(await transitionBatchTasks(database as never, cache as never, "batch-1", "resume")).toBe(0);
    expect(queued).toEqual([]);
    expect(writes.some((sql) => sql.startsWith("UPDATE tasks"))).toBe(false);
  });
  test("orders urgent before priority and normal while preserving FIFO time", () => {
    expect(queueScore("urgent", 200)).toBeLessThan(queueScore("priority", 100));
    expect(queueScore("priority", 200)).toBeLessThan(queueScore("normal", 100));
    expect(queueScore("normal", 100)).toBeLessThan(queueScore("normal", 200));
  });

  test("restores database-backed waiting work after a worker restart", async () => {
    const writes: Array<{ score: number; value: string }> = [];
    const database = {
      query: async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [
          { id: "normal", priority: "normal", queued_at: "2026-09-05T00:00:00.000Z" },
          { id: "urgent", priority: "urgent", queued_at: "2026-09-05T00:01:00.000Z" },
        ] : [] }),
    };
    const cache = { zAdd: async (_key: string, member: { score: number; value: string }) => (writes.push(member), 1) };

    await expect(restoreWaitingTasksToQueue(database as never, cache as never)).resolves.toBe(2);
    expect(writes.map((item) => item.value)).toEqual(["normal", "urgent"]);
    expect(writes[1]!.score).toBeLessThan(writes[0]!.score);
  });

  test("requeues only processing work whose execution lease has expired", async () => {
    const statements: string[] = [];
    const database = {
      query: async (sql: string) => (statements.push(sql), { rows: [] }),
    };
    const cache = { zAdd: async () => 1 };

    await restoreWaitingTasksToQueue(database as never, cache as never);

    expect(statements[0]).toContain("status='processing'");
    expect(statements[0]).toContain("lease_expires_at <= now()");
  });
});

describe("batch task state", () => {
  const counts = (value: Partial<BatchTaskCounts>): BatchTaskCounts => ({
    total: 3,
    success: 0,
    failed: 0,
    cancelled: 0,
    paused: 0,
    waiting: 0,
    processing: 0,
    ...value,
  });

  test("keeps paused and cancelled distinct from failures", () => {
    expect(deriveBatchStatus(counts({ paused: 3 }))).toBe("paused");
    expect(deriveBatchStatus(counts({ cancelled: 3 }))).toBe("cancelled");
    expect(deriveBatchStatus(counts({ failed: 3 }))).toBe("failed");
    expect(deriveBatchStatus(counts({ success: 2, failed: 1 }))).toBe(
      "partial",
    );
  });

  test("reports active work before terminal or paused states", () => {
    expect(deriveBatchStatus(counts({ waiting: 3 }))).toBe("waiting");
    expect(deriveBatchStatus(counts({ success: 1, waiting: 2 }))).toBe(
      "processing",
    );
    expect(deriveBatchStatus(counts({ paused: 2, processing: 1 }))).toBe(
      "processing",
    );
  });
});
