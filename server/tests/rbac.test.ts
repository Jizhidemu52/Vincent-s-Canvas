import { describe, expect, test } from "bun:test";
import { canManageUser, canUsePortal } from "../src/rbac";
import type { SessionUser } from "../src/types";

const user = (id: string, role: SessionUser["role"], departmentId: string | null): SessionUser => ({
    id, role, departmentId, username: id, displayName: id, email: null, employeeNo: null,
    departmentName: null, status: "active", mustChangePassword: false, mfaEnabled: false,
    groupId: null, groupName: null, groupRole: null,
    creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0,
    creditPeriodStart: "2026-07-01", creditResetAt: "2026-08-01",
});

describe("three-level permissions", () => {
    test("keeps designers out of the admin portal", () => {
        expect(canUsePortal("designer", "admin")).toBe(false);
        expect(canUsePortal("department_admin", "admin")).toBe(true);
        expect(canUsePortal("super_admin", "admin")).toBe(true);
    });
    test("scopes department administrators to designers in their department", () => {
        const manager = user("manager", "department_admin", "dept-a");
        expect(canManageUser(manager, user("a", "designer", "dept-a"))).toBe(true);
        expect(canManageUser(manager, user("b", "designer", "dept-b"))).toBe(false);
        expect(canManageUser(manager, user("other-manager", "department_admin", "dept-a"))).toBe(false);
    });
    test("prevents super administrators from modifying peers", () => {
        const admin = user("admin-a", "super_admin", null);
        expect(canManageUser(admin, user("designer", "designer", null))).toBe(true);
        expect(canManageUser(admin, user("admin-b", "super_admin", null))).toBe(false);
    });
});
