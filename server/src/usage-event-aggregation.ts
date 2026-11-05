import { UsageError } from "./usage-analytics";
import type { Fact } from "./usage-analytics-v2";
import type { UsageQueryClient } from "./usage-rollup-reader";
import type { UsageV2Profile } from "../../shared/usage-analytics-v2";

const MAX_BYTES = 32 * 1024 * 1024;
export type WeightedUsageFact = { kind: string; eventWeight?: number };
/** Only database-grouped historical events may carry weight. Tasks, chats and
 * persisted/source facts always remain one original record per item. */
export function usageFactWeight(fact: WeightedUsageFact) {
  if (fact.kind !== "event" || fact.eventWeight === undefined) return 1;
  if (!Number.isSafeInteger(fact.eventWeight) || fact.eventWeight < 1)
    throw new UsageError("USAGE_PROJECTION_INVALID", "统计事件权重无效，未返回不完整结果", 503);
  return fact.eventWeight;
}
export const usageFactCount = (facts: readonly WeightedUsageFact[]) =>
  facts.reduce((sum, fact) => sum + usageFactWeight(fact), 0);

export type UsageReadSegment = {
  cte: string;
  where: string;
  values: unknown[];
  source: "daily" | "live";
};
const tooLarge = () => new UsageError("USAGE_SCOPE_TOO_LARGE", "当前范围的单条事实或展开查询结果超过32MiB安全预算；请缩短日期或增加筛选，未截断数据", 422);

/** Filter first, then group only interchangeable historical event facts. The
 * complete projected payload (including user, department and all parameters)
 * remains in the key, except the per-record id/time. Beijing DATE+hour and the
 * exact maximum instant preserve distinct user-days, heatmaps and last activity.
 * Raw activity pagination is deliberately a separate query, never these rows.
 *
 * PostgreSQL measures both the original maximum row and the actual expanded
 * grouped result BEFORE returning any facts. This is not compressed-wire size,
 * chunking, a larger budget, or collecting all raw events in the application.
 */
export async function readUsageDailyEventFacts(
  client: UsageQueryClient,
  segment: UsageReadSegment,
  departmentColumn: string,
  remainingBytes: number,
): Promise<{ facts: Fact[]; bytes: number }> {
  const projection = `f.payload || jsonb_build_object('department_id',f.${departmentColumn})`;
  const result = (await client.query<{ bytes: string; largest: number; facts: Fact[] | null }>(`${segment.cte},
    selected AS MATERIALIZED (
      SELECT ${projection} AS fact,
        f.kind='event' AND f.payload->>'kind'='event'
          AND COALESCE(f.payload->'outputs','[]'::jsonb)='[]'::jsonb AS mergeable
      FROM facts f ${segment.where}
    ), event_groups AS (
      SELECT (fact-'id'-'occurred_at'-'eventWeight') || jsonb_build_object(
        'id',min(fact->>'id'),'occurred_at',max((fact->>'occurred_at')::timestamptz),
        'eventWeight',count(*)) AS fact
      FROM selected WHERE mergeable
      GROUP BY fact-'id'-'occurred_at'-'eventWeight',
        date_trunc('hour',(fact->>'occurred_at')::timestamptz AT TIME ZONE 'Asia/Shanghai')
    ), returned AS MATERIALIZED (
      SELECT fact FROM event_groups
      UNION ALL SELECT fact-'eventWeight' AS fact FROM selected WHERE NOT COALESCE(mergeable,false)
    ), budget AS (
      SELECT COALESCE((SELECT max(octet_length(fact::text)) FROM selected),0) AS largest,
        COALESCE(sum(octet_length(fact::text)),0)+2*GREATEST(count(*)-1,0)+2 AS bytes FROM returned
    )
    SELECT bytes::text,largest,
      CASE WHEN largest<=${MAX_BYTES} AND bytes<=${Math.max(0, Math.floor(remainingBytes))}
        THEN (SELECT COALESCE(jsonb_agg(fact),'[]'::jsonb) FROM returned) ELSE NULL END AS facts
    FROM budget`, segment.values)).rows[0]!;
  const bytes = Number(result.bytes);
  if (result.largest > MAX_BYTES || bytes > remainingBytes || result.facts === null) throw tooLarge();
  for (const fact of result.facts) usageFactWeight(fact);
  return { facts: result.facts, bytes };
}

/** Original records, true SQL LIMIT/OFFSET, and exact count under the same
 * repeatable-read snapshot as statistics. Never expand weighted events into
 * invented identities/timestamps. Today's already-bounded source rows are used
 * only to attach the existing deduplicated output semantics to selected IDs. */
export async function readUsageActivityPage(
  client: UsageQueryClient,
  segments: UsageReadSegment[],
  liveFacts: Fact[],
  pagination: { page: number; pageSize: number },
  remainingBytes: number,
): Promise<{ page: UsageV2Profile["activityPage"]; bytes: number }> {
  const values: unknown[] = [];
  const sources = segments.map(segment => {
    const shift = values.length;
    values.push(...segment.values);
    const source = segment.source;
    const sql = `${segment.cte} SELECT '${source}'::text AS source,f.kind,${source === "daily" ? "f.fact_id" : "f.id"} AS id,f.occurred_at,${source === "daily" ? "f.day" : "NULL::date"} AS fact_day
      FROM facts f ${segment.where} AND ${source === "daily" ? "f.payload->>'action'" : "f.action"}<>'gap'`;
    return `(${sql.replace(/\$(\d+)/g, (_, number: string) => `$${Number(number) + shift}`)})`;
  });
  if (!sources.length) return { page: { records: [], pagination: { ...pagination, total: 0 } }, bytes: 2 };
  const limit = pagination.pageSize, offset = (pagination.page - 1) * pagination.pageSize;
  const result = (await client.query<{ total: string; bytes: string; records: Array<{ source: string; id: string; kind: Fact["kind"]; record: UsageV2Profile["activityPage"]["records"][number] | null }> | null }>(`
    WITH candidates AS MATERIALIZED (${sources.join(" UNION ALL ")}),
    selected AS (SELECT * FROM candidates ORDER BY occurred_at DESC,id COLLATE "C" LIMIT ${limit} OFFSET ${offset}),
    returned AS MATERIALIZED (
      SELECT s.source,s.id,s.kind,s.occurred_at,
        CASE WHEN s.source='daily' THEN jsonb_build_object(
          'id',s.kind||':'||s.id,'kind',s.kind,'occurredAt',p.payload->'occurred_at',
          'boardKey',p.payload->'board_key','action',p.payload->'action',
          'modelConfigId',p.payload->'model_config_id','status',p.payload->'status',
          'generatedImages',CASE WHEN jsonb_typeof(p.payload->'outputs')='array' THEN jsonb_array_length(p.payload->'outputs') ELSE 0 END,
          'bookedCny',p.payload->'booked','totalMs',p.payload->'total_ms') ELSE NULL END AS record
      FROM selected s LEFT JOIN usage_daily_facts p
        ON s.source='daily' AND p.kind=s.kind AND p.fact_id=s.id
          AND p.day=s.fact_day
    ), budget AS (SELECT COALESCE(sum(octet_length(to_jsonb(r)::text)),0)+2*GREATEST(count(*)-1,0)+2 AS bytes FROM returned r)
    SELECT (SELECT count(*)::text FROM candidates) AS total,bytes::text,
      CASE WHEN bytes<=${Math.max(0, Math.floor(remainingBytes))}
        THEN (SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.occurred_at DESC,r.id COLLATE "C"),'[]'::jsonb) FROM returned r) ELSE NULL END AS records
    FROM budget`, values)).rows[0]!;
  const bytes = Number(result.bytes);
  if (bytes > remainingBytes || result.records === null) throw tooLarge();
  const live = new Map(liveFacts.map(fact => [`${fact.kind}:${fact.id}`, fact]));
  const records = result.records.map(row => {
    if (row.source === "daily" && row.record) return { ...row.record, occurredAt: new Date(row.record.occurredAt).toISOString() };
    const fact = live.get(`${row.kind}:${row.id}`);
    if (!fact) throw new UsageError("USAGE_PROJECTION_INVALID", "分页明细与本次观察范围不一致，未返回不完整结果", 503);
    return {
      id: `${fact.kind}:${fact.id}`, kind: fact.kind, occurredAt: new Date(fact.occurred_at).toISOString(),
      boardKey: fact.board_key, action: fact.action, modelConfigId: fact.model_config_id,
      status: fact.status, generatedImages: fact.outputs?.length ?? 0,
      bookedCny: fact.booked, totalMs: fact.total_ms ?? null,
    };
  });
  const expandedBytes = Buffer.byteLength(JSON.stringify(records));
  if (expandedBytes > remainingBytes) throw tooLarge();
  return { page: { records, pagination: { ...pagination, total: Number(result.total) } }, bytes: Math.max(bytes, expandedBytes) };
}
