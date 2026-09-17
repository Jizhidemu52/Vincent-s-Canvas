import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { OaError } from "./oa";
import { userSelect, type UserRow } from "./user-mapper";

/** Must run inside the session-creation transaction. Never link by display name. */
export async function resolveOaUser(client: PoolClient, identity: { id: string; name: string }): Promise<UserRow> {
    // Concurrent first logins for one external identity share a transaction lock.
    // Hash collisions only serialize unrelated identities, never merge identities.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('oa'),hashtext($1))", [identity.id]);
    const existing = await client.query<UserRow>(
        `SELECT ${userSelect} FROM external_identities e JOIN users u ON u.id=e.user_id
         LEFT JOIN departments d ON d.id=u.department_id
         WHERE e.provider='oa' AND e.subject=$1 FOR UPDATE OF u`, [identity.id],
    );
    let row = existing.rows[0];
    if (row && (row.role !== "designer" || row.status !== "active" || row.is_guest)) {
        throw new OaError("OA_ACCOUNT_FORBIDDEN", "该 OA 用户未获准使用创作端", 403);
    }
    const userId = row?.id ?? randomUUID();
    if (!row) {
        await client.query(
            `INSERT INTO users(id,username,display_name,role,is_guest,must_change_password)
             VALUES($1,$2,$3,'designer',false,false)`, [userId, `oa-${userId}`, identity.name],
        );
        await client.query("INSERT INTO external_identities(user_id,provider,subject) VALUES($1,'oa',$2)", [userId, identity.id]);
    }
    await client.query(
        `UPDATE users SET display_name=$2,last_login_at=now(),must_change_password=false,
         failed_login_count=0,locked_until=NULL,updated_at=now() WHERE id=$1`, [userId, identity.name],
    );
    const result = await client.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`, [userId]);
    row = result.rows[0];
    if (!row) throw new Error("OA account creation failed");
    return row;
}
