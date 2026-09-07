import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import { validateProductionEnvironment } from "../src/production-readiness";
import { loadConfig } from "../src/config";
import { collectProductionPreflight } from "../../ops/preflight/production-preflight";

const ready = {
    POSTGRES_PASSWORD: "postgres-production-password",
    NODE_ENV: "production",
    SESSION_COOKIE_NAME: "wireless_canvas_session",
    SESSION_TTL_SECONDS: "28800",
    TRUST_PROXY: "true",
    BOOTSTRAP_ADMIN_USERNAME: "admin",
    BOOTSTRAP_ADMIN_DISPLAY_NAME: "超级管理员",
    BOOTSTRAP_ADMIN_PASSWORD: "AdminInitial2026",
    PROVIDER_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    WORKER_CONCURRENCY: "10",
    TASK_MOCK_MODE: "false",
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "wireless-canvas",
    S3_ACCESS_KEY_ID: "wireless-canvas",
    S3_SECRET_ACCESS_KEY: "object-storage-password",
    S3_FORCE_PATH_STYLE: "true",
    WECOM_CORP_ID: "ww-company",
    WECOM_AGENT_ID: "1000002",
    WECOM_SECRET: "wecom-server-secret",
    WECOM_CALLBACK_URL: "https://canvas.company.test/api/auth/wecom/callback",
};

describe("production readiness", () => {
    test("accepts a complete production environment without printing secret values", () => {
        const checks = validateProductionEnvironment(ready, { requireWeCom: true });
        expect(checks.filter((check) => check.level === "error")).toEqual([]);
        expect(JSON.stringify(checks)).not.toContain(ready.POSTGRES_PASSWORD);
        expect(JSON.stringify(checks)).not.toContain(ready.WECOM_SECRET);
    });

    test("rejects placeholders, mock mode and partial WeCom configuration", () => {
        const checks = validateProductionEnvironment({ ...ready, POSTGRES_PASSWORD: "replace-with-password", TASK_MOCK_MODE: "true", WECOM_SECRET: "" }, { requireWeCom: true });
        expect(checks.some((check) => check.level === "error" && check.key === "POSTGRES_PASSWORD")).toBe(true);
        expect(checks.some((check) => check.level === "error" && check.key === "TASK_MOCK_MODE")).toBe(true);
        expect(checks.some((check) => check.level === "error" && check.key === "WECOM")).toBe(true);
    });

    test("requires the exact HTTPS WeCom callback path", () => {
        const checks = validateProductionEnvironment({ ...ready, WECOM_CALLBACK_URL: "https://canvas.company.test/wrong" }, { requireWeCom: true });
        expect(checks.some((check) => check.level === "error" && check.key === "WECOM_CALLBACK_PATH")).toBe(true);
    });

    test("still requires a strong initial password before the first administrator is verified", () => {
        for (const password of [undefined, "", "short", "replace-with-a-12-character-password"]) {
            const checks = validateProductionEnvironment({ ...ready, BOOTSTRAP_ADMIN_PASSWORD: password });
            expect(checks.some((check) => check.level === "error" && check.key === "BOOTSTRAP_ADMIN_PASSWORD")).toBe(true);
        }
    });

    test("allows removal of the initial password only after an existing administrator was verified", () => {
        const env = { ...ready, BOOTSTRAP_ADMIN_PASSWORD: undefined };
        const checks = validateProductionEnvironment(env, { bootstrapAdminVerified: true });
        expect(checks.filter((check) => check.level === "error")).toEqual([]);
        expect(checks.some((check) => check.key === "BOOTSTRAP_ADMIN_PASSWORD_CLEANUP" && check.level === "warning")).toBe(false);
        expect(() => loadConfig({ ...env, DATABASE_URL: "postgres://localhost/test", REDIS_URL: "redis://localhost" })).not.toThrow();
    });

    test("rejects an empty password variable even after bootstrap because runtime requires deleting the variable", () => {
        const env = { ...ready, BOOTSTRAP_ADMIN_PASSWORD: "" };
        const checks = validateProductionEnvironment(env, { bootstrapAdminVerified: true });
        expect(checks.some((check) => check.level === "error" && check.key === "BOOTSTRAP_ADMIN_PASSWORD")).toBe(true);
        expect(() => loadConfig({ ...env, DATABASE_URL: "postgres://localhost/test", REDIS_URL: "redis://localhost" })).toThrow();
    });

    test("post-bootstrap CLI cannot skip the password check without a verified database", async () => {
        const env = { ...ready, BOOTSTRAP_ADMIN_PASSWORD: undefined };
        const checks = await collectProductionPreflight(env, ["--after-bootstrap"]);
        expect(checks.some((check) => check.level === "error" && check.key === "BOOTSTRAP_ADMIN_STATE")).toBe(true);
        expect(checks.some((check) => check.level === "error" && check.key === "BOOTSTRAP_ADMIN_PASSWORD")).toBe(true);
    });

    test("rejects invalid database schemes during post-bootstrap verification without exposing credentials", async () => {
        const checks = await collectProductionPreflight({ ...ready, DATABASE_URL: "https://private-user:private-password@example.invalid/database" }, ["--after-bootstrap"]);
        expect(checks.some((check) => check.level === "error" && check.key === "BOOTSTRAP_ADMIN_STATE")).toBe(true);
        expect(JSON.stringify(checks)).not.toContain("private-password");
        expect(JSON.stringify(checks)).not.toContain("private-user");
    });

    test("a failed database connection does not confirm bootstrap or print connection credentials", async () => {
        const unavailableDatabase = createServer((socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
            unavailableDatabase.once("error", reject);
            unavailableDatabase.listen(0, "127.0.0.1", resolve);
        });
        try {
            const address = unavailableDatabase.address();
            if (!address || typeof address === "string") throw new Error("No local test listener");
            const env = { ...ready, BOOTSTRAP_ADMIN_PASSWORD: undefined,
                DATABASE_URL: `postgres://private-user:private-password@127.0.0.1:${address.port}/test` };
            const checks = await collectProductionPreflight(env, ["--after-bootstrap"]);
            expect(checks.some((check) => check.level === "error" && check.key === "BOOTSTRAP_ADMIN_STATE")).toBe(true);
            expect(checks.some((check) => check.level === "error" && check.key === "BOOTSTRAP_ADMIN_PASSWORD")).toBe(true);
            expect(JSON.stringify(checks)).not.toContain("private-password");
            expect(JSON.stringify(checks)).not.toContain("private-user");
        } finally {
            await new Promise<void>((resolve, reject) => unavailableDatabase.close((error) => error ? reject(error) : resolve()));
        }
    }, 15_000);

    test("supports password-only deployment when all four WeCom fields are cleared", () => {
        const env = { ...ready, WECOM_CORP_ID: "", WECOM_AGENT_ID: "", WECOM_SECRET: "", WECOM_CALLBACK_URL: "" };
        expect(validateProductionEnvironment(env).filter((check) => check.level === "error")).toEqual([]);
        expect(validateProductionEnvironment(env, { requireWeCom: true }).some((check) => check.level === "error" && check.key === "WECOM")).toBe(true);
        expect(() => loadConfig({ ...env, DATABASE_URL: "postgres://localhost/test", REDIS_URL: "redis://localhost" })).not.toThrow();
    });

    test("rejects the template callback when other WeCom fields remain empty", () => {
        const env = { ...ready, WECOM_CORP_ID: "", WECOM_AGENT_ID: "", WECOM_SECRET: "", WECOM_CALLBACK_URL: "https://canvas.example.com/api/auth/wecom/callback" };
        expect(validateProductionEnvironment(env).some((check) => check.level === "error" && check.key === "WECOM")).toBe(true);
        expect(() => loadConfig({ ...env, DATABASE_URL: "postgres://localhost/test", REDIS_URL: "redis://localhost" })).toThrow();
    });

    test("does not mark the template WeCom domain or Secret placeholder as production-ready", () => {
        const checks = validateProductionEnvironment({ ...ready, WECOM_SECRET: "replace-with-wecom-secret", WECOM_CALLBACK_URL: "https://canvas.example.com/api/auth/wecom/callback" });
        expect(checks.some((check) => check.level === "error" && check.key === "WECOM_SECRET")).toBe(true);
        expect(checks.some((check) => check.level === "error" && check.key === "WECOM_CALLBACK_URL")).toBe(true);
    });
});
