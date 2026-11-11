import { expect, test } from "bun:test";
import express from "express";
import { IMAGE_RESULT_POSTPROCESS_FAILURE_CODE, IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX } from "../../shared/generation-error";
import type { Cache, Database } from "../src/db";
import { createAdminTasksRouter, createTasksRouter } from "../src/routes/tasks";

async function harness(reason: string, toolKey = "hd-upscale") {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const batchId = "22222222-2222-4222-8222-222222222222";
  const postprocess = reason.startsWith(`${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：`);
  const state = { status: "paused", queued: [] as string[], taskWrites: [] as string[], statements: [] as string[] };
  const db = { query: async (sql: string) => {
    state.statements.push(sql);
    if (sql.includes("FROM tasks t JOIN users u")) return { rows: [{ id: taskId, requestId: "original-request", toolKey, status: state.status,
      operationType: "image_generation", attempts: 1, upstreamTaskId: "existing-upstream", submissionStartedAt: "2026-11-11T00:00:00Z",
      priority: "normal", queuedAt: "2026-11-11T00:00:00Z", availableAt: "2026-11-11T00:00:00Z", failureReason: reason,
      errorCode: postprocess ? IMAGE_RESULT_POSTPROCESS_FAILURE_CODE : null,
      lastFailure: postprocess ? { phase: "postprocess", code: IMAGE_RESULT_POSTPROCESS_FAILURE_CODE } : null }] };
    if (sql.startsWith("SELECT id,request_id")) return { rows: [{ id: taskId, request_id: "original-request", batch_id: null, status: state.status,
      tool_key: toolKey, operation_type: "image_generation", attempts: 1, upstream_task_id: "existing-upstream", upstream_submission_started_at: "2026-11-11T00:00:00Z",
      priority: "normal", queued_at: "2026-11-11T00:00:00Z", failure_reason: reason }] };
    if (sql.startsWith("SELECT id FROM tasks") || sql.startsWith("SELECT id,department_id FROM tasks")) return { rows: [{ id: taskId, department_id: "department" }] };
    if (sql.startsWith("SELECT id FROM batch_tasks") || sql.startsWith("SELECT id,department_id FROM batch_tasks")) return { rows: [{ id: batchId, department_id: "department" }] };
    if (sql.includes("COUNT(*)::int total")) return { rows: [{ total: 1, success: 0, failed: 0, cancelled: 0, paused: 1, waiting: 0, processing: 0 }] };
    if (sql.startsWith("UPDATE batch_tasks")) return { rows: [] };
    if (sql.startsWith("UPDATE tasks SET status='waiting'")) {
      state.taskWrites.push(sql); state.status = "waiting"; return { rows: [{ id: taskId }] };
    }
    if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
    throw new Error(`Unexpected database access: ${sql.slice(0, 100)}`);
  } } as unknown as Database;
  const cache = { eval: async (_script: string, options: { arguments: string[] }) => { state.queued.push(options.arguments[0]!); return 1; } } as unknown as Cache;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { (request as any).auth = { id: "owner", role: "super_admin", departmentId: "department" }; next(); });
  app.use("/api/tasks", createTasksRouter(db, cache));
  app.use("/api/admin/tasks", createAdminTasksRouter(db, cache));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { state, taskId, batchId, post: (path: string) => fetch(`${base}${path}`, { method: "POST" }),
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("old-page recovery cannot requeue a saved-original postprocessing failure or reveal private diagnostics", async () => {
  const h = await harness(`${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：private decoder URL https://internal.example`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await h.post(`/api/tasks/${h.taskId}/recover`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ recovered: false, task: { status: "paused", errorCode: "IMAGE_RESULT_PROCESSING_FAILED", lastFailure: { phase: "postprocess" } } });
      expect(body.message).toContain(IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX);
      expect(body.message).not.toMatch(/查询原任务|private|internal|https:/);
    }
    expect(h.state.queued).toEqual([]);
    expect(h.state.taskWrites).toEqual([]);
    expect(h.state.statements).toHaveLength(2);
  } finally { await h.close(); }
});

test("employee, admin and batch resume routes all fence postprocessing failures before task mutation", async () => {
  const h = await harness(`${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：invalid matte`);
  try {
    for (const path of [
      `/api/tasks/${h.taskId}/resume`, `/api/admin/tasks/${h.taskId}/resume`,
      `/api/tasks/batches/${h.batchId}/resume`, `/api/admin/tasks/batches/${h.batchId}/resume`,
    ]) {
      const response = await h.post(path);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/^INVALID_(?:TASK|BATCH)_STATE$/);
    }
    expect(h.state.status).toBe("paused");
    expect(h.state.queued).toEqual([]);
    expect(h.state.taskWrites).toEqual([]);
  } finally { await h.close(); }
});

for (const [toolKey, reason] of [
  ["ordinary-image", "服务商查询暂时失败；已暂停，可恢复查询原任务，不会重新生成"],
  ["layer-studio", "部分图层原件尚未保存；可恢复原任务继续保存，不会重新生成，请勿重复提交"],
]) {
  test(`${toolKey} recovery still schedules the same task without a new submission or reservation`, async () => {
    const h = await harness(reason!, toolKey);
    try {
      const response = await h.post(`/api/tasks/${h.taskId}/recover`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ recovered: true, task: { id: h.taskId, status: "waiting", upstreamTaskId: "existing-upstream" } });
      expect(h.state.queued).toEqual([h.taskId]);
      expect(h.state.taskWrites).toHaveLength(1);
      expect(h.state.taskWrites[0]).toContain("AND COALESCE(failure_reason,'') NOT LIKE $2");
      expect(h.state.statements.some(sql => /INSERT|credit_reservations|wallet/.test(sql))).toBe(false);
    } finally { await h.close(); }
  });
}
