import type { Database } from "./db";
import { projectAssetEvents, type AssetEventRecord, type AssetEventType } from "./asset-events";
import { designDirections, type DesignDirection } from "./design-direction";
import type { SessionUser } from "./types";

export type PerformanceFilters = {
  from: string;
  to: string;
  departmentId?: string;
  groupId?: string;
  userId?: string;
};
export type PerformanceOptions = {
  users: Array<{ value: string; label: string; departmentId: string | null; groupId: string | null }>;
  departments: Array<{ value: string; label: string }>;
  groups: Array<{ value: string; label: string; departmentId: string }>;
};

type TaskRow = {
  id: string; userId: string; userName: string; departmentId: string | null; departmentName: string | null;
  groupId: string | null; operationType: string; modelName: string | null; prompt: string; status: string;
  credits: number; rmbCost: number; requestedOutputs: number; queuedAt: string; startedAt: string | null;
  completedAt: string | null; failureReason: string | null; batchId: string | null; deadlineAt: string | null;
};

type AssetRow = {
  id: string; userId: string; userName: string; departmentId: string | null; departmentName: string | null;
  groupId: string | null; groupName: string | null; taskId: string | null; projectId: string | null;
  projectName: string | null; operationType: string | null; modelName: string | null; prompt: string;
  primaryDirection: DesignDirection | null; secondaryDirections: DesignDirection[]; directionRuleVersion: string | null;
  directionEvidence: Record<string, unknown>; adminDirectionTags: string[]; createdAt: string;
  taskDeadlineAt: string | null; projectDeadlineAt: string | null;
};

type BatchRow = { id: string; totalItems: number; completedItems: number; failedItems: number; status: string };

export async function getPerformanceDashboard(db: Database, actor: SessionUser, filters: PerformanceFilters) {
  return getPerformanceDashboardInternal(db, actor, filters, true);
}

async function getPerformanceDashboardInternal(db: Database, actor: SessionUser, filters: PerformanceFilters, includeComparisons: boolean): Promise<ReturnType<typeof aggregatePerformance> & { comparisons: PerformanceComparisons | null }> {
  const taskScope = buildScope(actor, filters, "t", "t.queued_at");
  const assetScope = buildScope(actor, filters, "a", "a.created_at", "ge.group_id");
  const [tasksResult, assetsResult, batchesResult, optionsResult] = await Promise.all([
    db.query<TaskRow>(
      `SELECT t.id,t.user_id AS "userId",u.display_name AS "userName",t.department_id AS "departmentId",
              d.name AS "departmentName",gm.group_id AS "groupId",t.operation_type AS "operationType",
              m.name AS "modelName",t.prompt,t.status,t.credits,t.rmb_cost::float8 AS "rmbCost",
              CASE WHEN coalesce(t.parameters->>'quantity','') ~ '^[0-9]+$'
                THEN greatest(1,(t.parameters->>'quantity')::int) ELSE 1 END AS "requestedOutputs",
              t.queued_at AS "queuedAt",t.started_at AS "startedAt",t.completed_at AS "completedAt",
              t.failure_reason AS "failureReason",t.batch_id AS "batchId",t.deadline_at AS "deadlineAt"
         FROM tasks t JOIN users u ON u.id=t.user_id LEFT JOIN departments d ON d.id=t.department_id
         LEFT JOIN model_configs m ON m.id=t.model_config_id
         LEFT JOIN LATERAL (SELECT group_id FROM group_memberships x WHERE x.user_id=t.user_id
           AND x.effective_at<=t.queued_at AND (x.ended_at IS NULL OR x.ended_at>t.queued_at) LIMIT 1) gm ON true
        ${taskScope.where} AND t.operation_type IN ('image_generation','upscale','remove_background','inpaint','batch_image','seamless_stitch')
        ORDER BY t.queued_at`, taskScope.values,
    ),
    db.query<AssetRow>(
      `SELECT a.id,a.owner_user_id AS "userId",u.display_name AS "userName",a.department_id AS "departmentId",
              d.name AS "departmentName",ge.group_id AS "groupId",g.name AS "groupName",a.task_id AS "taskId",
              a.project_id AS "projectId",p.name AS "projectName",a.operation_type AS "operationType",
              m.name AS "modelName",coalesce(a.prompt,'') AS prompt,a.primary_direction AS "primaryDirection",
              a.secondary_directions AS "secondaryDirections",a.direction_rule_version AS "directionRuleVersion",
              a.direction_evidence AS "directionEvidence",a.admin_direction_tags AS "adminDirectionTags",
              a.created_at AS "createdAt",t.deadline_at AS "taskDeadlineAt",p.deadline_at AS "projectDeadlineAt"
         FROM assets a JOIN users u ON u.id=a.owner_user_id LEFT JOIN departments d ON d.id=a.department_id
         LEFT JOIN tasks t ON t.id=a.task_id LEFT JOIN projects p ON p.id=a.project_id
         LEFT JOIN model_configs m ON m.id=a.model_config_id
         LEFT JOIN asset_events ge ON ge.asset_id=a.id AND ge.event_type='asset.generated' AND ge.first_effective=true
         LEFT JOIN designer_groups g ON g.id=ge.group_id
        ${assetScope.where} AND a.status='ready' AND a.deleted_at IS NULL AND a.kind='image' AND a.source IN ('generation','edit')
        ORDER BY a.created_at`, assetScope.values,
    ),
    db.query<BatchRow>(
      `SELECT DISTINCT b.id,b.total_items AS "totalItems",b.completed_items AS "completedItems",
              b.failed_items AS "failedItems",b.status FROM batch_tasks b JOIN tasks t ON t.batch_id=b.id
        ${taskScope.where} AND t.operation_type IN ('image_generation','upscale','remove_background','inpaint','batch_image','seamless_stitch')`, taskScope.values,
    ),
    getPerformanceOptions(db, actor),
  ]);

  const assets = assetsResult.rows;
  const assetIds = assets.map((asset) => asset.id);
  const events = assetIds.length ? await db.query<AssetEventRecord>(
    `SELECT id,asset_id AS "assetId",designer_user_id AS "designerUserId",actor_user_id AS "actorUserId",
            department_id AS "departmentId",group_id AS "groupId",project_id AS "projectId",
            project_external_id AS "projectExternalId",task_id AS "taskId",model_config_id AS "modelConfigId",
            event_type AS "eventType",prompt,credits,rmb_cost::float8 AS "rmbCost",first_effective AS "firstEffective",
            source_event_id AS "sourceEventId",occurred_at AS "occurredAt",metadata
       FROM asset_events WHERE asset_id=ANY($1::uuid[]) ORDER BY sequence_no`, [assetIds],
  ) : { rows: [] as AssetEventRecord[] };
  const dashboard = aggregatePerformance(tasksResult.rows, assets, events.rows, batchesResult.rows, filters, optionsResult);
  if (!includeComparisons || !filters.userId) return { ...dashboard, comparisons: null };
  const selected = optionsResult.users.find((item) => item.value === filters.userId);
  const previousRange = previousCalendarMonth(filters.to);
  const [previous, groupPeers, departmentPeers] = await Promise.all([
    getPerformanceDashboardInternal(db, actor, { ...previousRange, userId: filters.userId }, false),
    selected?.groupId ? getPerformanceDashboardInternal(db, actor, { from: filters.from, to: filters.to, groupId: selected.groupId }, false) : null,
    selected?.departmentId ? getPerformanceDashboardInternal(db, actor, { from: filters.from, to: filters.to, departmentId: selected.departmentId }, false) : null,
  ]);
  return { ...dashboard, comparisons: {
    previousMonth: previous.designers[0] ?? null,
    sameGroupAverage: groupPeers ? averageDesignerSummaries(groupPeers.designers) : null,
    departmentAverage: departmentPeers ? averageDesignerSummaries(departmentPeers.designers) : null,
  } };
}

type DesignerSummary = ReturnType<typeof designerSummary>;
type PerformanceComparisons = { previousMonth: DesignerSummary | null; sameGroupAverage: DesignerSummary | null; departmentAverage: DesignerSummary | null };

export function aggregatePerformance(tasks: TaskRow[], assets: AssetRow[], events: AssetEventRecord[], batches: BatchRow[], filters: PerformanceFilters, options: PerformanceOptions) {
  const eventMap = new Map<string, AssetEventRecord[]>();
  for (const event of events) eventMap.set(event.assetId, [...(eventMap.get(event.assetId) ?? []), event]);
  const projections = new Map(assets.map((asset) => [asset.id, projectAssetEvents(eventMap.get(asset.id) ?? [])]));
  const terminal = tasks.filter((task) => ["success", "failed", "cancelled"].includes(task.status));
  const successes = tasks.filter((task) => task.status === "success");
  const failed = tasks.filter((task) => task.status === "failed");
  const cancelled = tasks.filter((task) => task.status === "cancelled");
  const totalCredits = successes.reduce((sum, task) => sum + task.credits, 0);
  const totalRmbCost = successes.reduce((sum, task) => sum + task.rmbCost, 0);
  const activeDays = new Set(assets.map((asset) => shanghaiDate(asset.createdAt))).size;
  const naturalDays = Math.max(1, Math.ceil((new Date(filters.to).getTime() - new Date(filters.from).getTime()) / 86_400_000));
  const durations = terminal.flatMap((task) => task.startedAt && task.completedAt ? [new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()] : []);
  const adoptedAssets = assets.filter((asset) => hasEffective(eventMap.get(asset.id), "asset.adopted"));
  const deliveredWithDeadline = assets.flatMap((asset) => {
    const deadline = asset.taskDeadlineAt ?? asset.projectDeadlineAt;
    const delivered = firstEffectiveTime(eventMap.get(asset.id), "asset.delivered");
    return deadline && delivered ? [{ deadline, delivered }] : [];
  });
  const reworked = adoptedAssets.filter((asset) => {
    const adoptedAt = firstEffectiveTime(eventMap.get(asset.id), "asset.adopted");
    const adoptedTimestamp = adoptedAt ? new Date(adoptedAt).getTime() : null;
    return (eventMap.get(asset.id) ?? []).some((event) => event.firstEffective
      && ["asset.edited", "asset.reused"].includes(event.eventType)
      && adoptedTimestamp !== null && new Date(event.occurredAt).getTime() > adoptedTimestamp);
  });
  const funnelTypes: Array<[string, AssetEventType | null]> = [
    ["generated", null], ["candidate", "asset.candidate_added"], ["reused", "asset.reused"],
    ["downloaded", "asset.downloaded"], ["adopted", "asset.adopted"], ["delivered", "asset.delivered"],
  ];
  const funnel = funnelTypes.map(([stage, type]) => {
    const count = type ? assets.filter((asset) => hasEffective(eventMap.get(asset.id), type)).length : assets.length;
    return { stage, count, rate: percentage(count, assets.length) };
  });
  const directions = designDirections.map((direction) => ({
    direction,
    count: assets.filter((asset) => asset.primaryDirection === direction).length,
    rate: percentage(assets.filter((asset) => asset.primaryDirection === direction).length, assets.length),
  })).filter((item) => item.count > 0);
  const trendDays = dateKeys(filters.from, filters.to);
  const trend = trendDays.map((date) => {
    const dayAssets = assets.filter((asset) => shanghaiDate(asset.createdAt) === date);
    const dayTasks = tasks.filter((task) => shanghaiDate(task.queuedAt) === date);
    return { date, outputs: dayAssets.length, success: dayTasks.filter((task) => task.status === "success").length,
      failed: dayTasks.filter((task) => task.status === "failed").length,
      credits: dayTasks.filter((task) => task.status === "success").reduce((sum, task) => sum + task.credits, 0) };
  });
  const userIds = [...new Set([...tasks.map((task) => task.userId), ...assets.map((asset) => asset.userId)])];
  const designers = userIds.map((userId) => designerSummary(userId, tasks, assets, eventMap, projections));
  const failureReasons = Object.entries(countBy(failed, (task) => task.failureReason || "未知原因"))
    .map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10);
  const batchTotal = batches.reduce((sum, batch) => sum + batch.totalItems, 0);
  const batchCompleted = batches.reduce((sum, batch) => sum + batch.completedItems + batch.failedItems, 0);
  return {
    period: filters,
    metrics: {
      requestedOutputs: tasks.reduce((sum, task) => sum + task.requestedOutputs, 0), validOutputs: assets.length,
      naturalDailyAverage: round(assets.length / naturalDays), activeDailyAverage: activeDays ? round(assets.length / activeDays) : null,
      successCount: successes.length, failedCount: failed.length, cancelledCount: cancelled.length,
      successRate: percentage(successes.length, terminal.length), batchCompletionRate: percentage(batchCompleted, batchTotal),
      averageDurationSeconds: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length / 1000) : null,
      reworkRate: percentage(reworked.length, adoptedAssets.length), onTimeDeliveryRate: percentage(deliveredWithDeadline.filter((item) => new Date(item.delivered).getTime() <= new Date(item.deadline).getTime()).length, deliveredWithDeadline.length),
      totalCredits, totalRmbCost: round(totalRmbCost), averageCreditsPerOutput: assets.length ? round(totalCredits / assets.length) : null,
      averageCostPerOutput: assets.length ? round(totalRmbCost / assets.length) : null,
      averageCostPerAdopted: adoptedAssets.length ? round(totalRmbCost / adoptedAssets.length) : null,
      downloadRate: funnel.find((item) => item.stage === "downloaded")!.rate,
      averageUsabilityScore: assets.length ? round([...projections.values()].reduce((sum, item) => sum + item.usabilityScore, 0) / assets.length) : null,
    },
    trend, directions, funnel, designers, failureReasons,
    tasks: tasks.slice().sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, 100),
    assets: assets.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map((asset) => ({ ...asset, ...projections.get(asset.id) })),
    options,
  };
}

function designerSummary(userId: string, tasks: TaskRow[], assets: AssetRow[], eventMap: Map<string, AssetEventRecord[]>, projections: Map<string, ReturnType<typeof projectAssetEvents>>) {
  const userTasks = tasks.filter((task) => task.userId === userId);
  const userAssets = assets.filter((asset) => asset.userId === userId);
  const successful = userTasks.filter((task) => task.status === "success");
  const terminal = userTasks.filter((task) => ["success", "failed", "cancelled"].includes(task.status));
  const adopted = userAssets.filter((asset) => hasEffective(eventMap.get(asset.id), "asset.adopted")).length;
  const delivered = userAssets.filter((asset) => hasEffective(eventMap.get(asset.id), "asset.delivered")).length;
  const downloaded = userAssets.filter((asset) => hasEffective(eventMap.get(asset.id), "asset.downloaded")).length;
  const reused = userAssets.filter((asset) => hasEffective(eventMap.get(asset.id), "asset.reused")).length;
  const credits = successful.reduce((sum, task) => sum + task.credits, 0);
  const cost = successful.reduce((sum, task) => sum + task.rmbCost, 0);
  const sample = userAssets[0] ?? null;
  return { userId, userName: sample?.userName ?? userTasks[0]?.userName ?? "-", departmentName: sample?.departmentName ?? userTasks[0]?.departmentName ?? "-",
    groupName: sample?.groupName ?? null, outputs: userAssets.length, successRate: percentage(successful.length, terminal.length),
    downloadRate: percentage(downloaded, userAssets.length), reuseRate: percentage(reused, userAssets.length), adoptionRate: percentage(adopted, userAssets.length),
    deliveryRate: percentage(delivered, userAssets.length), usabilityScore: userAssets.length ? round(userAssets.reduce((sum, asset) => sum + (projections.get(asset.id)?.usabilityScore ?? 0), 0) / userAssets.length) : null,
    credits, rmbCost: round(cost), topDirection: topKey(userAssets, (asset) => asset.primaryDirection ?? "unclassified") };
}

function averageDesignerSummaries(designers: DesignerSummary[]): DesignerSummary | null {
  if (!designers.length) return null;
  const average = (key: keyof DesignerSummary) => {
    const values = designers.map((item) => item[key]).filter((value): value is number => typeof value === "number");
    return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  return {
    userId: "average", userName: "平均", departmentName: "-", groupName: "-", topDirection: "unclassified",
    outputs: average("outputs") ?? 0, successRate: average("successRate"), downloadRate: average("downloadRate"),
    reuseRate: average("reuseRate"), adoptionRate: average("adoptionRate"), deliveryRate: average("deliveryRate"),
    usabilityScore: average("usabilityScore"), credits: average("credits") ?? 0, rmbCost: average("rmbCost") ?? 0,
  };
}

async function getPerformanceOptions(db: Database, actor: SessionUser) {
  const values: unknown[] = [];
  const clauses = ["u.role='designer'"];
  if (actor.role === "department_admin") { values.push(actor.departmentId); clauses.push(`u.department_id=$${values.length}`); }
  if (actor.role === "designer") { values.push(actor.groupId); clauses.push(`gm.group_id=$${values.length}`); }
  const users = await db.query(`SELECT DISTINCT u.id AS value,u.display_name AS label,u.department_id AS "departmentId",gm.group_id AS "groupId"
    FROM users u LEFT JOIN group_memberships gm ON gm.user_id=u.id AND gm.ended_at IS NULL WHERE ${clauses.join(" AND ")} ORDER BY label`, values);
  const departments = actor.role === "super_admin" ? await db.query("SELECT id AS value,name AS label FROM departments ORDER BY name") : { rows: [] };
  const groups = await db.query(`SELECT g.id AS value,g.name AS label,g.department_id AS "departmentId" FROM designer_groups g
    WHERE g.status='active' ${actor.role === "department_admin" ? "AND g.department_id=$1" : actor.role === "designer" ? "AND g.id=$1" : ""} ORDER BY g.name`,
    actor.role === "super_admin" ? [] : [actor.role === "designer" ? actor.groupId : actor.departmentId]);
  return { users: users.rows, departments: departments.rows, groups: groups.rows } as PerformanceOptions;
}

function buildScope(actor: SessionUser, filters: PerformanceFilters, alias: string, timeColumn: string, groupColumn?: string) {
  const values: unknown[] = [filters.from, filters.to];
  const clauses = [`${timeColumn}>=$1::timestamptz`, `${timeColumn}<$2::timestamptz`];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
  if (actor.role === "department_admin") add(`${alias}.department_id=?`, actor.departmentId);
  if (actor.role === "designer") add(`${groupColumn ?? `gm.group_id` }=?`, actor.groupId);
  if (actor.role !== "designer" && filters.departmentId) add(`${alias}.department_id=?`, filters.departmentId);
  if (actor.role !== "designer" && filters.groupId) add(`${groupColumn ?? "gm.group_id"}=?`, filters.groupId);
  if (filters.userId) add(`${alias}.${alias === "a" ? "owner_user_id" : "user_id"}=?`, filters.userId);
  return { where: `WHERE ${clauses.join(" AND ")}`, values };
}

function hasEffective(events: AssetEventRecord[] | undefined, type: AssetEventType) { return (events ?? []).some((event) => event.eventType === type && event.firstEffective); }
function firstEffectiveTime(events: AssetEventRecord[] | undefined, type: AssetEventType) { return (events ?? []).filter((event) => event.eventType === type && event.firstEffective).map((event) => event.occurredAt).sort()[0] ?? null; }
function percentage(numerator: number, denominator: number) { return denominator ? round(numerator / denominator * 100) : null; }
function round(value: number) { return Math.round(value * 100) / 100; }
function shanghaiDate(value: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function dateKeys(from: string, to: string) { const result: string[] = []; for (let cursor = new Date(from); cursor < new Date(to) && result.length < 367; cursor = new Date(cursor.getTime() + 86_400_000)) result.push(shanghaiDate(cursor.toISOString())); return [...new Set(result)]; }
function countBy<T>(items: T[], key: (item: T) => string) { return items.reduce<Record<string, number>>((result, item) => { const value = key(item); result[value] = (result[value] ?? 0) + 1; return result; }, {}); }
function topKey<T>(items: T[], key: (item: T) => string) { return Object.entries(countBy(items, key)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; }
export function previousCalendarMonth(to: string) {
  const anchor = shanghaiDate(new Date(new Date(to).getTime() - 1).toISOString());
  const [year, month] = anchor.slice(0, 7).split("-").map(Number);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return {
    from: new Date(`${previousYear}-${String(previousMonth).padStart(2, "0")}-01T00:00:00+08:00`).toISOString(),
    to: new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+08:00`).toISOString(),
  };
}
