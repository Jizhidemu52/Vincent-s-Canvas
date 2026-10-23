import { Router } from "express";
import type { Database } from "../db";
import type { AuthenticatedRequest } from "../types";

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
    // Holds are created only inside authorized task/chat submission lifecycles.
    // A public standalone reservation has no execution or settlement owner.
    return router;
}
