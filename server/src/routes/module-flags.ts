import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { moduleKeys } from "../module-flags";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

const updateSchema = z.object({ moduleKey: z.enum(moduleKeys), enabled: z.boolean() });

export function createModuleFlagsRouter(db: Database) {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try {
      const result = await db.query<{ moduleKey: string; enabled: boolean; updatedAt: string }>(
        `SELECT module_key AS "moduleKey",enabled,updated_at AS "updatedAt" FROM module_flags ORDER BY module_key`,
      );
      response.json({ modules: result.rows });
    } catch (error) { next(error); }
  });
  return router;
}

export function createAdminModuleFlagsRouter(db: Database) {
  const router = Router();
  router.use(requireRole("super_admin"));
  router.patch("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = updateSchema.parse(request.body);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ moduleKey: string; enabled: boolean; updatedAt: string }>(
          `UPDATE module_flags SET enabled=$1,updated_by=$2,updated_at=now() WHERE module_key=$3
            RETURNING module_key AS "moduleKey",enabled,updated_at AS "updatedAt"`,
          [input.enabled, actor.id, input.moduleKey],
        );
        await writeAudit(client, { actor, action: "module.availability_changed", targetType: "module", targetId: input.moduleKey, result: "success", detail: { enabled: input.enabled }, ip: request.ip });
        await client.query("COMMIT");
        response.json({ module: result.rows[0] });
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } catch (error) { next(error); }
  });
  return router;
}
