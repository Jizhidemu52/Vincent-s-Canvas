/** Local-only acceptance harness, NOT a deployment server.
 * From server/: bun scripts/admin-credits-qa.ts --serve
 * Optional --resume <run-directory> reopens only this harness's own database.
 * Uses real authentication/admin routes and PostgreSQL SQL; Redis is a local
 * cache double. No worker, asset uploads or external provider calls are allowed.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { loadConfig } from "../src/config";
import type { Cache, Database } from "../src/db";
import { getCreditsEnabled } from "../src/credit-policy";
import { deploymentFeatures } from "../src/deployment-features";
import { requireSameOrigin } from "../src/http-security";
import { hashPassword } from "../src/security";
import { requireAccountReady, sessionMiddleware } from "../src/session";
import { createAuthRouter } from "../src/routes/auth";
import { createAccountsRouter } from "../src/routes/accounts";
import { createCreditPolicyRouter } from "../src/routes/credit-policy";
import { createDepartmentsRouter } from "../src/routes/departments";
import { createAuditRouter } from "../src/routes/audit-logs";
import { createAdminHistoryRouter } from "../src/routes/history";
import { createGroupsRouter } from "../src/routes/groups";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";
import { createModuleFlagsRouter, createAdminModuleFlagsRouter } from "../src/routes/module-flags";
import { createCanvasDocumentsRouter } from "../src/routes/canvas-documents";
import { createBillingRouter } from "../src/routes/billing";
import { createWorkflowsRouter } from "../src/routes/workflows";

if (!process.argv.includes("--serve")) throw new Error("Explicit --serve is required for local QA");
const root = [process.cwd(), resolve(process.cwd(), ".."), resolve(dirname(fileURLToPath(import.meta.url)), "../..")]
    .find(path => existsSync(join(path, "server/src/migrations")));
if (!root) throw new Error("Run from the repository or server directory");
const output = join(root, "output/admin-credits-qa");
await mkdir(output, { recursive: true });
const resumeIndex = process.argv.indexOf("--resume");
const resume = resumeIndex < 0 ? null : resolve(process.argv[resumeIndex + 1] ?? "");
if (resume && (!resume.startsWith(output + sep + "run-") || !existsSync(join(resume, "fixture.json")))) {
    throw new Error("Only a previously created admin-credits QA run may be reopened");
}
const runDirectory = resume ?? await mkdtemp(join(output, "run-"));
const fixture = resume ? JSON.parse(await readFile(join(resume, "fixture.json"), "utf8")) : {
    username: "local-qa-admin", password: `Qa${randomBytes(18).toString("base64url")}8!`,
    designerUsername: "local-qa-designer", designerPassword: `Qa${randomBytes(18).toString("base64url")}9!`,
    secondUsername: "local-qa-designer-2", secondPassword: `Qa${randomBytes(18).toString("base64url")}7!`,
};
if (!resume) await writeFile(join(runDirectory, "fixture.json"), JSON.stringify(fixture, null, 2));
const runtime = createRequire(join(root, "output/mark-admin-qa/runtime/package.json"));
const { PGlite } = runtime("@electric-sql/pglite");
const { pgcrypto } = runtime("@electric-sql/pglite/contrib/pgcrypto");
const { citext } = runtime("@electric-sql/pglite/contrib/citext");
const database = new PGlite(join(runDirectory, "pgdata"), { extensions: { pgcrypto, citext } });
await database.waitReady;
if (!resume) {
    for (const name of (await readdir(join(root, "server/src/migrations"))).filter(name => name.endsWith(".sql")).sort()) {
        await database.exec(await readFile(join(root, "server/src/migrations", name), "utf8"));
    }
    for (const [id, username, displayName, password, role] of [
        ["82000000-0000-4000-8000-000000000001", fixture.username, "本地测试管理员", fixture.password, "super_admin"],
        ["82000000-0000-4000-8000-000000000002", fixture.designerUsername, "测试设计师一", fixture.designerPassword, "designer"],
        ["82000000-0000-4000-8000-000000000003", fixture.secondUsername, "测试设计师二", fixture.secondPassword, "designer"],
    ]) await database.query("INSERT INTO users(id,username,display_name,password_hash,role,must_change_password,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,$3,$4,$5,false,100,100,100)", [id, username, displayName, await hashPassword(password), role]);
    await database.query("INSERT INTO providers(id,name,protocol,base_url,enabled) VALUES('82000000-0000-4000-8000-000000000004','本地验证模型（不连接外部）','openai','http://127.0.0.1:1',true)");
    await database.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,enabled) VALUES('82000000-0000-4000-8000-000000000005','82000000-0000-4000-8000-000000000004','测试图片模型','qa-image',ARRAY['generate','edit','batch','upscale'],2,0,true),('82000000-0000-4000-8000-000000000006','82000000-0000-4000-8000-000000000004','测试对话模型','qa-chat',ARRAY['chat'],1,0,true)");
}
// Serialize the single PGlite connection across entire formal transactions.
let queue = Promise.resolve();
async function acquire() { const previous = queue; let release!: () => void; queue = new Promise<void>(done => { release = done; }); await previous; return release; }
const query = async (sql: string, values: unknown[] = []) => { const result = await database.query(sql, values); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; };
const db = {
    query: async (sql: string, values: unknown[] = []) => { const release = await acquire(); try { return await query(sql, values); } finally { release(); } },
    connect: async () => { const unlock = await acquire(); let released = false; return { query, release() { if (!released) { released = true; unlock(); } } }; },
} as unknown as Database;
const cacheValues = new Map<string, { value: string; expires?: number }>();
const get = async (key: string) => { const entry = cacheValues.get(key); if (entry?.expires && entry.expires <= Date.now()) { cacheValues.delete(key); return null; } return entry?.value ?? null; };
const cache = {
    get,
    set: async (key: string, value: string, options?: { EX: number }) => { cacheValues.set(key, { value, expires: options ? Date.now() + options.EX * 1000 : undefined }); return "OK"; },
    del: async (key: string) => Number(cacheValues.delete(key)),
    incr: async (key: string) => { const current = await get(key); const value = Number(current ?? 0) + 1; cacheValues.set(key, { ...cacheValues.get(key), value: String(value) }); return value; },
    expire: async (key: string, seconds: number) => { const value = cacheValues.get(key); if (!value) return 0; value.expires = Date.now() + seconds * 1000; return 1; },
} as Cache;
const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "isolated-qa", REDIS_URL: "cache-double", AUTH_ENABLED: "true", ROLE_PORTALS_ENABLED: "true", CREDITS_ENABLED: "false", SESSION_COOKIE_NAME: "canvas_admin_credits_qa", PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64") });
const features = deploymentFeatures(config);
const readPolicy = () => getCreditsEnabled(db, false);
const app = express();
app.disable("x-powered-by");
app.use((request, response, next) => {
    if (request.hostname !== "127.0.0.1") { response.status(403).end(); return; }
    next();
});
app.use(express.json({ limit: "20mb" }), cookieParser(), requireSameOrigin);
app.get("/api/deployment", async (_request, response) => response.set("Cache-Control", "no-store").json({ ...features, creditsEnabled: await readPolicy() }));
app.use("/api/auth", createAuthRouter(db, cache, config));
const session = sessionMiddleware(db, cache, config, { allowGuest: false, allowAdminSession: true });
app.use("/api", session, requireAccountReady);
app.use("/api/admin/accounts", createAccountsRouter(db));
app.use("/api/admin/credit-policy", createCreditPolicyRouter(db, { authenticationEnabled: true }));
app.use("/api/admin/departments", createDepartmentsRouter(db));
app.use("/api/admin/audit-logs", createAuditRouter(db));
app.use("/api/admin/history", createAdminHistoryRouter(db));
app.use("/api/admin/groups", createGroupsRouter(db));
app.use("/api/admin/model-configuration", createModelConfigurationRouter(db, config));
app.use("/api/admin/workflows", createWorkflowsRouter(db));
app.use("/api/admin/modules", createAdminModuleFlagsRouter(db));
app.use("/api/modules", createModuleFlagsRouter(db));
app.use("/api/models", createPublicModelRouter(db, readPolicy));
app.use("/api/billing", createBillingRouter(db, readPolicy));
app.use("/api/canvas-documents", createCanvasDocumentsRouter(db));
app.use("/api", (_request, response) => response.status(403).json({ error: "QA_ONLY", message: "这是隔离的本地后台验证环境；上传、生成和未纳入测试的接口均未启用" }));
const dist = join(root, "web/dist");
app.use(express.static(dist, { index: false }));
app.use(async (_request, response) => {
    const html = await readFile(join(dist, "index.html"), "utf8");
    response.type("html").send(html.replace("</body>", '<div style="position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#7c2d12;color:#fff;text-align:center;font:12px sans-serif;padding:4px;pointer-events:none">隔离本地验证环境 · 仅测试账号和积分 · 不连接真实模型</div></body>'));
});
app.use(((error, _request, response, _next) => {
    console.error(error);
    response.status(error instanceof ZodError ? 400 : 500).json({ error: error.code ?? "QA_ERROR", message: error.message });
}) as ErrorRequestHandler);
globalThis.fetch = (() => { throw new Error("QA_ONLY: External provider requests are disabled"); }) as typeof fetch;
const server = app.listen(5190, "127.0.0.1", () => console.log(JSON.stringify({ ready: true, url: "http://127.0.0.1:5190/admin", runDirectory, credentialsFile: join(runDirectory, "fixture.json"), pid: process.pid, upstreamCalls: 0 })));
async function close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await database.close(); process.exit(0); }
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
