import { expect, test } from "bun:test";
import express from "express";
import type { Database } from "../src/db";
import type { AppConfig } from "../src/config";
import { createAdminUsageRouter } from "../src/routes/usage-analytics";

test("V2 paid preview rejects client content, prompts and unmatched calendar periods before any query or model", async () => {
    let databaseCalls = 0,
        modelCalls = 0;
    const blocked = async () => {
        databaseCalls++;
        throw new Error("must not read");
    };
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        Object.assign(request, { auth: { id: "10000000-0000-4000-8000-000000000001", role: "super_admin" } });
        next();
    });
    app.use(
        "/api/admin/usage",
        createAdminUsageRouter({ query: blocked, connect: blocked } as unknown as Database, {} as AppConfig, {
            complete: async () => {
                modelCalls++;
                throw new Error("no provider");
            },
        }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const request = {
        page: "overview",
        period: "selected",
        filters: { from: "2026-10-01T00:00:00+08:00", to: "2026-10-02T00:00:00+08:00", compare: "none" },
    };
    try {
        for (const body of [
            { ...request, content: "PRIVATE_SECRET" },
            { ...request, systemPrompt: "PRIVATE_SECRET" },
            { ...request, includePromptSamples: true },
            { ...request, filters: { ...request.filters, prompt: "PRIVATE_SECRET" } },
            { ...request, period: "week" },
            { ...request, period: "month" },
        ]) {
            const response = await fetch(`http://127.0.0.1:${port}/api/admin/usage/analysis-preview-v2`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            expect(response.status).toBe(body.period === "selected" ? 400 : 422);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(await response.text()).not.toContain("PRIVATE_SECRET");
        }
        expect(databaseCalls).toBe(0);
        expect(modelCalls).toBe(0);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
