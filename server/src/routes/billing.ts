import { Router } from "express";
import { z } from "zod";
import { BillingError, reserveCredits } from "../billing";
import type { Database } from "../db";
import type { AuthenticatedRequest } from "../types";

const reserveSchema = z.object({ requestId: z.string().min(8).max(200), operationType: z.string().min(1).max(80), modelConfigId: z.string().uuid().nullish(), quantity: z.number().int().min(1).max(100) });

export function createBillingRouter(db: Database) {
    const router = Router();
    router.get("/ledger", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query(`SELECT id,entry_type AS "entryType",amount,balance_after AS "balanceAfter",reference_type AS "referenceType",reference_id AS "referenceId",reason,metadata,created_at AS "createdAt"
                FROM credit_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500`, [actor.id]);
            response.json({ entries: result.rows });
        } catch (error) { next(error); }
    });
    router.post("/reservations", async (request, response, next) => {
        try {
            const input = reserveSchema.parse(request.body);
            const actor = (request as unknown as AuthenticatedRequest).auth;
            response.status(201).json(await reserveCredits(db, { ...input, userId: actor.id }));
        } catch (error) {
            if (error instanceof BillingError) { response.status(400).json({ error: error.code, message: error.message }); return; }
            next(error);
        }
    });
    return router;
}
