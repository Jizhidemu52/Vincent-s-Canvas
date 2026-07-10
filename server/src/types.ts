import type { Request } from "express";

export type UserRole = "super_admin" | "department_admin" | "designer";
export type UserStatus = "active" | "disabled" | "locked";

export type SessionUser = {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    employeeNo: string | null;
    role: UserRole;
    status: UserStatus;
    departmentId: string | null;
    departmentName: string | null;
    mustChangePassword: boolean;
    mfaEnabled: boolean;
    creditBalance: number;
    creditLimit: number;
};

export type AuthenticatedRequest = Request & {
    auth: SessionUser;
    sessionId: string;
};
