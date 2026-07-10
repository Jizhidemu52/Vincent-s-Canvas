import { describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import type { Cache } from "../src/db";
import { rateLimit, requireSameOrigin } from "../src/http-security";
import { createSessionToken, createTotpSecret, decryptSecret, encryptSecret, hashPassword, hashToken, totpCode, validatePassword, verifyPassword, verifyTotp } from "../src/security";

function createResponse() {
    const result = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
    const response = {
        status(code: number) {
            result.statusCode = code;
            return response;
        },
        json(body: unknown) {
            result.body = body;
            return response;
        },
        setHeader(name: string, value: string) {
            result.headers[name] = value;
            return response;
        },
    } as unknown as Response;
    return { response, result };
}

describe("identity security", () => {
    test("enforces production password policy", () => {
        expect(validatePassword("short1")).not.toBeNull();
        expect(validatePassword("onlyletterslong")).not.toBeNull();
        expect(validatePassword("CompanyCanvas2026")).toBeNull();
    });
    test("encrypts MFA secrets and verifies time-based codes", () => {
        const secret = createTotpSecret();
        const key = Buffer.alloc(32, 7).toString("base64");
        const encrypted = encryptSecret(secret, key);
        expect(encrypted).not.toContain(secret);
        expect(decryptSecret(encrypted, key)).toBe(secret);
        const now = 1_750_000_000_000;
        expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(true);
        expect(verifyTotp(secret, "000000", now)).toBe(false);
    });
    test("hashes passwords and session tokens", async () => {
        const passwordHash = await hashPassword("CompanyCanvas2026");
        expect(passwordHash).not.toContain("CompanyCanvas2026");
        expect(await verifyPassword(passwordHash, "CompanyCanvas2026")).toBe(true);
        expect(await verifyPassword(passwordHash, "wrong-password")).toBe(false);
        const session = createSessionToken();
        expect(hashToken(session.token)).not.toBe(session.token);
    });
});

describe("HTTP security", () => {
    test("allows safe requests and same-origin writes but rejects cross-site writes", () => {
        const makeRequest = (method: string, origin?: string) => ({
            method,
            get(name: string) {
                if (name === "origin") return origin;
                if (name === "host") return "canvas.company.internal";
                return undefined;
            },
        }) as Request;

        let nextCalls = 0;
        const next = (() => { nextCalls += 1; }) as NextFunction;
        requireSameOrigin(makeRequest("GET", "https://evil.example"), createResponse().response, next);
        requireSameOrigin(makeRequest("POST", "https://canvas.company.internal"), createResponse().response, next);
        const blocked = createResponse();
        requireSameOrigin(makeRequest("POST", "https://evil.example"), blocked.response, next);

        expect(nextCalls).toBe(2);
        expect(blocked.result.statusCode).toBe(403);
        expect(blocked.result.body).toEqual({ error: "INVALID_ORIGIN", message: "拒绝跨站写请求" });
    });

    test("limits the twenty-first login attempt and sets the Redis expiry once", async () => {
        let count = 0;
        const expiries: Array<[string, number]> = [];
        const cache = {
            incr: async () => ++count,
            expire: async (key: string, seconds: number) => {
                expiries.push([key, seconds]);
                return 1;
            },
        } as unknown as Cache;
        const middleware = rateLimit(cache, {
            prefix: "login",
            limit: 20,
            windowSeconds: 300,
            key: (currentRequest) => `${currentRequest.ip}:${String(currentRequest.body.identifier).toLowerCase()}`,
        });
        const request = { ip: "10.0.0.8", body: { identifier: "Designer-A" } } as Request;
        let nextCalls = 0;
        const next = (() => { nextCalls += 1; }) as NextFunction;

        for (let attempt = 0; attempt < 20; attempt += 1) {
            await middleware(request, createResponse().response, next);
        }
        const blocked = createResponse();
        await middleware(request, blocked.response, next);

        expect(nextCalls).toBe(20);
        expect(expiries).toEqual([["rate:login:10.0.0.8:designer-a", 300]]);
        expect(blocked.result.statusCode).toBe(429);
        expect(blocked.result.headers["retry-after"]).toBe("300");
    });
});
