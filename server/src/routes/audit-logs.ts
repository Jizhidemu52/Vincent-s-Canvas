import { Router } from "express";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

export function createAuditRouter(db: Database) {
    const router = Router();
    router.use(requireRole("super_admin", "department_admin"));
    router.get("/", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 500);
            const values: unknown[] = [limit];
            const scope = actor.role === "department_admin" ? (values.push(actor.departmentId), "WHERE a.department_id=$2") : "";
            const result = await db.query(
                `SELECT a.id,a.action,a.target_type AS "targetType",a.target_id AS "targetId",a.result,a.detail,a.created_at AS "createdAt",
                    u.display_name AS "actorName",a.actor_role AS "actorRole",d.name AS "departmentName"
                 FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN departments d ON d.id=a.department_id
                 ${scope} ORDER BY a.created_at DESC LIMIT $1`, values,
            );
            response.json({ auditLogs: result.rows });
        } catch (error) { next(error); }
    });
    return router;
}
