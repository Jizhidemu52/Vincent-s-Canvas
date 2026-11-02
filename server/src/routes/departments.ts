import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";
import { withTransaction } from "../db-transaction";
import { configurationErrorHandler } from "./admin-configuration-errors";

const departmentSchema = z.object({ name: z.string().trim().min(1).max(100), code: z.string().trim().min(1).max(50) });

export function createDepartmentsRouter(db: Database) {
    const router = Router();
    router.get("/", requireRole("super_admin", "department_admin"), async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            if (actor.role === "department_admin" && !actor.departmentId) {
                response.status(403).json({ error: "FORBIDDEN", message: "部门管理员尚未分配部门" }); return;
            }
            const scope = actor.role === "department_admin" ? " WHERE id=$1" : "";
            response.json({ departments: (await db.query(`SELECT id,name,code,created_at AS "createdAt" FROM departments${scope} ORDER BY name`, scope ? [actor.departmentId] : [])).rows });
        }
        catch (error) { next(error); }
    });
    router.post("/", requireRole("super_admin"), async (request, response, next) => {
        try {
            const input = departmentSchema.parse(request.body);
            const department = await withTransaction(db, async client => {
                const result = await client.query("INSERT INTO departments(name,code) VALUES($1,$2) RETURNING id,name,code,created_at AS \"createdAt\"", [input.name, input.code]);
                const saved = result.rows[0];
                await writeAudit(client, { actor: (request as unknown as AuthenticatedRequest).auth, action: "department.created", targetType: "department", targetId: saved.id, departmentId: saved.id, result: "success", detail: { name: input.name }, ip: request.ip });
                return saved;
            });
            response.status(201).json({ department });
        } catch (error) { next(error); }
    });
    router.use(configurationErrorHandler);
    return router;
}
