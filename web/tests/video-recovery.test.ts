import { afterEach, expect, test } from "bun:test";
import { getQueuedTask, QueuedTaskPausedError, requestQueuedMedia, recoverQueuedMedia } from "@/services/api/generation-tasks";
import { pollVideoGenerationTask, recoverVideoGenerationTask } from "@/services/api/video";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
const task = { id: "original-task", requestId: "original-request", operationType: "video_generation", status: "paused", upstreamTaskId: "upstream-original", resultUrls: [], failureReason: "查询超时" };
function respond(read: (url: string, method: string) => unknown) {
  globalThis.window = { location: { pathname: "/canvas/test" } } as Window & typeof globalThis;
  globalThis.fetch = (async (input, init) => {
    const result = read(String(input), init?.method || "GET");
    return result instanceof Response ? result : new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("an older task is queried directly even when it is absent from the recent 500 tasks", async () => {
  const calls: string[] = [];
  respond((url, method) => {
    calls.push(`${method}:${url}`);
    return url === "/api/tasks/original-task" ? { task } : { tasks: Array.from({ length: 500 }, (_, i) => ({ ...task, id: `newer-${i}` })) };
  });
  expect(await getQueuedTask(task.id)).toEqual(task);
  expect(calls).toEqual(["GET:/api/tasks/original-task"]);
});

test("single-task reads distinguish a missing task from a server error", async () => {
  respond(() => new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 }));
  expect(await getQueuedTask(task.id)).toBeNull();
  respond(() => new Response(JSON.stringify({ message: "任务服务暂不可用" }), { status: 503 }));
  await expect(getQueuedTask(task.id)).rejects.toThrow("任务服务暂不可用");
});

test("media polling stops on paused and preserves the original server task ID", async () => {
  const calls: string[] = [];
  let savedTask = "";
  respond((url, method) => {
    calls.push(`${method}:${url}`);
    if (url === "/api/models") return { models: [{ id: "model", modelId: "wan2.7", name: "Wan" }] };
    if (url === "/api/tasks/preflight") return { ok: true, normalized: {} };
    if (url === "/api/tasks" && method === "POST") return { task: { ...task, status: "waiting" } };
    if (url === "/api/tasks/original-task") return { task };
    if (url === "/api/auth/session") return { user: null };
    throw new Error(`Unexpected ${method} ${url}`);
  });
  try {
    await requestQueuedMedia({ modelId: "wan2.7", prompt: "产品旋转", operationType: "video_generation", onSubmitted: (value) => { savedTask = value.id; } });
    throw new Error("Expected paused task");
  } catch (error) {
    expect(error).toBeInstanceOf(QueuedTaskPausedError);
    expect(error).toMatchObject({ taskId: "original-task", canRecover: true });
  }
  expect(savedTask).toBe("original-task");
  expect(calls.filter((item) => item === "POST:/api/tasks")).toHaveLength(1);
  expect(calls.filter((item) => item === "GET:/api/tasks/original-task")).toHaveLength(1);
  expect(calls).not.toContain("GET:/api/tasks");
  expect(calls.some((item) => item.includes("cancel"))).toBe(false);
});

test("video polling surfaces a non-recoverable unknown submission instead of pending forever", async () => {
  respond(() => ({ task: { ...task, upstreamTaskId: null } }));
  await expect(pollVideoGenerationTask({} as never, { id: task.id, model: "wan2.7", provider: "server" })).rejects.toMatchObject({ taskId: "original-task", canRecover: false });
});

test("recovering a video only queries the original task and never creates new generation", async () => {
  const calls: string[] = [];
  respond((url, method) => {
    calls.push(`${method}:${url}`);
    if (url.endsWith("/recover")) return { recovered: true, task: { ...task, status: "waiting" } };
    if (url === "/api/tasks/original-task") return { task: { ...task, status: "success", resultUrls: ["/api/assets/video/content"] } };
    if (url === "/api/auth/session") return { user: null };
    throw new Error(`Unexpected ${method} ${url}`);
  });
  expect(await recoverVideoGenerationTask({ id: task.id, model: "wan2.7", provider: "server" })).toEqual({ url: "/api/assets/video/content", mimeType: "video/mp4" });
  expect(calls.filter((item) => item.startsWith("POST:"))).toEqual(["POST:/api/tasks/original-task/recover"]);
  expect(calls).toContain("GET:/api/tasks/original-task");
  expect(calls).not.toContain("GET:/api/tasks");
});

test("refused recovery remains actionable and never falls through to generation", async () => {
  const calls: string[] = [];
  respond((url, method) => { calls.push(`${method}:${url}`); return { recovered: false, message: "上游提交状态待核查", task: { ...task, upstreamTaskId: null } }; });
  await expect(recoverQueuedMedia(task.id)).rejects.toMatchObject({ taskId: task.id, canRecover: false });
  expect(calls).toEqual(["POST:/api/tasks/original-task/recover"]);
});
