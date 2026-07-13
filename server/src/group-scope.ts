import type { PoolClient } from "pg";

import type { Database } from "./db";
import type { SessionUser } from "./types";

export type GroupRole = "member" | "leader";

export async function canManageGroup(db: Database | PoolClient, actor: SessionUser, groupId: string) {
  if (actor.role === "super_admin") return true;
  if (actor.role === "department_admin") {
    const result = await db.query(
      "SELECT 1 FROM designer_groups WHERE id=$1 AND department_id=$2",
      [groupId, actor.departmentId],
    );
    return Boolean(result.rows[0]);
  }
  return actor.groupRole === "leader" && actor.groupId === groupId;
}

export function isGroupLeader(actor: Pick<SessionUser, "role" | "groupRole" | "groupId">) {
  return actor.role === "designer" && actor.groupRole === "leader" && Boolean(actor.groupId);
}

export async function ownerBelongsToLeaderGroup(
  db: Database | PoolClient,
  actor: SessionUser,
  ownerUserId: string,
  occurredAt?: Date | string,
) {
  if (!isGroupLeader(actor) || !actor.groupId) return false;
  const result = await db.query(
    `SELECT 1 FROM group_memberships gm
      WHERE gm.group_id=$1 AND gm.user_id=$2
        AND gm.effective_at<=COALESCE($3::timestamptz,now())
        AND (gm.ended_at IS NULL OR gm.ended_at>COALESCE($3::timestamptz,now()))
      LIMIT 1`,
    [actor.groupId, ownerUserId, occurredAt ?? null],
  );
  return Boolean(result.rows[0]);
}
