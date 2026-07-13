import type { SessionUser } from "./types";

export type UserRow = {
    id: string; username: string; display_name: string; email: string | null; employee_no: string | null;
    role: SessionUser["role"]; status: SessionUser["status"]; department_id: string | null;
    department_name: string | null; must_change_password: boolean; mfa_enabled: boolean;
    group_id: string | null; group_name: string | null; group_role: SessionUser["groupRole"];
    credit_balance: number; credit_limit: number; monthly_credit_limit: number;
    temporary_credit_adjustment: number; credit_period_start: string; credit_reset_at: string;
};

export function mapUser(row: UserRow): SessionUser {
    return {
        id: row.id, username: row.username, displayName: row.display_name, email: row.email,
        employeeNo: row.employee_no, role: row.role, status: row.status,
        departmentId: row.department_id, departmentName: row.department_name,
        groupId: row.group_id, groupName: row.group_name, groupRole: row.group_role,
        mustChangePassword: row.must_change_password, mfaEnabled: row.mfa_enabled,
        creditBalance: row.credit_balance, creditLimit: row.credit_limit,
        monthlyCreditLimit: row.monthly_credit_limit,
        temporaryCreditAdjustment: row.temporary_credit_adjustment,
        creditPeriodStart: row.credit_period_start, creditResetAt: row.credit_reset_at,
    };
}

export const userSelect = `u.id, u.username, u.display_name, u.email, u.employee_no, u.role, u.status,
    u.department_id, d.name AS department_name, u.must_change_password, u.mfa_enabled,
    (SELECT gm.group_id FROM group_memberships gm JOIN designer_groups g ON g.id=gm.group_id
      WHERE gm.user_id=u.id AND gm.ended_at IS NULL AND g.status='active' LIMIT 1) AS group_id,
    (SELECT g.name FROM group_memberships gm JOIN designer_groups g ON g.id=gm.group_id
      WHERE gm.user_id=u.id AND gm.ended_at IS NULL AND g.status='active' LIMIT 1) AS group_name,
    (SELECT gm.member_role FROM group_memberships gm JOIN designer_groups g ON g.id=gm.group_id
      WHERE gm.user_id=u.id AND gm.ended_at IS NULL AND g.status='active' LIMIT 1) AS group_role,
    u.credit_balance, u.credit_limit, u.monthly_credit_limit, u.temporary_credit_adjustment,
    u.credit_period_start::text, (u.credit_period_start + INTERVAL '1 month')::date::text AS credit_reset_at`;
