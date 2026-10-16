import type { Database } from "./db";

export type CreditPolicy = { creditsEnabled: boolean; updatedAt: string | null };

export async function getCreditPolicy(db: Pick<Database, "query">, fallback = false): Promise<CreditPolicy> {
    const result = await db.query<CreditPolicy>(
        'SELECT credits_enabled AS "creditsEnabled",updated_at AS "updatedAt" FROM credit_policy WHERE singleton=true',
    );
    return result.rows[0] ?? { creditsEnabled: fallback, updatedAt: null };
}

/** Read on each new submission; already-reserved work keeps its price snapshot. */
export async function getCreditsEnabled(db: Pick<Database, "query">, fallback = false) {
    return (await getCreditPolicy(db, fallback)).creditsEnabled;
}
