import { describe, expect, test } from "bun:test";
import { createSessionToken, createTotpSecret, decryptSecret, encryptSecret, hashPassword, hashToken, totpCode, validatePassword, verifyPassword, verifyTotp } from "../src/security";

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
