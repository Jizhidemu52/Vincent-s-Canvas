import { expect, test } from "bun:test";
import { calculateTaskProgress, readDemoTaskProgress } from "../src/task-progress";
import { queueScore } from "../src/tasks";

const now = Date.parse("2026-10-20T00:00:00Z");
const task = (id: string, patch = {}) => ({
  id, status: "waiting", modelConfigId: "model", operationType: "image_generation",
  startedMs: null as number | null, submitted: false, slotOccupied: false, ...patch,
});
const target = { ...task("target"), nowMs: now, concurrency: 2 };
const ready = (id: string, timestamp = now, priority: "normal" | "urgent" = "normal", due = 0) => ({ id, score: queueScore(priority, timestamp), due });

test("actual ready priority/FIFO excludes delayed and already-submitted work", () => {
  const rows = [task("target"), task("normal"), task("urgent"), task("later"), task("upstream", { submitted: true })];
  const members = [ready("target"), ready("normal", now - 1), ready("urgent", now + 1, "urgent"), ready("later", now, "urgent", now + 2000), ready("upstream", now - 20)];
  expect(calculateTaskProgress(target, { tasks: rows, samples: [60, 60, 60] }, members)).toMatchObject({
    queuePosition: 3, estimatedRemainingSeconds: null, estimateReason: "queue_changing",
  });
  expect(calculateTaskProgress(target, { tasks: rows, samples: [] }, [ready("target", now, "normal", now + 2000)])).toMatchObject({
    phase: "delayed", queuePosition: null, retryAfterSeconds: 2,
  });
});

test("observed durations and occupied model slots determine waiting and completion estimates", () => {
  const rows = [task("target"), task("first"), task("second"), task("inflight", { status: "processing", submitted: true, slotOccupied: true, startedMs: now - 10_000 })];
  const members = [ready("target"), ready("first", now - 2), ready("second", now - 1)];
  expect(calculateTaskProgress(target, { tasks: rows, samples: [59, 60, 61] }, members)).toMatchObject({
    queuePosition: 3, sampleCount: 3, estimatedWaitSeconds: 60, estimatedRemainingSeconds: 120,
  });
  const inflight = { ...target, ...rows[3]! };
  expect(calculateTaskProgress(inflight, { tasks: rows, samples: [59, 60, 61] }, [])).toMatchObject({
    phase: "processing", queuePosition: null, estimatedRemainingSeconds: 50,
  });
});

test("no fabricated ETA when samples, inflight outcome or comparable workload are unavailable", () => {
  const member = [ready("target")];
  expect(calculateTaskProgress(target, { tasks: [target], samples: [60, 60] }, member)).toMatchObject({
    queuePosition: 1, estimatedRemainingSeconds: null, estimateReason: "insufficient_samples",
  });
  const cases = [
    { row: task("blocked", { status: "paused", submitted: true, slotOccupied: true }), reason: "unresolved_inflight" },
    { row: task("mixed", { status: "processing", slotOccupied: true, operationType: "inpaint" }), reason: "mixed_operations" },
    { row: task("overdue", { status: "processing", slotOccupied: true, startedMs: now - 90_000 }), reason: "duration_exceeded" },
    { row: task("claiming", { status: "processing" }), reason: "queue_changing" },
  ];
  for (const { row, reason } of cases)
    expect(calculateTaskProgress(target, { tasks: [target, row], samples: [60, 60, 60] }, member)).toMatchObject({
      queuePosition: 1, estimatedRemainingSeconds: null, estimateReason: reason,
    });
});

test("terminal, paused and missing membership never display a stale queue number", () => {
  for (const status of ["success", "failed", "cancelled", "paused"]) {
    const progress = calculateTaskProgress({ ...target, status }, { tasks: [], samples: [60, 60, 60] }, [ready("target")]);
    expect(progress.queuePosition).toBeNull();
    expect(progress.estimatedRemainingSeconds).toBeNull();
  }
  expect(calculateTaskProgress(target, { tasks: [target], samples: [60, 60, 60] }, [])).toMatchObject({ estimateReason: "queue_changing", queuePosition: null });
});

test("demo has no shared queue and only uses this owner's same-model real completion samples", () => {
  const current = { id: "current", status: "processing", ownerUserId: "owner", modelConfigId: "m", operationType: "image_generation", createdAt: new Date(now - 10_000).toISOString(), submissionStartedAt: new Date(now - 10_000).toISOString() };
  const sample = { ...current, status: "success", submissionStartedAt: new Date(now - 120_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString() };
  expect(readDemoTaskProgress(current, [sample, sample, { ...sample, ownerUserId: "other" }], now)).toMatchObject({
    runtime: "demo", queuePosition: null, sampleCount: 2, estimatedRemainingSeconds: null,
  });
  expect(readDemoTaskProgress(current, [sample, sample, sample, { ...sample, operationType: "video_generation" }], now)).toMatchObject({
    runtime: "demo", phase: "processing", queuePosition: null, sampleCount: 3, estimatedRemainingSeconds: 50,
  });
});
