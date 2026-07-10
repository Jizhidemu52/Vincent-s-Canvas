import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

const departmentSchema = z.object({ name: z.string().trim().min(1).max(100), code: z.string().trim().min(1).max(50) });

export function createDepartmentsRouter(db: Database) {
    const router = Router();
    router.get("/", async (_request, response, next) => {
        try { response.json({ departments: (await db.query("SELECT id,name,code,created_at AS \"createdAt\" FROM departments ORDER BY name")).rows }); }
        catch (error) { next(error); }
    });
    router.post("/", requireRole("super_admin"), async (request, response, next) => {
        try {
            const input = departmentSchema.parse(request.body);
            const result = await db.query("INSERT INTO departments(name,code) VALUES($1,$2) RETURNING id,name,code,created_at AS \"createdAt\"", [input.name, input.code]);
            const department = result.rows[0];
            await writeAudit(db, { actor: (request as unknown as AuthenticatedRequest).auth, action: "department.created", targetType: "department", targetId: department.id, departmentId: department.id, result: "success", detail: { name: input.name }, ip: request.ip });
            response.status(201).json({ department });
        } catch (error) { next(error); }
    });
    return router;
}
