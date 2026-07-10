import { describe, expect, test } from "bun:test";

import { validateProductionEnvironment } from "../src/production-readiness";

const ready = {
    POSTGRES_PASSWORD: "postgres-production-password",
    NODE_ENV: "production",
    SESSION_COOKIE_NAME: "wireless_canvas_session",
    SESSION_TTL_SECONDS: "28800",
    TRUST_PROXY: "true",
    BOOTSTRAP_ADMIN_USERNAME: "admin",
    BOOTSTRAP_ADMIN_DISPLAY_NAME: "超级管理员",
    BOOTSTRAP_ADMIN_PASSWORD: "AdminInitial2026",
    MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
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
});
