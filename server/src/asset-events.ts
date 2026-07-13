import type { PoolClient } from "pg";

import type { Database } from "./db";
import type { SessionUser } from "./types";

export const assetEventTypes = [
  "asset.generated",
  "asset.candidate_added",
  "asset.project_added",
  "asset.edited",
  "asset.reused",
  "asset.downloaded",
  "asset.exported",
  "asset.adopted",
  "asset.delivered",
  "asset.pending",
  "asset.rejected",
  "asset.event_reversed",
] as const;

export type AssetEventType = (typeof assetEventTypes)[number];
export type AssetResultStatus =
  | "unused"
  | "candidate"
  | "project"
  | "editing"
  | "downloaded"
  | "adopted"
  | "delivered"
  | "pending"
  | "rejected";

export type AssetEventRecord = {
  id: string;
  sequenceNo: number;
  assetId: string;
  designerUserId: string;
  actorUserId: string | null;
  departmentId: string | null;
  groupId: string | null;
  projectId: string | null;
  projectExternalId: string | null;
  taskId: string | null;
  modelConfigId: string | null;
  eventType: AssetEventType;
  prompt: string;
  credits: number;
  rmbCost: number;
  firstEffective: boolean;
  sourceEventId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
};

export type AssetProjection = {
  resultStatus: AssetResultStatus;
  usabilityScore: number;
  downloadCount: number;
  firstDownloadedAt: string | null;
  eventCount: number;
};

const scoreByType: Partial<Record<AssetEventType, number>> = {
  "asset.candidate_added": 5,
  "asset.project_added": 10,
  "asset.edited": 10,
  "asset.reused": 15,
  "asset.downloaded": 15,
  "asset.exported": 20,
  "asset.adopted": 30,
  "asset.delivered": 40,
};

const statusByType: Partial<Record<AssetEventType, AssetResultStatus>> = {
  "asset.generated": "unused",
  "asset.candidate_added": "candidate",
  "asset.project_added": "project",
  "asset.edited": "editing",
  "asset.reused": "editing",
  "asset.downloaded": "downloaded",
  "asset.exported": "downloaded",
  "asset.adopted": "adopted",
  "asset.delivered": "delivered",
  "asset.pending": "pending",
  "asset.rejected": "rejected",
};

type AssetSnapshot = {
  id: string;
  owner_user_id: string;
  department_id: string | null;
  group_id: string | null;
  project_id: string | null;
  project_external_id: string | null;
  task_id: string | null;
  model_config_id: string | null;
  prompt: string | null;
  credits: number;
  rmb_cost: string;
  visibility_scope: "private" | "company";
  created_at: string;
};

export function projectAssetEvents(events: AssetEventRecord[]): AssetProjection {
  const reversedIds = new Set(
    events
      .filter((event) => event.eventType === "asset.event_reversed" && event.sourceEventId)
      .map((event) => event.sourceEventId!),
  );
  const active = events.filter(
    (event) => event.eventType !== "asset.event_reversed" && !reversedIds.has(event.id),
  );
  let resultStatus: AssetResultStatus = "unused";
  let score = 0;
  let downloadCount = 0;
  let firstDownloadedAt: string | null = null;

  for (const event of active) {
    const status = statusByType[event.eventType];
    if (status) resultStatus = status;
    if (event.eventType === "asset.downloaded") {
      downloadCount += 1;
      if (event.firstEffective && !firstDownloadedAt) firstDownloadedAt = event.occurredAt;
    }
    if (event.firstEffective) score += scoreByType[event.eventType] ?? 0;
  }

  return {
    resultStatus,
    usabilityScore: Math.min(100, score),
    downloadCount,
    firstDownloadedAt,
    eventCount: active.length,
  };
}

export function canManageResultState(actor: SessionUser, ownerUserId: string, departmentId: string | null, groupId: string | null = null) {
  if (actor.role === "super_admin") return true;
  if (actor.role === "department_admin") return actor.departmentId !== null && actor.departmentId === departmentId && actor.id !== ownerUserId;
  return actor.groupRole === "leader" && actor.groupId !== null && actor.groupId === groupId;
}

export async function recordAssetEvent(
  db: Database,
  input: {
    assetId: string;
    actor: SessionUser | null;
    eventType: Exclude<AssetEventType, "asset.event_reversed">;
    idempotencyKey: string;
    projectId?: string;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  },
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const asset = await loadAssetSnapshot(client, input.assetId, true);
    if (!asset) throw new AssetEventError("NOT_FOUND", "素材不存在", 404);
    if (["asset.reused", "asset.downloaded", "asset.exported"].includes(input.eventType) && input.actor && !(await canAccessAsset(client, input.actor, asset))) {
      throw new AssetEventError("NOT_FOUND", "素材不存在或无权访问", 404);
    }
    assertEventPermission(input.actor, input.eventType, asset);
    if (input.eventType === "asset.project_added") {
      await attachAssetToProject(client, input.actor!, asset, input.projectId);
    }
    const existing = await client.query<{ id: string; asset_id: string; event_type: AssetEventType }>(
      "SELECT id,asset_id,event_type FROM asset_events WHERE idempotency_key=$1",
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].asset_id !== input.assetId || existing.rows[0].event_type !== input.eventType) {
        throw new AssetEventError("IDEMPOTENCY_CONFLICT", "幂等键已用于其他成果操作", 409);
      }
      await client.query("COMMIT");
      return existing.rows[0].id;
    }

    const effective = isScoringEvent(input.eventType, input.actor, asset) &&
      !(await hasEffectiveEvent(client, input.assetId, input.eventType));
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO asset_events(
        asset_id,designer_user_id,actor_user_id,department_id,group_id,project_id,
        project_external_id,task_id,model_config_id,event_type,prompt,credits,
        rmb_cost,first_effective,idempotency_key,metadata,occurred_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id`,
      [
        asset.id,
        asset.owner_user_id,
        input.actor?.id ?? null,
        asset.department_id,
        asset.group_id,
        asset.project_id,
        asset.project_external_id,
        asset.task_id,
        asset.model_config_id,
        input.eventType,
        asset.prompt ?? "",
        Number(asset.credits),
        Number(asset.rmb_cost),
        effective,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
        input.occurredAt ?? new Date(),
      ],
    );
    await client.query("COMMIT");
    return inserted.rows[0]!.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reverseAssetEvent(db: Database, actor: SessionUser, assetId: string, eventId: string, idempotencyKey: string, reason: string) {
  if (actor.role === "designer" && actor.groupRole !== "leader") throw new AssetEventError("FORBIDDEN", "权限不足", 403);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const source = await client.query<{ asset_id: string; department_id: string | null; group_id: string | null; event_type: AssetEventType }>(
      "SELECT asset_id,department_id,group_id,event_type FROM asset_events WHERE id=$1 FOR UPDATE",
      [eventId],
    );
    const event = source.rows[0];
    if (!event || event.event_type === "asset.event_reversed") throw new AssetEventError("NOT_FOUND", "成果事件不存在", 404);
    if (event.asset_id !== assetId) throw new AssetEventError("NOT_FOUND", "成果事件不存在", 404);
    if (actor.role === "department_admin" && actor.departmentId !== event.department_id) throw new AssetEventError("FORBIDDEN", "权限不足", 403);
    if (actor.role === "designer" && (actor.groupRole !== "leader" || actor.groupId !== event.group_id)) throw new AssetEventError("FORBIDDEN", "权限不足", 403);
    const existingKey = await client.query<{ id: string; source_event_id: string }>(
      "SELECT id,source_event_id FROM asset_events WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    if (existingKey.rows[0]) {
      if (existingKey.rows[0].source_event_id !== eventId) throw new AssetEventError("IDEMPOTENCY_CONFLICT", "幂等键已用于其他纠正操作", 409);
      await client.query("COMMIT");
      return existingKey.rows[0].id;
    }
    const existingReverse = await client.query("SELECT id FROM asset_events WHERE event_type='asset.event_reversed' AND source_event_id=$1", [eventId]);
    if (existingReverse.rows[0]) throw new AssetEventError("ALREADY_REVERSED", "该成果事件已经纠正", 409);
    const asset = await loadAssetSnapshot(client, event.asset_id, true);
    if (!asset) throw new AssetEventError("NOT_FOUND", "素材不存在", 404);
    const result = await client.query<{ id: string }>(
      `INSERT INTO asset_events(asset_id,designer_user_id,actor_user_id,department_id,group_id,project_id,project_external_id,task_id,model_config_id,event_type,prompt,credits,rmb_cost,first_effective,idempotency_key,source_event_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'asset.event_reversed',$10,$11,$12,false,$13,$14,$15)
       RETURNING id`,
      [asset.id, asset.owner_user_id, actor.id, asset.department_id, event.group_id, asset.project_id, asset.project_external_id, asset.task_id, asset.model_config_id, asset.prompt ?? "", Number(asset.credits), Number(asset.rmb_cost), idempotencyKey, eventId, JSON.stringify({ reason })],
    );
    await client.query("COMMIT");
    return result.rows[0]!.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAssetEvents(db: Database, assetIds: string[]) {
  if (!assetIds.length) return new Map<string, { events: AssetEventRecord[]; projection: AssetProjection }>();
  const result = await db.query<{
    id: string; sequenceNo: number; assetId: string; designerUserId: string; actorUserId: string | null;
    departmentId: string | null; groupId: string | null; projectId: string | null;
    projectExternalId: string | null; taskId: string | null; modelConfigId: string | null;
    eventType: AssetEventType; firstEffective: boolean; sourceEventId: string | null;
    prompt: string; credits: number; rmbCost: number; occurredAt: string; metadata: Record<string, unknown>;
  }>(
    `SELECT id,sequence_no::int AS "sequenceNo",asset_id AS "assetId",designer_user_id AS "designerUserId",
            actor_user_id AS "actorUserId",department_id AS "departmentId",
            group_id AS "groupId",project_id AS "projectId",
            project_external_id AS "projectExternalId",task_id AS "taskId",
            model_config_id AS "modelConfigId",event_type AS "eventType",
            prompt,credits,rmb_cost::float8 AS "rmbCost",
            first_effective AS "firstEffective",source_event_id AS "sourceEventId",
            occurred_at AS "occurredAt",metadata
       FROM asset_events WHERE asset_id=ANY($1::uuid[])
      ORDER BY sequence_no`,
    [assetIds],
  );
  const grouped = new Map<string, AssetEventRecord[]>();
  for (const event of result.rows) grouped.set(event.assetId, [...(grouped.get(event.assetId) ?? []), event]);
  return new Map(assetIds.map((assetId) => {
    const events = grouped.get(assetId) ?? [];
    return [assetId, { events, projection: projectAssetEvents(events) }];
  }));
}

async function loadAssetSnapshot(client: PoolClient, assetId: string, lock: boolean) {
  const result = await client.query<AssetSnapshot>(
    `SELECT a.id,a.owner_user_id,a.department_id,
            (SELECT gm.group_id FROM group_memberships gm
              WHERE gm.user_id=a.owner_user_id AND gm.effective_at<=a.created_at
                AND (gm.ended_at IS NULL OR gm.ended_at>a.created_at)
              ORDER BY gm.effective_at DESC LIMIT 1) AS group_id,
            a.project_id,a.project_external_id,
            a.task_id,a.model_config_id,a.prompt,a.visibility_scope,COALESCE(t.credits,0)::int AS credits,
            COALESCE(t.rmb_cost,0)::text AS rmb_cost,a.created_at
       FROM assets a LEFT JOIN tasks t ON t.id=a.task_id
      WHERE a.id=$1 AND a.deleted_at IS NULL ${lock ? "FOR UPDATE OF a" : ""}`,
    [assetId],
  );
  return result.rows[0] ?? null;
}

async function hasEffectiveEvent(client: PoolClient, assetId: string, eventType: AssetEventType) {
  const result = await client.query(
    `SELECT 1 FROM asset_events e
      WHERE e.asset_id=$1 AND e.event_type=$2 AND e.first_effective=true
        AND NOT EXISTS(SELECT 1 FROM asset_events r WHERE r.event_type='asset.event_reversed' AND r.source_event_id=e.id)
      LIMIT 1`,
    [assetId, eventType],
  );
  return Boolean(result.rows[0]);
}

async function canAccessAsset(client: PoolClient, actor: SessionUser, asset: AssetSnapshot) {
  if (actor.role === "super_admin" || actor.id === asset.owner_user_id || asset.visibility_scope === "company") return true;
  if (actor.role === "department_admin" && actor.departmentId === asset.department_id) return true;
  if (actor.groupRole === "leader" && actor.groupId) {
    const group = await client.query(
      `SELECT 1 FROM group_memberships gm WHERE gm.group_id=$1 AND gm.user_id=$2
        AND gm.effective_at<=$3 AND (gm.ended_at IS NULL OR gm.ended_at>$3) LIMIT 1`,
      [actor.groupId, asset.owner_user_id, asset.created_at],
    );
    if (group.rows[0]) return true;
  }
  const result = await client.query(
    `SELECT 1 FROM asset_shares s
      WHERE s.asset_id=$1 AND (
        (s.department_id=$2 AND $2::uuid IS NOT NULL)
        OR s.user_id=$3
        OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=s.project_id AND pm.user_id=$3)
      ) LIMIT 1`,
    [asset.id, actor.departmentId, actor.id],
  );
  return Boolean(result.rows[0]);
}

async function attachAssetToProject(client: PoolClient, actor: SessionUser, asset: AssetSnapshot, projectId?: string) {
  if (!projectId) throw new AssetEventError("PROJECT_REQUIRED", "加入正式项目时必须选择项目", 400);
  const allowed = await client.query(
    `SELECT p.id FROM projects p
      WHERE p.id=$1 AND (p.owner_user_id=$2 OR EXISTS(
        SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=$2
      ))`,
    [projectId, actor.id],
  );
  if (!allowed.rows[0]) throw new AssetEventError("PROJECT_NOT_FOUND", "项目不存在或无权加入", 404);
  await client.query("UPDATE assets SET project_id=$1,updated_at=now() WHERE id=$2", [projectId, asset.id]);
  asset.project_id = projectId;
}

function isScoringEvent(eventType: AssetEventType, actor: SessionUser | null, asset: AssetSnapshot) {
  if (!(eventType in scoreByType)) return false;
  if (eventType === "asset.downloaded") return actor?.role === "designer" && actor.id === asset.owner_user_id;
  if (eventType === "asset.exported") return actor?.role === "designer" && actor.id === asset.owner_user_id;
  if (eventType === "asset.reused") return Boolean(actor && actor.id !== asset.owner_user_id);
  return true;
}

function assertEventPermission(actor: SessionUser | null, eventType: AssetEventType, asset: AssetSnapshot) {
  if (eventType === "asset.generated") {
    if (actor) throw new AssetEventError("FORBIDDEN", "生成事件只能由系统写入", 403);
    return;
  }
  if (!actor) throw new AssetEventError("UNAUTHENTICATED", "请先登录", 401);
  if (["asset.adopted", "asset.delivered", "asset.pending", "asset.rejected"].includes(eventType)) {
    if (!canManageResultState(actor, asset.owner_user_id, asset.department_id, asset.group_id)) throw new AssetEventError("FORBIDDEN", "只有对应管理员或组长可以管理成果状态", 403);
    return;
  }
  if (eventType === "asset.reused") return;
  if (["asset.downloaded", "asset.exported"].includes(eventType) && actor.role !== "designer") return;
  if (actor.id !== asset.owner_user_id) throw new AssetEventError("FORBIDDEN", "只能操作自己的素材", 403);
}

export class AssetEventError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}
