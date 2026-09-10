import { afterEach, describe, expect, test } from "bun:test";
import express, { type ErrorRequestHandler, type Router } from "express";
import type { Server } from "node:http";
import { createTasksRouter } from "../src/routes/tasks";
import { preflightStoredVideoTask } from "../src/stored-video-preflight";

const actorId = "10000000-0000-4000-8000-000000000001";
const modelId = "20000000-0000-4000-8000-000000000001";
const assetId = "30000000-0000-4000-8000-000000000001";
const taskId = "40000000-0000-4000-8000-000000000001";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

type Fixture = {
  moduleEnabled?: boolean;
  model?: Record<string, unknown> | null;
  asset?: Record<string, unknown> | null;
  task?: Record<string, unknown> | null;
};
function dependencies(fixture: Fixture = {}) {
  const writes: string[] = [];
  const queued: unknown[] = [];
  const reads: Array<{ sql: string; params: unknown[] }> = [];
  const database = {
    query: async (sql: string, params: unknown[] = []) => {
      reads.push({ sql, params });
      if (!sql.trimStart().startsWith("SELECT")) writes.push(sql);
      if (sql.startsWith("UPDATE tasks SET status='waiting'")) return { rows: [{ id: fixture.task?.id }] };
      if (sql.includes("FROM module_flags")) return { rows: [{ enabled: fixture.moduleEnabled ?? true }] };
      if (sql.includes("FROM model_configs")) return { rows: fixture.model === null ? [] : [fixture.model || { id: modelId, name: "Wan", modelId: "wan2.7", capabilities: ["video"] }] };
      if (sql.includes("FROM assets")) return { rows: fixture.asset === null ? [] : [fixture.asset || { id: assetId, mimeType: "image/png", byteSize: 512, status: "ready" }] };
      if (sql.startsWith("SELECT id,request_id")) return { rows: fixture.task ? [{ ...fixture.task, operation_type: fixture.task.operationType }] : [] };
      if (sql.includes("FROM tasks")) return { rows: fixture.task ? [fixture.task] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const cache = { zAdd: async (key: string, member: unknown) => { queued.push({ key, member }); return 1; } };
  return { database, cache, writes, queued, reads };
}

async function serve(router: Router, mount = "/api/tasks") {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.assign(request, { auth: { id: actorId, role: "designer", departmentId: null } });
    next();
  });
  app.use(mount, router);
  app.use(((error, _request, response, _next) => {
    response.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.code, message: error.message });
  }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}${mount}`;
}

const videoInput = (extra: Record<string, unknown> = {}) => ({
  requestId: "video-preflight-test", projectId: "local-canvas", operationType: "video_generation", modelConfigId: modelId,
  prompt: "移动镜头", parameters: { seconds: 99, resolution: "bad", size: "bad" }, sourceUrls: [], ...extra,
});
async function post(url: string, body?: unknown) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

describe("production generation routes", () => {
  test("reads an owned older task by ID without a recent-history limit", async () => {
    const deps = dependencies({ task: { id: taskId, requestId: "old-request", status: "success", resultUrls: ["/api/assets/result/content"] } });
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    const response = await fetch(`${url}/${taskId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: { id: taskId, requestId: "old-request", status: "success", resultUrls: ["/api/assets/result/content"] } });
    expect(deps.reads[0]?.params).toEqual([taskId, actorId]);
    expect(deps.reads[0]?.sql).toContain("t.user_id=$2");
    expect(deps.reads[0]?.sql).not.toContain("LIMIT 500");
    expect(deps.writes).toEqual([]);
    expect(deps.queued).toEqual([]);
  });

  test("task-by-ID returns 404 for a missing or inaccessible task and validates IDs", async () => {
    const deps = dependencies();
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    const response = await fetch(`${url}/${taskId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "NOT_FOUND" });
    expect(deps.reads[0]?.params).toEqual([taskId, actorId]);
    const readCount = deps.reads.length;
    expect((await fetch(`${url}/not-a-uuid`)).status).toBe(400);
    expect(deps.reads).toHaveLength(readCount);
  });

  test("preflight normalizes video settings without creating or charging a task", async () => {
    const deps = dependencies();
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    const response = await post(`${url}/preflight`, videoInput());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, normalized: { seconds: 15, resolution: "1080P", size: "16:9", referenceCount: 0 } });
    expect(deps.writes).toEqual([]);
    expect(deps.queued).toEqual([]);
  });

  test("preflight rejects disabled modules and models", async () => {
    for (const fixture of [{ moduleEnabled: false }, { model: null }]) {
      const deps = dependencies(fixture);
      const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
      const response = await post(`${url}/preflight`, videoInput());
      expect(response.status).toBe(fixture.moduleEnabled === false ? 403 : 400);
      expect(deps.writes).toEqual([]);
    }
  });

  test("preflight enforces owned ready references and per-image size", async () => {
    for (const fixture of [{ asset: null }, { asset: { id: assetId, mimeType: "image/png", byteSize: 10 * 1024 * 1024 + 1 } }]) {
      const deps = dependencies(fixture);
      const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
      const response = await post(`${url}/preflight`, videoInput({ sourceUrls: [`/api/assets/${assetId}/content`] }));
      expect(response.status).toBe(400);
      const lookup = deps.reads.find(({ sql }) => sql.includes("FROM assets"));
      expect(lookup?.params).toContain(actorId);
      expect(lookup?.sql).toContain("owner_user_id");
      expect(lookup?.sql).toContain("status='ready'");
      expect(deps.writes).toEqual([]);
    }
  });

  test("preflight rejects unsupported image formats, non-images and excess model references", async () => {
    const deps = dependencies({ model: { id: modelId, modelId: "MiniMax-H3", name: "MiniMax" } });
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    expect((await post(`${url}/preflight`, videoInput({ sourceUrls: Array(10).fill(`/api/assets/${assetId}/content`) }))).status).toBe(400);
    for (const mimeType of ["audio/mpeg", "image/svg+xml", "image/bmp"]) {
      const nonImage = dependencies({ asset: { id: assetId, mimeType, byteSize: 256 } });
      const secondUrl = await serve(createTasksRouter(nonImage.database as never, nonImage.cache as never));
      expect((await post(`${secondUrl}/preflight`, videoInput({ sourceUrls: [`/api/assets/${assetId}/content`] }))).status).toBe(400);
      expect(nonImage.writes).toEqual([]);
      expect(nonImage.queued).toEqual([]);
    }
  });

  test("preflight accepts a local owned image without a public URL or upstream work", async () => {
    const deps = dependencies({ asset: { id: assetId, objectKey: "owned/image.png", mimeType: "image/png", byteSize: 512 } });
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never, true, (db, input) => preflightStoredVideoTask(db, input, "", {
      readSource: async () => new Uint8Array(512), probe: async () => ({ width: 768, height: 768 }),
    })));
    const response = await post(`${url}/preflight`, videoInput({ sourceUrls: [`/api/assets/${assetId}/content`] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ normalized: { referenceCount: 1 } });
    expect(deps.writes).toEqual([]);
    expect(deps.queued).toEqual([]);
    expect((await post(`${url}/preflight`, videoInput({ operationType: "image_generation" }))).status).toBe(400);
    expect((await post(`${url}/preflight`, videoInput({ prompt: "   " }))).status).toBe(400);
  });

  test("recovery only queues an unstarted original task without new billing", async () => {
    const deps = dependencies({ task: { id: taskId, requestId: "original-request", status: "waiting", attempts: 0, priority: "normal", queuedAt: "2026-09-01T00:00:00Z", resultUrls: [] } });
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    const response = await post(`${url}/${taskId}/recover`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovered: true, task: { id: taskId, requestId: "original-request", status: "waiting" } });
    expect(deps.queued).toHaveLength(1);
    expect(deps.queued[0]).toMatchObject({ key: "tasks:queue", member: { value: taskId } });
    expect(deps.writes).toEqual([]);
  });

  test("recovery never resubmits processing, attempted or terminal tasks", async () => {
    for (const task of [{ status: "processing", attempts: 1 }, { status: "waiting", attempts: 1 }, { status: "failed", attempts: 1 }, { status: "success", attempts: 1 }, { status: "cancelled", attempts: 0 }, { status: "paused", attempts: 0 }]) {
      const deps = dependencies({ task: { id: taskId, requestId: "original-request", resultUrls: [], ...task } });
      const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
      const response = await post(`${url}/${taskId}/recover`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ recovered: false, task: { status: task.status } });
      expect(deps.queued).toEqual([]);
      expect(deps.writes).toEqual([]);
    }
  });

  test("recovery does not expose another user's task", async () => {
    const deps = dependencies();
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    expect((await post(`${url}/${taskId}/recover`)).status).toBe(404);
    const lookup = deps.reads.find(({ sql }) => sql.includes("FROM tasks"));
    expect(lookup?.params).toEqual([taskId, actorId]);
    expect(lookup?.sql).toContain("t.user_id=$2");
    expect(deps.queued).toEqual([]);
  });

  test("recovery resumes only polling when a paused video already has an upstream ID", async () => {
    const deps = dependencies({ task: { id: taskId, requestId: "original-request", request_id: "original-request", operationType: "video_generation", upstreamTaskId: "upstream-original", submissionStartedAt: "2026-09-01T00:00:00Z", status: "paused", attempts: 1, priority: "normal", resultUrls: [] } });
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    const response = await post(`${url}/${taskId}/recover`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovered: true, task: { status: "waiting", upstreamTaskId: "upstream-original" } });
    expect(deps.queued).toHaveLength(1);
    expect(deps.queued[0]).toMatchObject({ member: { value: taskId } });
    expect(deps.writes).toHaveLength(1);
    expect(deps.writes[0]).toContain("UPDATE tasks SET status='waiting'");
    expect(deps.writes.some((sql) => /credit|upstream_task_id|INSERT INTO tasks/.test(sql))).toBe(false);
  });

  test("an unknown video submission cannot be reset through recovery", async () => {
    const deps = dependencies({ task: { id: taskId, operationType: "video_generation", upstreamTaskId: null, submissionStartedAt: "2026-09-01T00:00:00Z", status: "paused", attempts: 1, resultUrls: [] } });
    const url = await serve(createTasksRouter(deps.database as never, deps.cache as never));
    const response = await post(`${url}/${taskId}/recover`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recovered: false, task: { status: "paused" } });
    expect(deps.queued).toEqual([]);
    expect(deps.writes).toEqual([]);
  });

  test("capability discovery returns actual supported video limits", async () => {
    const { createGenerationCapabilitiesRouter } = await import("../src/routes/generation-capabilities");
    const deps = dependencies();
    const url = await serve(createGenerationCapabilitiesRouter(deps.database as never), "/api/generation-capabilities");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ models: [{ id: modelId, modelId: "wan2.7", capability: { seconds: [2, 15], maxImages: 2, resolutions: ["720P", "1080P"] } }] });
    const query = deps.reads.find(({ sql }) => sql.includes("FROM model_configs"));
    expect(query?.sql).toContain("m.enabled=true");
    expect(query?.sql).toContain("p.enabled=true");
    expect(query?.sql).toContain("'video'=ANY(m.capabilities)");
  });
});
