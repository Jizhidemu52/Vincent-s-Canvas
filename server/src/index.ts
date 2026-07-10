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
import {
  createModelConfigurationRouter,
  createPublicModelRouter,
} from "./routes/model-configuration";
import { createAdminTasksRouter, createTasksRouter } from "./routes/tasks";
import {
  createAdminHistoryRouter,
  createHistoryRouter,
} from "./routes/history";
import { createAdminAssetsRouter, createAssetsRouter } from "./routes/assets";
import { ObjectStorage } from "./object-storage";
import {
  createAdminProjectsRouter,
  createProjectsRouter,
} from "./routes/projects";
import { createWorkflowsRouter } from "./routes/workflows";
import { createChatRouter } from "./routes/chat";
import { requireSameOrigin } from "./http-security";
import { requireAccountReady, sessionMiddleware } from "./session";
import { createIntegrationsRouter } from "./routes/integrations";
import { createInternalAiConfigurationRouter } from "./routes/internal-ai-configuration";

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
  } catch (error) {
    next(error);
  }
});
app.use("/api/auth", createAuthRouter(db, cache, config));
const requireSession = sessionMiddleware(db, cache, config);
app.use(
  "/api/billing",
  requireSession,
  requireAccountReady,
  createBillingRouter(db),
);
app.use(
  "/api/models",
  requireSession,
  requireAccountReady,
  createPublicModelRouter(db),
);
app.use(
  "/api/admin/model-configuration",
  requireSession,
  requireAccountReady,
  createModelConfigurationRouter(db, config),
);
app.use(
  "/api/tasks",
  requireSession,
  requireAccountReady,
  createTasksRouter(db, cache),
);
app.use(
  "/api/admin/tasks",
  requireSession,
  requireAccountReady,
  createAdminTasksRouter(db, cache),
);
app.use(
  "/api/history",
  requireSession,
  requireAccountReady,
  createHistoryRouter(db),
);
app.use(
  "/api/admin/history",
  requireSession,
  requireAccountReady,
  createAdminHistoryRouter(db),
);
app.use(
  "/api/assets",
  requireSession,
  requireAccountReady,
  createAssetsRouter(db, storage),
);
app.use(
  "/api/admin/assets",
  requireSession,
  requireAccountReady,
  createAdminAssetsRouter(db),
);
app.use(
  "/api/projects",
  requireSession,
  requireAccountReady,
  createProjectsRouter(db),
);
app.use(
  "/api/admin/projects",
  requireSession,
  requireAccountReady,
  createAdminProjectsRouter(db),
);
app.use(
  "/api/admin/workflows",
  requireSession,
  requireAccountReady,
  createWorkflowsRouter(db),
);
app.use(
  "/api/chat",
  requireSession,
  requireAccountReady,
  createChatRouter(db, config),
);
app.use(
  "/api/admin/accounts",
  requireSession,
  requireAccountReady,
  createAccountsRouter(db),
);
app.use(
  "/api/admin/departments",
  requireSession,
  requireAccountReady,
  createDepartmentsRouter(db),
);
app.use(
  "/api/admin/audit-logs",
  requireSession,
  requireAccountReady,
  createAuditRouter(db),
);
app.use(
  "/api/admin/integrations",
  requireSession,
  requireAccountReady,
  createIntegrationsRouter(config),
);
app.use(
  "/api/admin/internal-ai",
  requireSession,
  requireAccountReady,
  createInternalAiConfigurationRouter(db, config),
);

app.use((_request, response) =>
  response.status(404).json({ error: "NOT_FOUND", message: "接口不存在" }),
);
const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "VALIDATION_ERROR",
      message: "提交内容不符合要求",
      issues: error.issues,
    });
    return;
  }
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    error.code === "23505"
  ) {
    response.status(409).json({
      error: "DUPLICATE",
      message: "账号、邮箱、工号或部门编码已存在",
    });
    return;
  }
  console.error(error);
  response.status(500).json({
    error: "INTERNAL_ERROR",
    message: "服务器处理失败",
    ...(config.NODE_ENV === "test"
      ? { detail: error instanceof Error ? error.message : String(error) }
      : {}),
  });
};
app.use(errorHandler);

const server = app.listen(config.PORT, () =>
  console.log(`Wireless Canvas API listening on ${config.PORT}`),
);
const shutdown = async () => {
  server.close();
  await Promise.all([db.end(), cache.quit()]);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
