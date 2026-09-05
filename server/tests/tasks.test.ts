import { describe, expect, test } from "bun:test";
import {
  deriveBatchStatus,
  queueScore,
  restoreWaitingTasksToQueue,
  type BatchTaskCounts,
} from "../src/tasks";

describe("task queue priority", () => {
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
