import { describe, expect, test } from "bun:test";

import { authenticateDemoAccount, demoAccounts } from "../src/demo-accounts";

describe("local demo accounts", () => {
    test("covers administrator, leader, English and Chinese designer logins", () => {
        expect(demoAccounts.map((account) => account.label)).toEqual(["超级管理员", "设计组长", "英文设计师账号", "中文设计师账号"]);
        expect(authenticateDemoAccount("小林", "Canvas2026!#", "designer")?.user.displayName).toBe("设计师小林");
        expect(authenticateDemoAccount("DESIGNER01", "Canvas2026!#", "designer")?.user.username).toBe("designer01");
    });

    test("keeps administrator and designer portals separated", () => {
        expect(authenticateDemoAccount("admin", "Canvas2026!#", "designer")).toBeNull();
        expect(authenticateDemoAccount("designer01", "Canvas2026!#", "admin")).toBeNull();
        expect(authenticateDemoAccount("admin", "wrong-password", "admin")).toBeNull();
    });
});
