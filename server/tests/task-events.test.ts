import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import express, { type ErrorRequestHandler } from "express";
import type { PoolClient } from "pg";
import type { Database } from "../src/db";
import type { AuthenticatedRequest } from "../src/types";
import { createTasksEventsRouter, TaskEventsService, TASK_EVENTS_CHANNEL, TASK_EVENTS_HEARTBEAT_MS, TASK_EVENTS_MAX_CONNECTION_MS } from "../src/task-events";

const ownerA = "71000000-0000-4000-8000-000000000001", ownerB = "71000000-0000-4000-8000-000000000002";
const taskA = "72000000-0000-4000-8000-000000000001", taskB = "72000000-0000-4000-8000-000000000002";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Task event fixture timed out"); await Bun.sleep(5); }
}

function clientFixture(failListen = false) {
  const emitter = new EventEmitter();
  const queries: string[] = [], releases: Array<boolean | undefined> = [];
  const client = Object.assign(emitter, {
    query: async (sql: string) => { queries.push(sql); if (failListen) throw new Error("Synthetic LISTEN failure"); return { rows: [] }; },
    release: (destroy?: boolean) => { releases.push(destroy); },
  }) as unknown as PoolClient;
  const notify = (id: string, userId = ownerA, extra: Record<string, unknown> = {}) => emitter.emit("notification", {
    channel: TASK_EVENTS_CHANNEL, payload: JSON.stringify({ id, userId, ...extra }), processId: 1,
  });
  return { client, emitter, queries, releases, notify };
}

describe("shared PostgreSQL task invalidation listener", () => {
  test("many subscriptions share one LISTEN connection, intersect owner and task IDs, and release it on close", async () => {
    const fixture = clientFixture();
    let checkouts = 0;
    const service = new TaskEventsService({ connect: async () => { checkouts++; return fixture.client; } } as unknown as Database);
    const a: string[][] = [], b: string[][] = [];
    let closed = 0;
    const unsubscribe = service.subscribe(ownerA, [taskA], ids => a.push(ids), () => { closed++; });
    service.subscribe(ownerB, [taskA, taskB], ids => b.push(ids), () => { closed++; });
    await Promise.all([service.start(), service.start(), service.start()]);
    expect(checkouts).toBe(1); expect(fixture.queries).toEqual([`LISTEN ${TASK_EVENTS_CHANNEL}`]);
    expect(a).toEqual([[taskA]]); expect(b).toEqual([[taskA, taskB]]);
    a.length = 0; b.length = 0;
    fixture.notify(taskB); fixture.notify(taskA); fixture.notify(taskB, ownerB);
    expect(a).toEqual([[taskA]]); expect(b).toEqual([[taskB]]);
    for (const payload of ["bad-json", JSON.stringify({ id: "not-uuid", userId: ownerA }), "x".repeat(1_025)])
      fixture.emitter.emit("notification", { channel: TASK_EVENTS_CHANNEL, payload });
    fixture.emitter.emit("notification", { channel: "other_channel", payload: JSON.stringify({ id: taskA, userId: ownerA }) });
    expect(a).toEqual([[taskA]]); expect(b).toEqual([[taskB]]);
    unsubscribe(); unsubscribe(); fixture.notify(taskA);
    expect(a).toEqual([[taskA]]);
    await service.close(); await service.close();
    expect(closed).toBe(1); expect(fixture.releases).toEqual([true]);
    for (const name of ["notification", "end", "error"]) expect(fixture.emitter.listenerCount(name)).toBe(0);
    await service.start(); expect(checkouts).toBe(1);
  });

  test("stale unsubscribe cannot erase a new subscription for the same account", async () => {
    const fixture = clientFixture();
    const service = new TaskEventsService({ connect: async () => fixture.client } as unknown as Database);
    const old = service.subscribe(ownerA, [taskA], () => {}, () => {});
    old();
    const changed: string[][] = [];
    service.subscribe(ownerA, [taskB], ids => changed.push(ids), () => {});
    old();
    await service.start(); changed.length = 0;
    fixture.notify(taskB); expect(changed).toEqual([[taskB]]);
    await service.close();
  });

  test("connection and LISTEN failures back off, then reconnect invalidates all subscribers without duplicate listeners", async () => {
    const rejected = clientFixture(true), first = clientFixture(), second = clientFixture();
    const attempts: number[] = [];
    const clients = [undefined, rejected, first, second];
    const service = new TaskEventsService({ connect: async () => {
      const attempt = attempts.length; attempts.push(Date.now());
      const fixture = clients[attempt];
      if (!fixture) throw new Error("Synthetic checkout failure");
      return fixture.client;
    } } as unknown as Database, { retryBaseMs: 15, retryMaxMs: 30 });
    const changed: string[][] = [];
    service.subscribe(ownerA, [taskA, taskB], ids => changed.push(ids), () => {});
    try {
      await service.start();
      await until(() => changed.length === 1);
      expect(attempts).toHaveLength(3);
      expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(10);
      expect(attempts[2]! - attempts[1]!).toBeGreaterThanOrEqual(25);
      expect(rejected.releases).toEqual([true]);
      expect(changed).toEqual([[taskA, taskB]]);
      first.emitter.emit("error", new Error("Synthetic connection loss"));
      first.emitter.emit("end");
      await until(() => changed.length === 2);
      expect(first.releases).toEqual([true]); expect(second.queries).toEqual([`LISTEN ${TASK_EVENTS_CHANNEL}`]);
      expect(changed).toEqual([[taskA, taskB], [taskA, taskB]]);
      first.notify(taskA); expect(changed).toHaveLength(2);
      second.notify(taskB); expect(changed.at(-1)).toEqual([taskB]);
    } finally { await service.close(); }
    expect(second.releases).toEqual([true]);
    const count = attempts.length; await Bun.sleep(40); expect(attempts).toHaveLength(count);
  });

  test("shutdown clears retry timers and releases a checkout that completes after shutdown", async () => {
    let attempts = 0;
    const retrying = new TaskEventsService({ connect: async () => { attempts++; throw new Error("Synthetic offline database"); } } as unknown as Database, { retryBaseMs: 20 });
    await retrying.start(); await retrying.close(); await Bun.sleep(35); expect(attempts).toBe(1);
    const fixture = clientFixture();
    let complete!: (client: PoolClient) => void;
    const pending = new TaskEventsService({ connect: () => new Promise<PoolClient>(done => { complete = done; }) } as unknown as Database);
    const starting = pending.start(); await pending.close(); complete(fixture.client); await starting;
    expect(fixture.releases).toEqual([true]); expect(fixture.queries).toEqual([]);
    expect(fixture.emitter.eventNames()).toEqual([]);
  });

  test("a failed browser callback is removed without breaking other subscribers", async () => {
    const fixture = clientFixture();
    const service = new TaskEventsService({ connect: async () => fixture.client } as unknown as Database);
    await service.start();
    let broken = 0, closed = 0;
    const good: string[][] = [];
    service.subscribe(ownerA, [taskA], () => { broken++; throw new Error("Synthetic closed response"); }, () => { closed++; });
    service.subscribe(ownerA, [taskA], ids => good.push(ids), () => {});
    fixture.notify(taskA); fixture.notify(taskA);
    expect(broken).toBe(1); expect(closed).toBe(1); expect(good).toEqual([[taskA], [taskA]]);
    await service.close();
  });
});

async function serve(events: Pick<TaskEventsService, "subscribe">, options: { heartbeatMs?: number; maxConnectionMs?: number } = {}) {
  const app = express();
  app.use((request, _response, next) => {
    if (request.header("x-test-owner") !== "none") (request as AuthenticatedRequest).auth = { id: request.header("x-test-owner") || ownerA } as AuthenticatedRequest["auth"];
    next();
  });
  app.use("/api/tasks/events", createTasksEventsRouter(events, options));
  app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: "VALIDATION_ERROR" })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks/events`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  } };
}

describe("task invalidation SSE HTTP contract", () => {
  test("validates the session owner and 1..100 UUIDs before subscribing", async () => {
    let subscriptions = 0;
    const fixture = await serve({ subscribe: () => { subscriptions++; return () => {}; } }, { maxConnectionMs: 20 });
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    try {
      const request = (query: string, owner?: string) => fetch(`${fixture.url}?${query}`, { headers: owner ? { "x-test-owner": owner } : {} });
      expect((await request(`ids=${taskA}&ownerId=${ownerA}`, "none")).status).toBe(401);
      expect((await request(`ids=${taskA}&ownerId=${ownerB}`)).status).toBe(403);
      for (const query of ["", `ownerId=${ownerA}`, `ids=&ownerId=${ownerA}`, `ids=not-uuid&ownerId=${ownerA}`,
        `ids=${taskA}&ids=${taskB}&ownerId=${ownerA}`, `ids=${taskA}&ownerId=bad`, `ids=${[...ids, crypto.randomUUID()].join(",")}&ownerId=${ownerA}`])
        expect((await request(query)).status).toBe(400);
      expect(subscriptions).toBe(0);
      const accepted = await request(`ids=${ids.join(",")}&ownerId=${ownerA}`);
      expect(accepted.status).toBe(200); expect(await accepted.text()).toContain(JSON.stringify({ ids }));
      expect(subscriptions).toBe(1);
    } finally { await fixture.close(); }
  });

  test("initial IDs and matching invalidations contain no task fields, with comment heartbeats and bounded lifetime", async () => {
    const client = clientFixture();
    const service = new TaskEventsService({ connect: async () => client.client } as unknown as Database);
    await service.start();
    const fixture = await serve(service, { heartbeatMs: 20, maxConnectionMs: 85 });
    try {
      expect(TASK_EVENTS_HEARTBEAT_MS).toBe(15_000); expect(TASK_EVENTS_MAX_CONNECTION_MS).toBe(300_000);
      const response = await fetch(`${fixture.url}?ids=${taskA},${taskB},${taskA}&ownerId=${ownerA}`);
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("x-accel-buffering")).toBe("no");
      client.notify(taskA, ownerB, { failureReason: "private-provider-credential" });
      client.notify(crypto.randomUUID(), ownerA);
      client.notify(taskB, ownerA, { resultUrls: ["private-provider-result"], modelId: "private-model" });
      const wire = await response.text();
      const changes = wire.split("\n\n").filter(frame => frame.startsWith("event: tasks-changed\n"));
      expect(changes.map(frame => JSON.parse(frame.split("\ndata: ")[1]!))).toEqual([{ ids: [taskA, taskB] }, { ids: [taskB] }]);
      expect(wire).toContain(": heartbeat\n\n"); expect(wire).not.toContain("private-"); expect(wire).not.toContain("userId");
    } finally { await service.close(); await fixture.close(); }
  });

  test("browser abort, lifetime expiry and service shutdown unsubscribe the stream", async () => {
    const active = new Set<() => void>();
    let removed = 0;
    const source = { subscribe: (_owner: string, _ids: readonly string[], _changed: (ids: string[]) => void, close: () => void) => {
      active.add(close); return () => { if (active.delete(close)) removed++; };
    } };
    const fixture = await serve(source, { heartbeatMs: 15, maxConnectionMs: 80 });
    const path = `${fixture.url}?ids=${taskA}&ownerId=${ownerA}`;
    try {
      const abort = new AbortController();
      const response = await fetch(path, { signal: abort.signal });
      const reading = response.text().catch(() => "aborted");
      expect(active.size).toBe(1); abort.abort(); await reading; await until(() => active.size === 0);
      expect(removed).toBe(1);
      await (await fetch(path)).text(); expect(active.size).toBe(0); expect(removed).toBe(2);
      const closing = await fetch(path); expect(active.size).toBe(1);
      for (const close of [...active]) close();
      expect(await closing.text()).toContain("tasks-changed"); expect(active.size).toBe(0); expect(removed).toBe(3);
      await Bun.sleep(25); expect(removed).toBe(3);
    } finally { await fixture.close(); }
  });
});
