import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { createPerformanceRouter } from "../../src/routes/performance";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const from = "2026-11-01T00:00:00.000Z";
const to = "2026-11-09T00:00:00.000Z";
const dates = ["2026-11-02T08:00:00.000Z", "2026-11-03T08:00:00.000Z"];

for (const kind of ["tasks", "assets"] as const) {
  sqlTest(`performance GET sorts multiple ${kind} returned as real PostgreSQL Dates without writes`, async () => {
    const fixture = await createIsolatedPostgres();
    const actor = randomUUID();
    const ids = [randomUUID(), randomUUID()];
    let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
    try {
      await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Performance dates','super_admin')", [actor, `dates-${actor}`]);
      for (const [index, id] of ids.entries()) {
        if (kind === "tasks") {
          await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,credits,rmb_cost,queued_at,started_at,completed_at)
            VALUES($1,$2,$3,'performance-date-fixture','image_generation','success',2,0.25,$4,$4,$4::timestamptz+interval '1 minute')`,
          [id, `dates-${id}`, actor, dates[index]]);
        } else {
          await fixture.db.query(`INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,kind,source,status,created_at)
            VALUES($1,$2,$3,'fixture.png','image/png','image','generation','ready',$4)`, [id, actor, `dates/${id}`, dates[index]]);
        }
      }
      const column = kind === "tasks" ? "queued_at" : "created_at";
      const nativeRows = await fixture.db.query(`SELECT ${column} AS value FROM ${kind} ORDER BY ${column}`);
      expect(nativeRows.rows).toHaveLength(2);
      expect(nativeRows.rows.every(row => row.value instanceof Date)).toBe(true);
      const before = (await fixture.db.query("SELECT processing_enabled FROM usage_rollup_state")).rows;
      expect(before).toEqual([{ processing_enabled: false }]);

      const app = express();
      app.use((request, _response, next) => { Object.assign(request, { auth: { id: actor, role: "super_admin", departmentId: null } }); next(); });
      app.use("/api/performance", createPerformanceRouter(fixture.db));
      const errors: ErrorRequestHandler = (error, _request, response, _next) => { response.status(500).json({ error: error.message }); };
      app.use(errors);
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>(done => server!.once("listening", done));
      fixture.statements.length = 0;
      const query = new URLSearchParams({ preset: "custom", from, to });
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/performance?${query}`);
      const body = await response.json();
      expect({ status: response.status, error: body.error }).toEqual({ status: 200, error: undefined });
      expect(body[kind].map((row: { id: string }) => row.id)).toEqual(ids.slice().reverse());
      const dateKey = kind === "tasks" ? "queuedAt" : "createdAt";
      expect(body[kind].map((row: Record<string, string>) => row[dateKey])).toEqual(dates.slice().reverse());
      expect(body.metrics.successCount).toBe(kind === "tasks" ? 2 : 0);
      expect(body.metrics.validOutputs).toBe(kind === "assets" ? 2 : 0);
      expect(body.metrics.totalCredits).toBe(kind === "tasks" ? 4 : 0);
      expect(body.metrics.totalRmbCost).toBe(kind === "tasks" ? 0.5 : 0);
      expect(fixture.statements.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
      expect((await fixture.db.query("SELECT processing_enabled FROM usage_rollup_state")).rows).toEqual(before);
    } finally {
      if (server) await new Promise<void>(done => { server!.close(() => done()); server!.closeAllConnections(); });
      await fixture.close();
    }
  }, 60_000);
}
