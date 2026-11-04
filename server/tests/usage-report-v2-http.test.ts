import { expect, test } from "bun:test";
import express from "express";
import type { Database } from "../src/db";
import type { AppConfig } from "../src/config";
import { createAdminUsageRouter } from "../src/routes/usage-analytics";
import { usageV2ReportPeriodError } from "../../shared/usage-report-v2";

const uid = "10000000-0000-4000-8000-000000000001";
const request = {
    page: "overview",
    period: "selected",
    filters: {
        from: "2026-10-01T00:00:00+08:00",
        to: "2026-10-02T00:00:00+08:00",
        compare: "none",
        departmentBasis: "at_event",
    },
};
async function withServer(
    role: string,
    enabled: boolean,
    db: Database,
    run: (send: (body: unknown) => Promise<Response>) => Promise<void>,
) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (role !== "anonymous") Object.assign(req, { auth: { id: uid, role } });
        next();
    });
    app.use("/api/admin/usage", createAdminUsageRouter(db, {} as AppConfig, { enabled }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    try {
        await run((body) =>
            fetch(`http://127.0.0.1:${address.port}/api/admin/usage/report-v2`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test("free report HTTP denies all non-superadmin roles and trial before database access", async () => {
    let queries = 0;
    const db = {
        query: async () => {
            queries++;
            throw new Error("must not query");
        },
        connect: async () => {
            queries++;
            throw new Error("must not connect");
        },
    } as unknown as Database;
    for (const role of ["anonymous", "designer", "department_admin", "super_admin"]) {
        await withServer(role, role !== "super_admin", db, async (send) => {
            const response = await send(request);
            expect(response.status).toBe(role === "super_admin" ? 503 : 403);
            expect(response.headers.get("cache-control")).toBe("no-store");
        });
    }
    expect(queries).toBe(0);
});

test("free report HTTP only accepts explicit filters, never client metrics or unmatched calendar titles", async () => {
    let queries = 0;
    const db = {
        query: async () => {
            queries++;
            throw new Error("must not query");
        },
        connect: async () => {
            queries++;
            throw new Error("must not connect");
        },
    } as unknown as Database;
    await withServer("super_admin", true, db, async (send) => {
        for (const input of [
            { ...request, metrics: { generatedImages: 999999, prompt: "PRIVATE_SECRET" } },
            { ...request, data: { prompt: "PRIVATE_SECRET" } },
            { ...request, filters: { ...request.filters, metrics: "PRIVATE_SECRET" } },
            { ...request, filters: { ...request.filters, userIds: ["PRIVATE_SECRET"] } },
            { ...request, filters: {} },
            { ...request, page: "profile" },
        ]) {
            const response = await send(input);
            expect(response.status).toBe(400);
            expect(await response.text()).not.toContain("PRIVATE_SECRET");
        }
        for (const period of ["week", "month"]) {
            const response = await send({ ...request, period });
            expect(response.status).toBe(422);
            expect((await response.json()).code).toBe("USAGE_REPORT_PERIOD_MISMATCH");
        }
    });
    expect(queries).toBe(0);
});

test("free report query errors stay bounded and do not expose database details", async () => {
    const db = {
        connect: async () => {
            throw new Error("PRIVATE_SECRET postgresql credential");
        },
    } as unknown as Database;
    await withServer("super_admin", true, db, async (send) => {
        const response = await send(request);
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).not.toContain("PRIVATE_SECRET");
    });
});

test("calendar report eligibility is exact in Beijing, including leap month and year rollover", () => {
    expect(usageV2ReportPeriodError("week", "2026-10-04T16:00:00Z", "2026-10-11T16:00:00Z")).toBeNull();
    expect(usageV2ReportPeriodError("week", "2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z")).not.toBeNull();
    expect(usageV2ReportPeriodError("week", "2026-10-06T00:00:00+08:00", "2026-10-13T00:00:00+08:00")).not.toBeNull();
    expect(usageV2ReportPeriodError("month", "2024-02-01T00:00:00+08:00", "2024-03-01T00:00:00+08:00")).toBeNull();
    expect(usageV2ReportPeriodError("month", "2026-12-01T00:00:00+08:00", "2027-01-01T00:00:00+08:00")).toBeNull();
    expect(usageV2ReportPeriodError("month", "2026-10-01T00:00:00+08:00", "2026-10-31T00:00:00+08:00")).not.toBeNull();
    expect(usageV2ReportPeriodError("selected", "2026-10-01T00:00:00+08:00", "2026-10-03T00:00:00+08:00")).toBeNull();
});
