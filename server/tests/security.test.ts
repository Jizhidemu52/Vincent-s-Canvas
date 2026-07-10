import { describe, expect, test } from "bun:test";
import { createSessionToken, hashPassword, hashToken, validatePassword, verifyPassword } from "../src/security";

describe("identity security", () => {
    test("enforces production password policy", () => {
        expect(validatePassword("short1")).not.toBeNull();
        expect(validatePassword("onlyletterslong")).not.toBeNull();
        expect(validatePassword("CompanyCanvas2026")).toBeNull();
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
