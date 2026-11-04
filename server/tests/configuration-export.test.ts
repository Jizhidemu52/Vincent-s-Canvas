import { expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import express from "express";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";
import { createModelConfigurationRouter } from "../src/routes/model-configuration";
import type { AuthenticatedRequest, SessionUser } from "../src/types";

test("configuration export rejects unauthenticated and non-super-admin callers before database access", async () => {
    let databaseCalls = 0;
    const denied = async () => { databaseCalls++; throw new Error("Unauthorized callers must not read configuration"); };
    const app = express();
    app.use((request, _response, next) => {
        const role = request.get("test-role");
        if (role) (request as AuthenticatedRequest).auth = { id: "operator", role } as SessionUser;
        next();
    });
    app.use("/api/admin/model-configuration", createModelConfigurationRouter({ query: denied, connect: denied } as unknown as Database, {} as AppConfig));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/model-configuration/export`;
        expect((await fetch(url)).status).toBe(401);
        for (const role of ["designer", "department_admin"]) {
            const response = await fetch(url, { headers: { "test-role": role } });
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({ error: "FORBIDDEN" });
        }
        expect(databaseCalls).toBe(0);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
