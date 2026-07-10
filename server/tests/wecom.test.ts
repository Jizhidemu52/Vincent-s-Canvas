import { describe, expect, test } from "bun:test";

import { loadConfig, type AppConfig } from "../src/config";
import { createWeComAuthorizationUrl, exchangeWeComCode, getWeComStatus, WeComError } from "../src/wecom";

const config = {
    WECOM_CORP_ID: "ww-company",
    WECOM_AGENT_ID: "1000002",
    WECOM_SECRET: "server-secret",
    WECOM_CALLBACK_URL: "https://canvas.company.test/api/auth/wecom/callback",
} as AppConfig;

describe("WeCom identity integration", () => {
    test("rejects partial configuration and non-HTTPS production callbacks", () => {
        expect(() => loadConfig({ DATABASE_URL: "postgres://test", REDIS_URL: "redis://test", WECOM_CORP_ID: "ww-company" })).toThrow("must be configured together");
        expect(() => loadConfig({
            NODE_ENV: "production",
            DATABASE_URL: "postgres://test",
            REDIS_URL: "redis://test",
            MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            PROVIDER_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            S3_ENDPOINT: "http://minio:9000",
            S3_ACCESS_KEY_ID: "storage-user",
            S3_SECRET_ACCESS_KEY: "storage-password",
            WECOM_CORP_ID: "ww-company",
            WECOM_AGENT_ID: "1000002",
            WECOM_SECRET: "server-secret",
            WECOM_CALLBACK_URL: "http://canvas.company.test/api/auth/wecom/callback",
        })).toThrow("must use HTTPS");
    });

    test("reports missing fields without exposing configured values", () => {
        expect(getWeComStatus({ ...config, WECOM_SECRET: "" })).toEqual({
            configured: false,
            missing: ["WECOM_SECRET"],
            callbackUrl: config.WECOM_CALLBACK_URL!,
            callbackUsesHttps: true,
        });
    });

    test("builds a state-bound QR authorization URL", () => {
        const url = new URL(createWeComAuthorizationUrl(config, "state-value"));
        expect(url.origin).toBe("https://open.work.weixin.qq.com");
        expect(url.searchParams.get("appid")).toBe("ww-company");
        expect(url.searchParams.get("agentid")).toBe("1000002");
        expect(url.searchParams.get("state")).toBe("state-value");
    });

    test("accepts both modern and legacy user ID response casing", async () => {
        const payloads = [
            { errcode: 0, access_token: "token" },
            { errcode: 0, UserId: "DESIGNER-001" },
        ];
        const result = await exchangeWeComCode(config, "callback-code", async () => Response.json(payloads.shift()));
        expect(result).toEqual({ userId: "DESIGNER-001" });
    });

    test("returns a stable error when the upstream service is unavailable", async () => {
        const operation = exchangeWeComCode(config, "callback-code", async () => { throw new Error("network secret detail"); });
        await expect(operation).rejects.toBeInstanceOf(WeComError);
        await expect(operation).rejects.toMatchObject({ code: "WECOM_UNAVAILABLE", message: "企业微信接口暂时不可用，请稍后重试" });
    });
});
