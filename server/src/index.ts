import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { ZodError } from "zod";

import { loadConfig } from "./config";
import { createCache, createDatabase } from "./db";
import { createAccountsRouter } from "./routes/accounts";
import { createAuditRouter } from "./routes/audit-logs";
import { createAuthRouter } from "./routes/auth";
import { createBillingRouter } from "./routes/billing";
import { createDepartmentsRouter } from "./routes/departments";
import { createModelConfigurationRouter, createPublicModelRouter } from "./routes/model-configuration";
import { createAdminTasksRouter, createTasksRouter } from "./routes/tasks";
import { createAdminHistoryRouter, createHistoryRouter } from "./routes/history";
import { createAdminAssetsRouter, createAssetsRouter } from "./routes/assets";
import { ObjectStorage } from "./object-storage";
import { createAdminProjectsRouter, createProjectsRouter } from "./routes/projects";
import { createWorkflowsRouter } from "./routes/workflows";
import { createChatRouter } from "./routes/chat";
import { requireSameOrigin } from "./http-security";
import { sessionMiddleware } from "./session";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const cache = await createCache(config.REDIS_URL);
const storage = new ObjectStorage(config);
const app = express();

if (config.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(requireSameOrigin);

app.get("/api/health", async (_request, response, next) => {
    try {
        await Promise.all([db.query("SELECT 1"), cache.ping()]);
        response.json({ status: "ok" });
    } catch (error) { next(error); }
});
app.use("/api/auth", createAuthRouter(db, cache, config));
app.use("/api/billing", sessionMiddleware(db, cache, config), createBillingRouter(db));
app.use("/api/models", sessionMiddleware(db, cache, config), createPublicModelRouter(db));
app.use("/api/admin/model-configuration", sessionMiddleware(db, cache, config), createModelConfigurationRouter(db, config));
app.use("/api/tasks", sessionMiddleware(db, cache, config), createTasksRouter(db, cache));
app.use("/api/admin/tasks", sessionMiddleware(db, cache, config), createAdminTasksRouter(db));
app.use("/api/history", sessionMiddleware(db, cache, config), createHistoryRouter(db));
app.use("/api/admin/history", sessionMiddleware(db, cache, config), createAdminHistoryRouter(db));
app.use("/api/assets", sessionMiddleware(db, cache, config), createAssetsRouter(db, storage));
app.use("/api/admin/assets", sessionMiddleware(db, cache, config), createAdminAssetsRouter(db));
app.use("/api/projects", sessionMiddleware(db, cache, config), createProjectsRouter(db));
app.use("/api/admin/projects", sessionMiddleware(db, cache, config), createAdminProjectsRouter(db));
app.use("/api/admin/workflows", sessionMiddleware(db, cache, config), createWorkflowsRouter(db));
app.use("/api/chat", sessionMiddleware(db, cache, config), createChatRouter(db, config));
app.use("/api/admin/accounts", sessionMiddleware(db, cache, config), createAccountsRouter(db));
app.use("/api/admin/departments", sessionMiddleware(db, cache, config), createDepartmentsRouter(db));
app.use("/api/admin/audit-logs", sessionMiddleware(db, cache, config), createAuditRouter(db));

app.use((_request, response) => response.status(404).json({ error: "NOT_FOUND", message: "接口不存在" }));
const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof ZodError) {
        response.status(400).json({ error: "VALIDATION_ERROR", message: "提交内容不符合要求", issues: error.issues }); return;
    }
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        response.status(409).json({ error: "DUPLICATE", message: "账号、邮箱、工号或部门编码已存在" }); return;
    }
    console.error(error);
    response.status(500).json({ error: "INTERNAL_ERROR", message: "服务器处理失败" });
};
app.use(errorHandler);

const server = app.listen(config.PORT, () => console.log(`Wireless Canvas API listening on ${config.PORT}`));
const shutdown = async () => {
    server.close();
    await Promise.all([db.end(), cache.quit()]);
    process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
