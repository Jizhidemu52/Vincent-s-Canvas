import { describe, expect, test } from "bun:test";
import {
  deriveBatchStatus,
  queueScore,
  type BatchTaskCounts,
} from "../src/tasks";

describe("task queue priority", () => {
  test("orders urgent before priority and normal while preserving FIFO time", () => {
    expect(queueScore("urgent", 200)).toBeLessThan(queueScore("priority", 100));
    expect(queueScore("priority", 200)).toBeLessThan(queueScore("normal", 100));
    expect(queueScore("normal", 100)).toBeLessThan(queueScore("normal", 200));
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
