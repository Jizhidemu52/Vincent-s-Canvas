import { expect, test } from "bun:test";
import express from "express";
import type { Database } from "../src/db";
import { createBillingRouter } from "../src/routes/billing";
import { createDepartmentsRouter } from "../src/routes/departments";

async function withRoutes(run: (request: (path: string, role: string, method?: string) => Promise<Response>, queries: Array<{ sql: string; values?: unknown[] }>) => Promise<void>) {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const db = { query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
    } } as unknown as Database;
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        Object.assign(request, { auth: { id: "employee-fixture", role: request.header("x-test-role"), departmentId: "department-fixture" } });
        next();
    });
    app.use("/billing", createBillingRouter(db));
    app.use("/departments", createDepartmentsRouter(db));
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise<void>(resolve => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test port");
        await run((path, role, method = "GET") => fetch(`http://127.0.0.1:${address.port}${path}`, {
            method, headers: { "x-test-role": role, "content-type": "application/json" },
            ...(method === "POST" ? { body: JSON.stringify({ requestId: "orphan-fixture", operationType: "chat", quantity: 1 }) } : {}),
        }), queries);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

test("no employee or administrator can create an unowned public credit hold", async () => {
    await withRoutes(async (request, queries) => {
        for (const role of ["designer", "department_admin", "super_admin"]) {
            expect((await request("/billing/reservations", role, "POST")).status).toBe(404);
        }
        expect(queries).toEqual([]);
    });
});

test("the remaining ledger endpoint is still scoped to the authenticated employee", async () => {
    await withRoutes(async (request, queries) => {
        const response = await request("/billing/ledger", "designer");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ entries: [] });
        expect(queries).toHaveLength(1);
        expect(queries[0]!.values).toEqual(["employee-fixture"]);
        expect(queries[0]!.sql).toContain("WHERE user_id=$1");
    });
});

test("department list rejects employee sessions before touching department data", async () => {
    await withRoutes(async (request, queries) => {
        const response = await request("/departments", "designer");
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "FORBIDDEN", message: "权限不足" });
        expect(queries).toEqual([]);
        for (const role of ["department_admin", "super_admin"]) {
            expect((await request("/departments", role)).status).toBe(200);
        }
        expect(queries).toHaveLength(2);
    });
});
