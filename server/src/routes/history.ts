import { Router } from "express";
import { writeAudit } from "../audit";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

const select = `h.id,h.task_id AS "taskId",h.user_id AS "userId",u.display_name AS "userName",h.department_id AS "departmentId",d.name AS "departmentName",h.project_id AS "projectId",h.operation_type AS "operationType",h.model_config_id AS "modelConfigId",m.name AS "modelName",h.prompt,h.parameters,h.source_urls AS "sourceUrls",h.result_urls AS "resultUrls",h.credits,h.rmb_cost::float8 AS "rmbCost",h.status,h.failure_reason AS "failureReason",h.created_at AS "createdAt"`;

export function createHistoryRouter(db: Database) {
    const router = Router();
    router.get("/", async (request, response, next) => {
        try { const actor = (request as unknown as AuthenticatedRequest).auth; const result = await db.query(`SELECT ${select} FROM generation_history h JOIN users u ON u.id=h.user_id LEFT JOIN departments d ON d.id=h.department_id LEFT JOIN model_configs m ON m.id=h.model_config_id WHERE h.user_id=$1 ORDER BY h.created_at DESC LIMIT 1000`, [actor.id]); response.json({ history: result.rows }); }
        catch (error) { next(error); }
    });
    return router;
}

export function createAdminHistoryRouter(db: Database) {
    const router = Router(); router.use(requireRole("super_admin", "department_admin"));
    router.get("/", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const values: unknown[] = []; const filters: string[] = [];
            const add = (clause: string, value: unknown) => { values.push(value); filters.push(clause.replace("?", `$${values.length}`)); };
            if (actor.role === "department_admin") add("h.department_id=?", actor.departmentId);
            if (typeof request.query.userId === "string") add("h.user_id=?", request.query.userId);
            if (typeof request.query.projectId === "string") add("h.project_id=?", request.query.projectId);
            if (typeof request.query.modelId === "string") add("h.model_config_id=?", request.query.modelId);
            if (typeof request.query.operationType === "string") add("h.operation_type=?", request.query.operationType);
            if (typeof request.query.from === "string") add("h.created_at>=?::timestamptz", request.query.from);
            if (typeof request.query.to === "string") add("h.created_at<=?::timestamptz", request.query.to);
            const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
            const result = await db.query(`SELECT ${select} FROM generation_history h JOIN users u ON u.id=h.user_id LEFT JOIN departments d ON d.id=h.department_id LEFT JOIN model_configs m ON m.id=h.model_config_id ${where} ORDER BY h.created_at DESC LIMIT 5000`, values);
            response.json({ history: result.rows });
        } catch (error) { next(error); }
    });
    router.post("/export-event", async (request, response, next) => {
        try { const actor = (request as unknown as AuthenticatedRequest).auth; await writeAudit(db, { actor, action: "history.exported", targetType: "history", departmentId: actor.role === "department_admin" ? actor.departmentId : null, result: "success", detail: { filters: request.body?.filters ?? {}, rowCount: Number(request.body?.rowCount) || 0 }, ip: request.ip }); response.status(204).end(); }
        catch (error) { next(error); }
    }); return router;
}
