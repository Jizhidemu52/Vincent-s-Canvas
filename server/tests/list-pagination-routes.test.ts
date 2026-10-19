import { expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { Cache, Database } from "../src/db";
import { createHistoryRouter, createAdminHistoryRouter } from "../src/routes/history";
import { createTasksRouter, createAdminTasksRouter } from "../src/routes/tasks";
import { encodeCursor, parseCursorPage } from "../src/cursor-pagination";

const actorId = "10000000-0000-4000-8000-000000000001";
const departmentId = "20000000-0000-4000-8000-000000000001";
const ids = Array.from({ length: 3 }, (_, i) => `30000000-0000-4000-8000-00000000000${i + 1}`);
const time = "2026-10-19T01:02:03.123456Z";

async function fixture(role: "designer" | "super_admin" | "department_admin", run: (origin: string, calls: Array<{ sql: string; values: unknown[] }>) => Promise<void>, detailExists = true) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("count(*)::int AS total")) return { rows: [{ total: 3, totalCredits: 3, totalRmbCost: 0.3 }] };
    if (/WHERE [ht]\.id=\$1/.test(sql)) return { rows: detailExists ? [{ id: ids[0], prompt: "full prompt", parameters: { input: "original" }, sourceUrls: ["source"], resultUrls: ["result"] }] : [] };
    const rows = ids.map(id => ({ id, createdAt: time, cursorCreatedAt: time, prompt: "summary" }));
    return { rows: sql.includes("t.id=ANY") ? rows.slice(0, 2) : rows };
  } } as unknown as Database;
  const app = express();
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: actorId, role, departmentId } }); next(); });
  app.use("/api/tasks", createTasksRouter(db, {} as Cache));
  app.use("/api/history", createHistoryRouter(db));
  app.use("/api/admin/tasks", createAdminTasksRouter(db, {} as Cache));
  app.use("/api/admin/history", createAdminHistoryRouter(db));
  app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.name })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test.each(["tasks", "tasks/batches", "history"])("personal %s uses stable keyset and owner scope before cursor", async endpoint => {
  await fixture("designer", async (origin, calls) => {
    const query = new URLSearchParams({ limit: "2", cursor: encodeCursor({ createdAt: time, id: ids[2] }) });
    const response = await fetch(`${origin}/api/${endpoint}?${query}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const key = endpoint === "tasks/batches" ? "batches" : endpoint;
    expect(body[key]).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body[key][0]).not.toHaveProperty("cursorCreatedAt");
    expect(parseCursorPage({ cursor: body.nextCursor }).cursor).toEqual({ createdAt: time, id: ids[1] });
    const call = calls.at(-1)!;
    expect(call.values).toEqual([actorId, time, ids[2], 3]);
    expect(call.sql).toContain(".user_id=$1");
    expect(call.sql).toContain("::timestamptz,$3::uuid)");
    expect(call.sql).toContain("DESC,");
    expect(call.sql).not.toContain("OFFSET");
    expect(call.sql).not.toContain("h.parameters");
    expect(call.sql).not.toContain("t.parameters");
  });
});

test.each(["tasks", "tasks/batches", "history"])("admin %s retains department authorization when paging", async endpoint => {
  await fixture("department_admin", async (origin, calls) => {
    const response = await fetch(`${origin}/api/admin/${endpoint}?limit=2`);
    expect(response.status).toBe(200);
    expect((await response.json()).hasMore).toBe(true);
    const call = calls.at(-1)!;
    expect(call.values).toEqual([departmentId, 3]);
    expect(call.sql).toContain(".department_id=$1");
  });
  await fixture("designer", async origin => expect((await fetch(`${origin}/api/admin/${endpoint}`)).status).toBe(403));
});

test("exact task IDs bypass page caps but retain owner scope and full task details", async () => {
  await fixture("designer", async (origin, calls) => {
    const response = await fetch(`${origin}/api/tasks?${new URLSearchParams({ ids: ids.slice(0, 2).join(","), limit: "1" })}`);
    expect((await response.json()).tasks).toHaveLength(2);
    expect(calls.at(-1)!.values).toEqual([actorId, ids.slice(0, 2), 3]);
    expect(calls.at(-1)!.sql).toContain("t.id=ANY($2::uuid[])");
    expect(calls.at(-1)!.sql).toContain("t.parameters");
  });
});

test.each(["tasks", "history"])("%s detail is complete and denied outside owner/department scope", async endpoint => {
  for (const [role, prefix, owner] of [["designer", "", actorId], ["department_admin", "admin/", departmentId]] as const) {
    await fixture(role, async (origin, calls) => {
      const response = await fetch(`${origin}/api/${prefix}${endpoint}/${ids[0]}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body[endpoint === "tasks" ? "task" : "history"].parameters).toEqual({ input: "original" });
      expect(calls.at(-1)!.values).toEqual([ids[0], owner]);
      expect(calls.at(-1)!.sql).toContain(role === "designer" ? ".user_id=$2" : ".department_id=$2");
    });
    await fixture(role, async origin => expect((await fetch(`${origin}/api/${prefix}${endpoint}/${ids[0]}`)).status).toBe(404), false);
  }
});

test.each(["tasks", "tasks/batches", "history", "admin/tasks", "admin/tasks/batches", "admin/history"])("%s rejects malformed or oversized page inputs", async endpoint => {
  await fixture("super_admin", async origin => {
    for (const query of ["limit=201", "limit=0", "cursor=malformed"]) expect((await fetch(`${origin}/api/${endpoint}?${query}`)).status).toBe(400);
  });
});
