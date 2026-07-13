import { describe, expect, test } from "bun:test";

import { canManageGroup, isGroupLeader } from "../src/group-scope";
import type { SessionUser } from "../src/types";

const user = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: "designer-a", username: "designer-a", displayName: "Designer A", email: null, employeeNo: null,
  role: "designer", status: "active", departmentId: "dept-a", departmentName: "设计部",
  groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: false,
  creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0,
  creditPeriodStart: "2026-07-01", creditResetAt: "2026-08-01", ...overrides,
});

describe("designer group scope", () => {
  test("recognizes only designer leaders with an active group", () => {
    expect(isGroupLeader(user({ groupId: "group-a", groupRole: "leader" }))).toBe(true);
    expect(isGroupLeader(user({ groupId: "group-a", groupRole: "member" }))).toBe(false);
    expect(isGroupLeader(user({ role: "department_admin", groupId: "group-a", groupRole: "leader" }))).toBe(false);
  });

  test("limits department administrators and leaders to their own group", async () => {
    const db = { query: async (_sql: string, values: unknown[]) => ({ rows: values[1] === "dept-a" ? [{ ok: true }] : [] }) } as never;
    expect(await canManageGroup(db, user({ role: "super_admin" }), "group-b")).toBe(true);
    expect(await canManageGroup(db, user({ role: "department_admin", departmentId: "dept-a" }), "group-a")).toBe(true);
    expect(await canManageGroup(db, user({ role: "department_admin", departmentId: "dept-b" }), "group-a")).toBe(false);
    expect(await canManageGroup(db, user({ groupId: "group-a", groupRole: "leader" }), "group-a")).toBe(true);
    expect(await canManageGroup(db, user({ groupId: "group-a", groupRole: "leader" }), "group-b")).toBe(false);
  });
});
