import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { Database } from "../../src/db";
import { createModelConfigurationRouter } from "../../src/routes/model-configuration";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;

// Formal HTTP handlers + disposable PostgreSQL/WASM data and real failing triggers.
// This single-connection fixture proves atomicity, not multi-connection contention.
integration("price-version HTTP writes in isolated PostgreSQL", () => {
    let database: any;
    let db: Database;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let origin: string;
    beforeAll(async () => {
        const requireRuntime = createRequire(resolve(process.env.PGLITE_RUNTIME_PATH!, "package.json"));
        const { PGlite } = requireRuntime("@electric-sql/pglite");
        const { pgcrypto } = requireRuntime("@electric-sql/pglite/contrib/pgcrypto");
        const { citext } = requireRuntime("@electric-sql/pglite/contrib/citext");
        database = new PGlite({ extensions: { pgcrypto, citext } });
        await database.waitReady;
        const migrations = fileURLToPath(new URL("../../src/migrations/", import.meta.url));
        for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await database.exec(await readFile(resolve(migrations, name), "utf8"));
        const query = async (sql: string, values: unknown[] = []) => {
            const result = await database.query(sql, values);
            return { ...result, rowCount: result.affectedRows ?? result.rows.length };
        };
        db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
        const adminId = randomUUID();
        await query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'price-qa-admin','Price QA Admin','super_admin',false)", [adminId]);
        const app = express().use(express.json());
        app.use((request, _response, next) => { Object.assign(request, { auth: { id: adminId, role: request.get("X-Fixture-Role") ?? "super_admin" } }); next(); });
        app.use("/prices-api", createModelConfigurationRouter(db, {} as AppConfig));
        app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.code ?? error.name, message: error.message })) as ErrorRequestHandler);
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>(done => server.once("listening", done));
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/prices-api`;
    }, 30000);
    afterAll(async () => {
        if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
        await database?.close();
    });
    const post = (path: string, body: unknown = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const input = (operationType = "image_generation") => ({ operationType, label: `Price fixture ${randomUUID()}`, credits: 7, rmbCost: 0.125 });
    async function draft(operationType = "image_generation") {
        const response = await post("/prices", input(operationType));
        expect(response.status).toBe(201); return (await response.json()).price as { id: string; version: number };
    }
    const state = async (operation: string) => (await db.query("SELECT id,status,published_at FROM pricing_rule_versions WHERE operation_type=$1 ORDER BY id", [operation])).rows;
    async function failAudit(action: string, run: () => Promise<void>) {
        await database.exec(`CREATE FUNCTION reject_price_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'Fixture price audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_price_fixture_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_price_fixture_audit();`);
        try { await run(); }
        finally { await database.exec("DROP TRIGGER reject_price_fixture_audit ON audit_logs; DROP FUNCTION reject_price_fixture_audit();"); }
    }

    test("a failed draft audit leaves neither a draft nor a consumed version", async () => {
        const body = input("upscale");
        const before = await state(body.operationType);
        const nextVersion = (await db.query("SELECT MAX(version)+1 AS next FROM pricing_rule_versions WHERE operation_type=$1", [body.operationType])).rows[0].next;
        await failAudit("price.draft_created", async () => {
            expect((await post("/prices", body)).status).toBe(500);
            expect(await state(body.operationType)).toEqual(before);
            expect((await db.query("SELECT id FROM audit_logs WHERE action='price.draft_created' AND detail->>'label'=$1", [body.label])).rows).toEqual([]);
        });
        const recovered = await post("/prices", body);
        expect(recovered.status).toBe(201); expect((await recovered.json()).price.version).toBe(nextVersion);
    });

    test("a failed testing audit leaves the price in draft and retry succeeds once", async () => {
        const created = await draft("remove_background"); const before = await state("remove_background");
        await failAudit("price.testing", async () => {
            expect((await post(`/prices/${created.id}/test`)).status).toBe(500);
            expect(await state("remove_background")).toEqual(before);
        });
        expect((await post(`/prices/${created.id}/test`)).status).toBe(204);
        expect((await post(`/prices/${created.id}/test`)).status).toBe(409);
        expect((await db.query("SELECT id FROM audit_logs WHERE action='price.testing' AND target_id=$1", [created.id])).rows).toHaveLength(1);
    });

    test("a failed publish audit preserves both the existing published price and the new draft", async () => {
        const created = await draft("video_generation");
        expect((await post(`/prices/${created.id}/test`)).status).toBe(204);
        const before = await state("video_generation");
        await failAudit("price.published", async () => {
            expect((await post(`/prices/${created.id}/publish`)).status).toBe(500);
            expect(await state("video_generation")).toEqual(before);
        });
        expect((await post(`/prices/${created.id}/publish`)).status).toBe(204);
        const published = await db.query("SELECT id FROM pricing_rule_versions WHERE operation_type='video_generation' AND status='published'");
        expect(published.rows).toEqual([{ id: created.id }]);
        expect((await db.query("SELECT id FROM audit_logs WHERE action='price.published' AND target_id=$1", [created.id])).rows).toHaveLength(1);
        expect((await post(`/prices/${created.id}/publish`)).status).toBe(409);
    });

    test("draft publication, version ordering and invalid transitions retain their existing contract", async () => {
        const first = await draft("batch_image"); const second = await draft("batch_image");
        expect(second.version).toBe(first.version + 1);
        expect((await post(`/prices/${first.id}/publish`)).status).toBe(204);
        expect((await post(`/prices/${second.id}/publish`)).status).toBe(204);
        expect((await db.query("SELECT id FROM pricing_rule_versions WHERE operation_type='batch_image' AND status='published'")).rows).toEqual([{ id: second.id }]);
        expect((await db.query("SELECT status FROM pricing_rule_versions WHERE id=$1", [first.id])).rows[0].status).toBe("retired");
        expect((await post(`/prices/${first.id}/publish`)).status).toBe(409);
        expect((await post(`/prices/${randomUUID()}/test`)).status).toBe(409);
        expect((await post(`/prices/${randomUUID()}/publish`)).status).toBe(409);
    });

    test("non-super-admin roles cannot create, test or publish prices", async () => {
        const created = await draft("inpaint"); const before = await state("inpaint");
        for (const role of ["department_admin", "designer"]) {
            for (const [path, body] of [["/prices", input("inpaint")], [`/prices/${created.id}/test`, {}], [`/prices/${created.id}/publish`, {}]] as const) {
                const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "X-Fixture-Role": role }, body: JSON.stringify(body) });
                expect(response.status).toBe(403);
            }
        }
        expect(await state("inpaint")).toEqual(before);
    });
});
