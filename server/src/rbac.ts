import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest, SessionUser, UserRole } from "./types";

const roleRank: Record<UserRole, number> = { designer: 0, department_admin: 1, super_admin: 2 };

export function canUsePortal(role: UserRole, portal: "designer" | "admin") {
    return portal === "designer" || roleRank[role] >= roleRank.department_admin;
}

export function canManageUser(actor: SessionUser, target: Pick<SessionUser, "role" | "departmentId" | "id">) {
    if (actor.id === target.id) return false;
    if (actor.role === "super_admin") return target.role !== "super_admin";
    return actor.role === "department_admin" && target.role === "designer" && actor.departmentId !== null && actor.departmentId === target.departmentId;
}

export function requireRole(...roles: UserRole[]) {
    return (request: Request, response: Response, next: NextFunction) => {
        const authenticated = request as unknown as AuthenticatedRequest;
        if (!roles.includes(authenticated.auth.role)) {
            response.status(403).json({ error: "FORBIDDEN", message: "权限不足" });
            return;
        }
        next();
    };
}
