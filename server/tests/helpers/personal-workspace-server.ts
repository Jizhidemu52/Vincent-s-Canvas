import express from "express";
import cookieParser from "cookie-parser";
import { Readable } from "node:stream";
import { createIsolatedPostgres } from "./isolated-postgres";
import { sessionMiddleware, requireAccountReady } from "../../src/session";
import { hashToken } from "../../src/security";
import { createAuthRouter } from "../../src/routes/auth";
import { createCanvasDocumentsRouter } from "../../src/routes/canvas-documents";
import { createProjectsRouter } from "../../src/routes/projects";
import { createAssetsRouter } from "../../src/routes/assets";
import { createTasksRouter } from "../../src/routes/tasks";
import { createPublicModelRouter } from "../../src/routes/model-configuration";
import { createModuleFlagsRouter } from "../../src/routes/module-flags";
import { createGenerationCapabilitiesRouter } from "../../src/routes/generation-capabilities";
import { createAccountsRouter } from "../../src/routes/accounts";
import { createDepartmentsRouter } from "../../src/routes/departments";
import { createAuditRouter } from "../../src/routes/audit-logs";
import { createAdminHistoryRouter, createHistoryRouter } from "../../src/routes/history";
import { deploymentFeatures } from "../../src/deployment-features";
import { requireSameOrigin } from "../../src/http-security";
import { preflightStoredVideoTask } from "../../src/stored-video-preflight";
import { designerModelPrivacy } from "../../src/model-privacy";
import type { AppConfig } from "../../src/config";
import type { Cache } from "../../src/db";
import type { ObjectStorage } from "../../src/object-storage";

export const workspaceFixtureUsers = {
    admin: "81000000-0000-4000-8000-000000000001",
    designer: "81000000-0000-4000-8000-000000000002",
    department: "81000000-0000-4000-8000-000000000003",
    localDesigner: "81000000-0000-4000-8000-000000000004",
};
export const workspaceVideoModel = "82000000-0000-4000-8000-000000000001";

/** Real session and production HTTP routers backed by disposable PostgreSQL.
 * No worker, real credentials, external storage, or model client is started. */
export async function createPersonalWorkspaceServer(port = 0) {
    const fixture = await createIsolatedPostgres();
    const { db } = fixture;
    const config = { OA_LOGIN_ENABLED: "true", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", ROLE_PORTALS_ENABLED: "false",
        SESSION_COOKIE_NAME: "workspace-fixture", SESSION_TTL_SECONDS: 28800, NODE_ENV: "test" } as unknown as AppConfig;
    const cache = { get: async () => null, set: async () => "OK", del: async () => 1, incr: async () => 1, expire: async () => 1,
        eval: async () => { throw new Error("Paid task queue must never be reached by this fixture"); } } as unknown as Cache;
    const departmentId = crypto.randomUUID();
    await db.query("INSERT INTO departments(id,name,code) VALUES($1,'Fixture department','WORKSPACE')", [departmentId]);
    for (const [name, id] of Object.entries(workspaceFixtureUsers)) {
        const role = name === "admin" ? "super_admin" : name === "department" ? "department_admin" : "designer";
        await db.query("INSERT INTO users(id,username,display_name,role,must_change_password,department_id) VALUES($1,$2,$3,$4,false,$5)", [id, `workspace-${name}`, `隔离 ${name}`, role, name === "admin" ? null : departmentId]);
        await db.query("INSERT INTO sessions(id,user_id,token_hash,auth_provider,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
            [crypto.randomUUID(), id, hashToken(`fixture-${name}`), name === "designer" ? "oa" : "local"]);
    }
    await db.query("UPDATE module_flags SET enabled=true");
    const provider = crypto.randomUUID();
    await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Offline only','apimart','https://no-network.invalid','fixture-not-a-credential')", [provider]);
    await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Offline Video','MiniMax-H3',ARRAY['video'])", [workspaceVideoModel, provider]);
    await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Offline Image','gpt-image-2',ARRAY['generate','edit','batch'])", [crypto.randomUUID(), provider]);
    const objects = new Map<string, { body: Uint8Array; mime: string }>();
    const storage = { configured: true, put: async (key: string, body: Uint8Array, mime: string) => { objects.set(key, { body, mime }); },
        head: async (key: string) => ({ ContentLength: objects.get(key)?.body.byteLength, ETag: '"fixture"' }),
        get: async (key: string) => { const object = objects.get(key); if (!object) throw new Error("Fixture object not found"); return {
            Body: Readable.from([object.body]), ContentLength: object.body.byteLength, ContentType: object.mime, ETag: '"fixture"',
        }; }, delete: async (key: string) => { objects.delete(key); }, } as unknown as ObjectStorage;
    const app = express().use(express.json({ limit: "20mb" })).use(cookieParser()).use(requireSameOrigin);
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.get("/api/deployment", (_req, res) => res.json(deploymentFeatures(config)));
    app.use("/api/auth", createAuthRouter(db, cache, config));
    const workspace = sessionMiddleware(db, cache, config, { allowPersonalWorkspace: true });
    const admin = sessionMiddleware(db, cache, config, { allowGuest: false });
    const privacy = designerModelPrivacy(db);
    app.use("/api/canvas-documents", workspace, requireAccountReady, privacy, createCanvasDocumentsRouter(db));
    app.use("/api/projects", workspace, requireAccountReady, privacy, createProjectsRouter(db));
    app.use("/api/assets", workspace, requireAccountReady, privacy, createAssetsRouter(db, storage));
    app.use("/api/models", workspace, requireAccountReady, createPublicModelRouter(db, false));
    app.use("/api/modules", workspace, requireAccountReady, createModuleFlagsRouter(db));
    app.use("/api/generation-capabilities", workspace, requireAccountReady, createGenerationCapabilitiesRouter(db));
    app.use("/api/history", workspace, requireAccountReady, privacy, createHistoryRouter(db));
    // Text-only video preflight uses the real validator, so it never needs media storage or a provider.
    app.use("/api/tasks", workspace, requireAccountReady, privacy, createTasksRouter(db, cache, false, preflightStoredVideoTask));
    app.use("/api/admin/accounts", admin, requireAccountReady, createAccountsRouter(db, config));
    app.use("/api/admin/departments", admin, requireAccountReady, createDepartmentsRouter(db));
    app.use("/api/admin/audit-logs", admin, requireAccountReady, createAuditRouter(db));
    app.use("/api/admin/history", admin, requireAccountReady, createAdminHistoryRouter(db));
    app.use((error: Error & { code?: string; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
        res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.code || error.name, message: error.message }));
    const server = app.listen(port, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { ...fixture, origin, objects, close: async () => {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close();
    } };
}

if (import.meta.main) {
    const fixture = await createPersonalWorkspaceServer(Number(process.env.WORKSPACE_FIXTURE_PORT || 5353));
    console.log(`Personal workspace fixture ready: ${fixture.origin}`);
    process.on("SIGTERM", async () => { await fixture.close(); process.exit(0); });
    process.on("SIGINT", async () => { await fixture.close(); process.exit(0); });
}
