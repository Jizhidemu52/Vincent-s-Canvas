import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../audit";
import { getCreditPolicy } from "../credit-policy";
import type { Database } from "../db";
import { withTransaction } from "../db-transaction";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

const inputSchema = z.object({ creditsEnabled: z.boolean() }).strict();

export function createCreditPolicyRouter(db: Database, options: { authenticationEnabled: boolean; defaultEnabled?: boolean }) {
    const router = Router();
    router.use(requireRole("super_admin", "department_admin"));
    router.get("/", async (_request, response, next) => {
        try { response.set("Cache-Control", "no-store").json(await getCreditPolicy(db, options.defaultEnabled)); }
        catch (error) { next(error); }
    });
    router.patch("/", requireRole("super_admin"), async (request, response, next) => {
        try {
            const input = inputSchema.parse(request.body);
            if (input.creditsEnabled && !options.authenticationEnabled) {
                response.status(409).json({ error: "AUTHENTICATION_REQUIRED", message: "请先启用独立账号登录，再开启积分计费" });
                return;
            }
            const actor = (request as AuthenticatedRequest).auth;
            const result = await withTransaction(db, async (client) => {
                const saved = await client.query(
                    `INSERT INTO credit_policy(singleton,credits_enabled,updated_by) VALUES(true,$1,$2)
                     ON CONFLICT(singleton) DO UPDATE SET credits_enabled=EXCLUDED.credits_enabled,updated_by=EXCLUDED.updated_by,updated_at=now()
                     RETURNING credits_enabled AS "creditsEnabled",updated_at AS "updatedAt"`,
                    [input.creditsEnabled, actor.id],
                );
                await writeAudit(client, { actor, action: "credits.policy_changed", targetType: "credit_policy", result: "success", detail: input, ip: request.ip });
                return saved.rows[0];
            });
            response.json(result);
        } catch (error) { next(error); }
    });
    return router;
}
