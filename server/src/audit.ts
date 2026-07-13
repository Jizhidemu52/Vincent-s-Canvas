import type { PoolClient } from "pg";

import type { Database } from "./db";
import type { SessionUser } from "./types";

export async function writeAudit(db: Database | PoolClient, input: {
    actor?: SessionUser;
    action: string;
    targetType: string;
    targetId?: string;
    departmentId?: string | null;
    result: "success" | "denied" | "failed";
    detail?: Record<string, unknown>;
    ip?: string;
}) {
    await db.query(
        `INSERT INTO audit_logs(actor_user_id, actor_role, action, target_type, target_id, department_id, result, detail, ip_address)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.actor?.id ?? null, input.actor?.role ?? null, input.action, input.targetType, input.targetId ?? null, input.departmentId ?? null, input.result, input.detail ?? {}, input.ip ?? null],
    );
}
