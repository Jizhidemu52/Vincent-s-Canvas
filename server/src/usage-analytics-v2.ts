import { z } from "zod";
import type { Database } from "./db";
import {
  UsageError,
  safeUsageParameters,
  usageBoardLabels,
  usageControlLabel,
} from "./usage-analytics";
import {
  classifyUsageFailure,
  USAGE_FAILURE_RULE_VERSION,
  usageFailureLabels,
} from "./usage-failure-reasons";
import { usageInsights } from "./usage-insights";
import { readUsageReleaseContext, usageControlDaily } from "./usage-release-context";
import type { UsageReleaseContext } from "../../shared/usage-release-context";
import type { UsagePeopleComparison, UsagePeopleTeamBaseline } from "../../shared/usage-people-comparison";
import { readImageResultMetadata } from "./image-result-variants";
import { readUsageDailyEventFacts, readUsageActivityPage, usageFactCount, usageFactWeight, type UsageReadSegment } from "./usage-event-aggregation";
import { readUsageSnapshot, usageDailyFactsCte, usageDayStart, type UsageQueryClient } from "./usage-rollup-reader";
import {
  USAGE_V2_PEOPLE_SORTS,
  type UsageV2Scope,
  type UsageV2Query,
  type UsageV2Metric,
  type UsageV2Metrics,
  type UsageV2Meta,
  type UsageV2Dimension,
  type UsageV2Person,
  type UsageV2ResultUse,
  type UsageV2OptimizationCosts,
  type UsageV2Overview,
  type UsageV2People,
  type UsageV2Profile,
  type UsageV2Boards,
  type UsageV2Models,
  type UsageV2Quality,
  type UsageV2Flows,
  type UsageV2Options,
  type UsageV2Parameter,
  type UsageV2LatencyDistribution,
} from "../../shared/usage-analytics-v2";

const DAY = 86_400_000;
export const USAGE_V2_METRIC_VERSION = "existing-facts-v2.2";
const METRIC_VERSION = USAGE_V2_METRIC_VERSION;
const MAX_FACTS = 50000,
  MAX_FACT_BYTES = 32 * 1024 * 1024,
  MAX_RELATED_ROWS = 100000;
const IMAGE_OPERATIONS = new Set([
  "image_generation",
  "inpaint",
  "upscale",
  "remove_background",
  "batch_image",
  "seamless_stitch",
]);
const operationSchema = z.enum([
  "image_generation",
  "inpaint",
  "upscale",
  "batch_image",
  "seamless_stitch",
  "remove_background",
  "video_generation",
  "audio_generation",
  "chat",
]);
const csv = (item: z.ZodType<string>) =>
  z
    .preprocess(
      (value) => (typeof value === "string" ? value.split(",") : value),
      z.array(item).min(1).max(500),
    )
    .transform((value) => [...new Set(value)])
    .optional();
const date = z.string().datetime({ offset: true });
export const usageV2QuerySchema = z
  .object({
    from: date.optional(),
    to: date.optional(),
    timezone: z.literal("Asia/Shanghai").optional(),
    compare: z
      .enum(["none", "previous_period", "previous_year"])
      .default("previous_period"),
    departmentBasis: z.enum(["at_event", "current"]).default("at_event"),
    departmentIds: csv(z.string().uuid()),
    userIds: csv(z.string().uuid()),
    modelConfigIds: csv(z.string().uuid()),
    boardKeys: csv(
      z.string().refine((value) => Object.hasOwn(usageBoardLabels, value)),
    ),
    operationTypes: csv(operationSchema),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    sort: z.enum(USAGE_V2_PEOPLE_SORTS).default("lastActivity"),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .refine(
    (value) =>
      !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to),
    "日期范围无效",
  );
export type ParsedUsageV2Query = z.infer<typeof usageV2QuerySchema>;
export function resolveUsageV2Scope(
  query: UsageV2Query,
  now = new Date(),
): UsageV2Scope {
  const to = query.to ?? now.toISOString();
  const from = query.from ?? new Date(Date.parse(to) - 30 * DAY).toISOString();
  const duration = Date.parse(to) - Date.parse(from);
  if (
    !(duration > 0) ||
    duration > 366 * DAY ||
    Date.parse(to) > now.getTime() + DAY
  )
    throw new UsageError(
      "USAGE_RANGE_INVALID",
      "日期范围必须大于 0、最多 366 天，结束不能晚于明天",
    );
  const {
    departmentIds,
    userIds,
    boardKeys,
    modelConfigIds,
    operationTypes,
    search,
  } = query;
  return {
    from,
    to,
    timezone: "Asia/Shanghai",
    compare: query.compare ?? "previous_period",
    departmentBasis: query.departmentBasis ?? "at_event",
    departmentIds,
    userIds,
    boardKeys,
    modelConfigIds,
    operationTypes,
    search,
  };
}
function previousYear(value: string) {
  const date = new Date(Date.parse(value) + 8 * 3600000);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0); // leap-day clamps to Feb 28
  return new Date(date.getTime() - 8 * 3600000).toISOString();
}
export function usageComparisonScope(scope: UsageV2Scope): UsageV2Scope | null {
  if (scope.compare === "none") return null;
  const length = Date.parse(scope.to) - Date.parse(scope.from);
  const from =
    scope.compare === "previous_year"
      ? previousYear(scope.from)
      : new Date(Date.parse(scope.from) - length).toISOString();
  const to =
    scope.compare === "previous_year" ? previousYear(scope.to) : scope.from;
  // Feb 28 -> Feb 29 in a leap year must not collapse to an empty prior-year window.
  return {
    ...scope,
    compare: "none",
    from,
    to:
      Date.parse(to) > Date.parse(from)
        ? to
        : new Date(Date.parse(from) + length).toISOString(),
  };
}
export type Fact = {
  id: string;
  user_id: string;
  department_id: string | null;
  event_department_id?: string | null;
  kind: "task" | "event" | "chat";
  board_key: string | null;
  model_config_id: string | null;
  operation_type: string;
  action: string;
  control_key: string | null;
  status: string;
  occurred_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  parameters: Record<string, unknown>;
  result_urls: unknown[];
  booked: string | null;
  failure_reason: string | null;
  failure_category?: string;
  attempts: number;
  optimized: boolean;
  compilation_id: string | null;
  batch_linked?: boolean | null;
  source_count?: number | null;
  total_ms?: number | null;
  wait_ms?: number | null;
  run_ms?: number | null;
  outputs?: Output[];
  /** Internal, query-only count of interchangeable historical event records. */
  eventWeight?: number;
};
type Output = {
  key: string;
  linked: boolean;
  events: Array<{
    type: string;
    evidence: "server_confirmed" | "client_reported";
  }>;
};
type Person = {
  id: string;
  display_name: string;
  department_id: string | null;
  department_name: string | null;
};
type Asset = {
  id: string;
  task_id: string | null;
  owner_user_id: string;
  kind: string;
  mime_type: string;
  image_result: {
    version?: number;
    role?: string;
    resultIndex?: number;
    original?: { assetId?: string };
    export?: { assetId?: string };
  } | null;
};
type Compilation = {
  id: string;
  reused_from_id: string | null;
  status: string;
  currency: string | null;
  actual: string | null;
  estimated: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
};
type Data = {
  facts: Fact[];
  comparisonFacts: Fact[];
  people: Person[];
  departments: Map<string, string>;
  models: Map<string, string>;
  compilations: Compilation[];
  scope: UsageV2Scope;
  comparisonScope: UsageV2Scope | null;
  asOf: string;
  since: string | null;
  snapshot?: UsageV2Meta["snapshot"];
  observedAt?: string;
  dataMode: UsageV2Meta["dataMode"];
  liveFrom?: string;
  releaseContext?: UsageReleaseContext;
  activityPage?: UsageV2Profile["activityPage"];
};
export type UsageV2ReadOptions = { source?: "daily" | "live"; includeReleaseNotes?: boolean; activityPagination?: { page: number; pageSize: number } };
const searchPattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

// Only these bounded values are consumed by this dashboard. Never transfer
// masks, inline media, provider extras or arbitrary task parameters to Node.
const parameterProjection = (alias: "t" | "e") =>
  `jsonb_strip_nulls(jsonb_build_object(${[
    "size", "resolution", "quality", "aspectRatio", "droppedEventCount",
  ].map((key) => `'${key}',CASE WHEN octet_length((${alias}.parameters->'${key}')::text)<=128 THEN ${alias}.parameters->'${key}' END`).join(",")}))`;

/** All sources expose the same filter columns. Historical clicks/chats have unknown event department. */
export const usageV2FactsCte = `WITH facts AS (
 SELECT t.id::text,t.user_id,t.department_id AS event_department_id,u.department_id AS current_department_id,'task'::text AS kind,
 COALESCE(t.tool_key,t.parameters->>'tool') AS board_key,t.model_config_id,t.operation_type,t.operation_type AS action,NULL::text AS control_key,t.status,t.queued_at AS occurred_at,t.started_at,t.completed_at,${parameterProjection("t")} AS parameters,COALESCE(h.result_urls,t.result_urls) AS result_urls,
 CASE WHEN t.status='success' THEN h.rmb_cost::text END AS booked,t.failure_reason,t.attempts,t.prompt_optimized AS optimized,t.prompt_compilation_id AS compilation_id,
 (t.batch_id IS NOT NULL) AS batch_linked,CASE WHEN jsonb_typeof(t.source_urls)='array' THEN jsonb_array_length(t.source_urls) END AS source_count
 FROM tasks t JOIN users u ON u.id=t.user_id LEFT JOIN generation_history h ON h.task_id=t.id AND h.status='success' WHERE COALESCE(u.is_guest,false)=false
 UNION ALL
 SELECT e.id::text,e.user_id,NULL::uuid,u.department_id,'event',e.board_key,(e.parameters->>'modelConfigId')::uuid,NULL::text,e.action,e.control_key,'recorded',e.occurred_at,NULL::timestamptz,NULL::timestamptz,${parameterProjection("e")},'[]'::jsonb,NULL::text,NULL::text,0,false,NULL::text,NULL::boolean,NULL::int
 FROM usage_events e JOIN users u ON u.id=e.user_id WHERE COALESCE(u.is_guest,false)=false
 UNION ALL
 SELECT c.id::text,c.user_id,NULL::uuid,u.department_id,'chat',c.board_key,c.model_config_id,'chat','chat',NULL,c.status,c.created_at,NULL::timestamptz,NULL::timestamptz,'{}'::jsonb,'[]'::jsonb,NULL::text,NULL::text,0,false,NULL::text,NULL::boolean,NULL::int
 FROM usage_chat_requests c JOIN users u ON u.id=c.user_id WHERE COALESCE(u.is_guest,false)=false
)`;
export function usageV2SqlFilter(scope: UsageV2Scope) {
  const values: unknown[] = [scope.from, scope.to];
  const clauses = [
    "f.occurred_at >= $1::timestamptz",
    "f.occurred_at < $2::timestamptz",
  ];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    clauses.push(sql.replaceAll("?", `$${values.length}`));
  };
  const dept =
    scope.departmentBasis === "current"
      ? "current_department_id"
      : "event_department_id";
  if (scope.departmentIds) add(`f.${dept}=ANY(?::uuid[])`, scope.departmentIds);
  if (scope.userIds) add("f.user_id=ANY(?::uuid[])", scope.userIds);
  if (scope.boardKeys) add("f.board_key=ANY(?::text[])", scope.boardKeys);
  if (scope.modelConfigIds)
    add("f.model_config_id=ANY(?::uuid[])", scope.modelConfigIds);
  if (scope.operationTypes)
    add("f.operation_type=ANY(?::text[])", scope.operationTypes);
  if (scope.search)
    add(
      "f.user_id IN(SELECT id FROM users WHERE display_name ILIKE ? OR username ILIKE ?)",
      searchPattern(scope.search),
    );
  const where = clauses.join(" AND ");
  return { values, where: `WHERE ${where}`, departmentColumn: dept };
}
function millis(value: string | Date | null) {
  return value === null ? null : new Date(value).getTime();
}
function interval(from: string | Date | null, to: string | Date | null) {
  const a = millis(from),
    b = millis(to);
  return a !== null &&
    b !== null &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    b >= a
    ? b - a
    : null;
}
const iso = (value: string | Date) => new Date(value).toISOString();
const day = (value: string | Date) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const isActive = (fact: Fact) => fact.action !== "gap";
const isImage = (fact: Fact) =>
  fact.kind === "task" && IMAGE_OPERATIONS.has(fact.operation_type);
const assetId = (url: string) =>
  /^\/api\/assets\/([0-9a-f-]{36})\/content$/i.exec(url)?.[1]?.toLowerCase();
const group = <T>(rows: T[], key: (row: T) => string) => {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = map.get(id) ?? [];
    list.push(row);
    map.set(id, list);
  }
  return map;
};

export async function loadUsageV2SourceData(db: Database, scope: UsageV2Scope, transaction: UsageQueryClient) {
  return loadData(db, scope, { source: "live" }, transaction);
}
async function loadData(db: Database, scope: UsageV2Scope, options: UsageV2ReadOptions = {}, transaction?: UsageQueryClient): Promise<Data> {
  const comparisonScope = usageComparisonScope(scope);
  let asOf: string;
  const ownedClient = transaction ? undefined : await db.connect();
  const client = transaction ?? ownedClient!;
  try {
    if (!transaction) {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='15000ms'");
    }
    const snapshot = (await client.query<{ snapshot_at: string | Date }>("SELECT transaction_timestamp() AS snapshot_at")).rows[0]!;
    asOf = iso(snapshot.snapshot_at);
    const observedAt = asOf;
    // Decide the Beijing day once from this repeatable-read transaction, not
    // the HTTP/browser clock. A range can never read the same fact from both
    // daily history and live sources, including the comparison interval.
    const todayStart = Date.parse(usageDayStart(day(observedAt)));
    type Segment = { scope: UsageV2Scope; source: "daily" | "live" };
    const segments = (selected: UsageV2Scope): Segment[] => {
      if (options.source !== "daily") return [{ scope: selected, source: "live" }];
      const from = Date.parse(selected.from), to = Date.parse(selected.to);
      const result: Segment[] = [];
      const historyTo = Math.min(to, todayStart);
      if (from < historyTo) result.push({ source: "daily", scope: { ...selected, to: new Date(historyTo).toISOString() } });
      const liveFrom = Math.max(from, todayStart), liveTo = Math.min(to, todayStart + DAY);
      if (liveFrom < liveTo) result.push({ source: "live", scope: { ...selected, from: new Date(liveFrom).toISOString(), to: new Date(liveTo).toISOString() } });
      return result;
    };
    const currentSegments = segments(scope), comparisonSegments = comparisonScope ? segments(comparisonScope) : [];
    const selectedSegments = [...currentSegments, ...comparisonSegments];
    const historyScopes = selectedSegments.filter(segment => segment.source === "daily").map(segment => segment.scope);
    const liveFrom = options.source === "daily" && selectedSegments.some(segment => segment.source === "live") ? new Date(todayStart).toISOString() : undefined;
    const dailySnapshot = options.source === "daily" && (historyScopes.length || !liveFrom) ? await readUsageSnapshot(client, historyScopes, observedAt, METRIC_VERSION) : undefined;
    if (dailySnapshot && !liveFrom) asOf = dailySnapshot.newestComputedAt;
    let factCount = 0,
      factBytes = 0;
    const tooLarge = () =>
      new UsageError(
        "USAGE_SCOPE_TOO_LARGE",
        "当前范围超过分析规模预算（本期与对比期实时段共 5 万条、历史与实时合计 32 MiB 事实或 10 万条关联记录）；请缩短日期或增加筛选，未截断数据",
        422,
      );
    const liveFacts: Fact[] = [];
    const fetchFacts = async ({ scope: selected, source }: Segment) => {
      const filter = usageV2SqlFilter(selected);
      if (source === "daily") {
        const result = await readUsageDailyEventFacts(client,
          { cte: usageDailyFactsCte, source, where: filter.where, values: filter.values },
          filter.departmentColumn, MAX_FACT_BYTES - factBytes);
        factBytes += result.bytes;
        return result.facts;
      }
      const budget = (
        await client.query<{ count: number; bytes: string }>(
          // pg_column_size measures compressed TOAST storage, not the JSON the
          // driver expands. Count the complete projected, decompressed row.
          `${usageV2FactsCte} SELECT count(*)::int AS count,COALESCE(sum(octet_length(row_to_json(f)::text)),0)::text AS bytes FROM facts f ${filter.where}`,
          filter.values,
        )
      ).rows[0]!;
      factCount += Number(budget.count);
      factBytes += Number(budget.bytes);
      if ((!transaction && factCount > MAX_FACTS) || factBytes > MAX_FACT_BYTES) throw tooLarge();
      const rows = (
        await client.query<Fact>(
          `${usageV2FactsCte} SELECT f.*,f.${filter.departmentColumn} AS department_id FROM facts f ${filter.where}`,
          filter.values,
        )
      ).rows;
      for (const row of rows) liveFacts.push(row);
      return rows;
    };
    const fetchSegments = async (parts: Segment[]) => {
      const result: Fact[] = [];
      for (const part of parts) for (const fact of await fetchFacts(part)) result.push(fact);
      return result;
    };
    const facts = await fetchSegments(currentSegments), comparisonFacts = await fetchSegments(comparisonSegments);
    const all = [...facts, ...comparisonFacts];
    if (liveFacts.length) {
    const
      tasks = liveFacts.filter((f) => f.kind === "task"),
      taskIds = tasks.map((f) => f.id);
    const referencedAssets = tasks.flatMap((f) =>
      (Array.isArray(f.result_urls) ? f.result_urls : []).flatMap((url) =>
        typeof url === "string" && assetId(url) ? [assetId(url)!] : [],
      ),
    );
    const assets = taskIds.length
      ? (
          await client.query<Asset>(
            `SELECT id,task_id,owner_user_id,kind,mime_type,metadata->'imageResult' AS image_result FROM assets WHERE task_id=ANY($1::uuid[]) OR id=ANY($2::uuid[]) LIMIT ${MAX_RELATED_ROWS + 1}`,
            [taskIds, referencedAssets],
          )
        ).rows
      : [];
    if (assets.length > MAX_RELATED_ROWS) throw tooLarge();
    const assetsById = new Map(assets.map((a) => [a.id, a]));
    for (const asset of assets) {
      try {
        asset.image_result = asset.image_result
          ? readImageResultMetadata({ imageResult: asset.image_result })
          : null;
      } catch {
        asset.image_result = null;
      }
    }
    const assetsByResult = group(
      assets.filter(
        (a) =>
          a.image_result !== null &&
          a.kind === "image" &&
          a.mime_type.startsWith("image/"),
      ),
      (a) => `${a.task_id}:${a.owner_user_id}:${a.image_result!.resultIndex}`,
    );
    const events = assets.length
      ? (
          await client.query<{
            asset_id: string;
            task_id: string | null;
            event_type: string;
          }>(
            `SELECT e.asset_id,e.task_id,e.event_type FROM asset_events e
      WHERE e.asset_id=ANY($1::uuid[]) AND e.occurred_at <= $2::timestamptz AND e.event_type <> 'asset.event_reversed'
      AND NOT EXISTS(SELECT 1 FROM asset_events r WHERE r.source_event_id=e.id AND r.event_type='asset.event_reversed' AND r.occurred_at <= $2::timestamptz) LIMIT ${MAX_RELATED_ROWS + 1}`,
            [assets.map((a) => a.id), observedAt],
          )
        ).rows
      : [];
    if (events.length > MAX_RELATED_ROWS) throw tooLarge();
    const eventsByAsset = group(events, (e) => e.asset_id);
    for (const fact of liveFacts) {
      const hasAspectRatio = Object.hasOwn(fact.parameters, "aspectRatio");
      fact.parameters = safeUsageParameters(fact.parameters) as Record<
        string,
        unknown
      >;
      // The legacy sanitizer aliases size into aspectRatio. This dashboard
      // reports recorded fields, so absent ratios stay missing, not inferred.
      if (!hasAspectRatio) delete fact.parameters.aspectRatio;
      fact.total_ms =
        fact.kind === "task" && fact.status === "success"
          ? interval(fact.occurred_at, fact.completed_at)
          : null;
      const validStart =
        fact.total_ms !== null &&
        interval(fact.occurred_at, fact.started_at) !== null &&
        interval(fact.started_at, fact.completed_at) !== null;
      fact.wait_ms = validStart
        ? interval(fact.occurred_at, fact.started_at)
        : null;
      fact.run_ms = validStart
        ? interval(fact.started_at, fact.completed_at)
        : null;
      fact.outputs = [];
      if (!isImage(fact) || fact.status !== "success") continue;
      const outputs = new Map<string, Output>();
      for (const url of new Set(
        (Array.isArray(fact.result_urls) ? fact.result_urls : []).filter(
          (u): u is string => typeof u === "string" && !!u.trim(),
        ),
      )) {
        const asset = assetsById.get(assetId(url) ?? "");
        if (
          asset &&
          (asset.kind !== "image" || !asset.mime_type.startsWith("image/"))
        )
          continue;
        const owned =
          asset &&
          asset.task_id === fact.id &&
          asset.owner_user_id === fact.user_id;
        const metadata = owned ? asset.image_result : null;
        const validIndex =
          metadata?.version === 1 &&
          Number.isInteger(metadata.resultIndex) &&
          metadata.resultIndex! >= 0;
        const key = validIndex
          ? `${fact.id}:result:${metadata!.resultIndex}`
          : `${fact.id}:url:${url}`;
        const related = owned
          ? validIndex
            ? (assetsByResult.get(
                `${fact.id}:${fact.user_id}:${metadata!.resultIndex}`,
              ) ?? [asset])
            : [asset]
          : [];
        const evidence = related.flatMap((a) =>
          (eventsByAsset.get(a.id) ?? [])
            .filter((e) => e.task_id === fact.id)
            .map((e) => ({
              type: e.event_type,
              evidence: (e.event_type === "asset.downloaded" ||
              e.event_type === "asset.exported"
                ? "client_reported"
                : "server_confirmed") as "client_reported" | "server_confirmed",
            })),
        );
        const existing = outputs.get(key);
        outputs.set(key, {
          key,
          linked: !!owned,
          events: [...(existing?.events ?? []), ...evidence],
        });
      }
      fact.outputs = [...outputs.values()];
    }
    }
    let activityPage: UsageV2Profile["activityPage"] | undefined;
    if (options.source === "daily" && options.activityPagination) {
      const activitySegments: UsageReadSegment[] = currentSegments.map(segment => {
        const filter = usageV2SqlFilter(segment.scope);
        return { cte: segment.source === "daily" ? usageDailyFactsCte : usageV2FactsCte,
          source: segment.source, where: filter.where, values: filter.values };
      });
      const activity = await readUsageActivityPage(client, activitySegments, liveFacts, options.activityPagination, MAX_FACT_BYTES - factBytes);
      activityPage = activity.page;
      factBytes += activity.bytes;
    }
    const peopleRows = (
      await client.query<Person>(
        "SELECT u.id,u.display_name,u.department_id,d.name AS department_name FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE COALESCE(u.is_guest,false)=false AND ($1::uuid[] IS NULL OR u.id=ANY($1::uuid[])) AND ($2::text IS NULL OR u.display_name ILIKE $2 OR u.username ILIKE $2)",
        [
          scope.userIds ?? null,
          scope.search ? searchPattern(scope.search) : null,
        ],
      )
    ).rows;
    const matched = new Set(all.map((f) => f.user_id));
    const people = peopleRows.filter(
      (p) =>
        !scope.departmentIds ||
        (scope.departmentBasis === "current"
          ? scope.departmentIds.includes(p.department_id ?? "")
          : matched.has(p.id)),
    );
    const departments = new Map(
      (
        await client.query<{ id: string; name: string }>(
          "SELECT id,name FROM departments",
        )
      ).rows.map((d) => [d.id, d.name]),
    );
    const models = new Map(
      (
        await client.query<{ id: string; name: string }>(
          "SELECT id,name FROM model_configs",
        )
      ).rows.map((d) => [d.id, d.name]),
    );
    const compilationIds = [
      ...new Set(
        facts.flatMap((f) => (f.compilation_id ? [f.compilation_id] : [])),
      ),
    ];
    const compilations = compilationIds.length
      ? (
          await client.query<Compilation>(
            `SELECT DISTINCT c.id,c.reused_from_id,c.status,c.details->>'currency' AS currency,c.details->>'actualCost' AS actual,c.details->>'estimatedCost' AS estimated,c.details->>'inputTokens' AS input_tokens,c.details->>'outputTokens' AS output_tokens FROM prompt_compilations c WHERE c.id=ANY($1::text[]) OR c.id IN(SELECT reused_from_id FROM prompt_compilations WHERE id=ANY($1::text[]))`,
            [compilationIds],
          )
        ).rows
      : [];
    const since = (
      await client.query<{ started_at: string | Date }>(
        "SELECT started_at FROM usage_collection_metadata WHERE singleton=true",
      )
    ).rows[0]?.started_at;
    const releaseContext = options.includeReleaseNotes ? await readUsageReleaseContext(client, scope, observedAt) : undefined;
    if (!transaction) await client.query("COMMIT");
    return {
      facts,
      comparisonFacts,
      people,
      departments,
      models,
      compilations,
      scope,
      comparisonScope,
      asOf,
      since: since ? iso(since) : null,
      snapshot: dailySnapshot,
      observedAt,
      dataMode: options.source === "daily" ? (liveFrom ? "daily_history_live_today" : "persisted_daily_facts") : "live_existing_facts",
      liveFrom,
      releaseContext,
      activityPage,
    };
  } catch (error) {
    if (!transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    ownedClient?.release();
  }
}

export function usagePercentile(
  values: number[],
  percentile: number,
): number | null {
  const valid = values
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const position = (valid.length - 1) * percentile,
    low = Math.floor(position),
    high = Math.ceil(position);
  return valid[low]! + (valid[high]! - valid[low]!) * (position - low);
}
function metric(
  value: number | null,
  unit: UsageV2Metric["unit"],
  id: string,
  definition: string,
  availableCount: number,
  missingCount = 0,
  source = "tasks/usage_events/usage_chat_requests",
): UsageV2Metric {
  return {
    value,
    unit,
    state:
      value === null ? "unavailable" : missingCount ? "partial" : "available",
    availableCount,
    missingCount,
    definitionId: id,
    definition,
    source,
  };
}
function ratio(
  numerator: number,
  denominator: number,
  id: string,
  definition: string,
  missing = 0,
): UsageV2Metric {
  return {
    ...metric(
      denominator > 0 ? numerator / denominator : null,
      "ratio",
      id,
      definition,
      denominator - missing,
      missing,
    ),
    numerator,
    denominator,
  };
}
export function usageUnavailable(
  id: string,
  definition: string,
  eligible = 0,
): UsageV2Metric {
  return metric(null, "count", id, definition, 0, eligible, "unavailable");
}
// Six decimal CNY amounts are accumulated as integer micro-CNY, not floating point sums.
export function usageMoneyMicros(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value))
    throw new UsageError(
      "USAGE_COST_INVALID",
      "历史金额格式异常，未输出误导金额",
      503,
    );
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
}
/** Provider values may have more than six decimals: round half-up once, with bounded input size.
 * Invalid/negative/non-finite/oversized values remain unknown; no binary float money arithmetic. */
export function usageOptimizationMoneyMicros(
  value: string | null,
): bigint | null {
  if (value === null || !/^\d{1,16}(?:\.\d{1,30})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole!) * 1000000n +
    BigInt(fraction.slice(0, 6).padEnd(6, "0")) +
    (fraction.length > 6 && fraction[6]! >= "5" ? 1n : 0n)
  );
}
function amount(value: bigint) {
  return `${value / 1000000n}.${(value % 1000000n).toString().padStart(6, "0")}`;
}
const USE_TYPES = new Set([
  "asset.downloaded",
  "asset.exported",
  "asset.project_added",
  "asset.reused",
  "asset.adopted",
  "asset.delivered",
]);
const FORMAL_TYPES = new Set(["asset.adopted", "asset.delivered"]);
function resultUse(facts: Fact[], asOf: string): UsageV2ResultUse {
  const outputs = facts.flatMap((f) => f.outputs ?? []);
  const stages = [
    ["downloaded", "下载开始回执", ["asset.downloaded"]],
    ["exported", "导出回执", ["asset.exported"]],
    ["project", "加入项目", ["asset.project_added"]],
    ["reused", "再次复用", ["asset.reused"]],
    ["adopted", "正式采纳或交付", ["asset.adopted", "asset.delivered"]],
    ["delivered", "正式交付", ["asset.delivered"]],
  ] as const;
  return {
    basis: "submitted_cohort_as_of",
    asOf,
    ruleVersion: "result-use-v1",
    generatedImages: outputs.length,
    linkedImages: outputs.filter((o) => o.linked).length,
    unlinkedImages: outputs.filter((o) => !o.linked).length,
    usedImages: outputs.filter((o) =>
      o.events.some((e) => USE_TYPES.has(e.type)),
    ).length,
    formallyAdoptedImages: outputs.filter((o) =>
      o.events.some((e) => FORMAL_TYPES.has(e.type)),
    ).length,
    stages: stages.map(([key, label, types]) => ({
      key,
      label,
      count: outputs.filter((o) =>
        o.events.some((e) => (types as readonly string[]).includes(e.type)),
      ).length,
      evidence:
        key === "downloaded" || key === "exported"
          ? "client_reported"
          : "server_confirmed",
    })),
    notes: [
      "按提交期生成队列、当前快照前未撤销事件去重；这是使用证据，不是图片质量。",
      "阶段覆盖集合可跳步，不是有序单调漏斗。外链/无任务资产关联为未知；现有画布及对话本地下载覆盖不完整。",
      "对比期观察时长不一致，不能将队列使用率差异解释为提升；未提供固定成熟观察窗。",
      "采纳/交付表示存在有效正式事件，不等同于素材当前最终状态。下载/导出仅为应用回执，不证明系统落盘。",
    ],
  };
}
export function usageV2Metrics(facts: Fact[]): UsageV2Metrics {
  const active = facts.filter(isActive),
    tasks = facts.filter((f) => f.kind === "task"),
    calls = facts.filter((f) => f.kind !== "event"),
    successful = tasks.filter((f) => f.status === "success");
  const outputs = tasks.flatMap((f) => f.outputs ?? []),
    images = successful.filter(isImage),
    linked = outputs.filter((o) => o.linked).length;
  const missingImageOutputs = images.filter((f) => !f.outputs?.length).length;
  const uncertainCalls = calls.filter(
    (f) =>
      f.status !== "success" &&
      (f.status === "uncertain" ||
        (f.failure_category ?? classifyUsageFailure(f.status, f.failure_reason)) === "uncertain"),
  );
  const succeeded = calls.filter((f) => f.status === "success").length,
    failed = calls.filter(
      (f) => f.status === "failed" && !uncertainCalls.includes(f),
    ).length;
  const used = outputs.filter((o) =>
      o.events.some((e) => USE_TYPES.has(e.type)),
    ).length,
    adopted = outputs.filter((o) =>
      o.events.some((e) => FORMAL_TYPES.has(e.type)),
    ).length;
  const count = (value: number, id: string, definition: string) =>
    metric(value, "count", id, definition, value);
  const money = (rows: Fact[], id: string) => {
    const known = rows.filter((f) => f.booked !== null),
      total = known.reduce((sum, f) => sum + usageMoneyMicros(f.booked!), 0n);
    return {
      ...metric(
        rows.length > 0 && !known.length ? null : Number(total) / 1000000,
        "CNY",
        id,
        "成功生成历史已记账金额；非供应商实付，不含优化、聊天及失败调用费用。",
        known.length,
        rows.length - known.length,
        "generation_history.rmb_cost",
      ),
      amount: amount(total),
      currency: "CNY" as const,
      basis: "booked" as const,
    };
  };
  const totalMoney = money(successful, "generation-booked-cny-v1"),
    imageMoney = money(images, "image-booked-cny-v1");
  const latency = (
    key: "wait_ms" | "run_ms" | "total_ms",
    percentile: number,
    definition: string,
  ) => {
    const values = successful.flatMap((f) => (f[key] != null ? [f[key]!] : []));
    return metric(
      usagePercentile(values, percentile),
      "ms",
      `${key}-p${percentile * 100}-v1`,
      definition,
      values.length,
      successful.length - values.length,
      "tasks timestamps; full filtered sample",
    );
  };
  const costPer = (denominator: number, id: string, definition: string) => ({
    ...metric(
      denominator > 0 && imageMoney.value !== null
        ? imageMoney.value / denominator
        : null,
      "CNY",
      id,
      definition,
      imageMoney.availableCount,
      imageMoney.missingCount,
      "generation_history.rmb_cost + saved outputs",
    ),
    numerator: imageMoney.value ?? undefined,
    denominator,
    currency: "CNY" as const,
    basis: "booked" as const,
  });
  const useRate = ratio(
    used,
    outputs.length,
    "result-use-rate-v1",
    "同提交队列有有效使用回执的图片 / 全部已保存图片；已知证据下界，本地行为覆盖不完整。",
    outputs.length - linked,
  );
  const adoption = ratio(
    adopted,
    outputs.length,
    "formal-adoption-rate-v1",
    "同提交队列有有效正式采纳或交付事件的图片 / 全部已保存图片。",
    outputs.length - linked,
  );
  if (outputs.length) {
    useRate.state = "partial";
    if (!linked) {
      useRate.value = null;
      adoption.value = null;
      useRate.state = "unavailable";
      adoption.state = "unavailable";
    }
  }
  if (missingImageOutputs && adoption.value !== null)
    adoption.state = "partial";
  const perImage = costPer(
    outputs.length,
    "booked-per-image-v1",
    "图片任务已知记账金额 / 同队列已保存图片；不含视频音频。缺少输出记录时分母不完整。",
  );
  if (missingImageOutputs && perImage.value !== null)
    perImage.state = "partial";
  return {
    activePeople: count(
      new Set(active.map((f) => f.user_id)).size,
      "active-people-v1",
      "任务、文字请求或已记录业务事件去重员工；排除 gap 和管理员分析审计。",
    ),
    activeDays: count(
      new Set(active.map((f) => `${f.user_id}:${day(f.occurred_at)}`)).size,
      "active-person-days-v1",
      "北京时间活跃人日之和；个人即活跃天数，不是工时。",
    ),
    generationRequests: count(
      tasks.length,
      "task-count-v1",
      "每任务 ID 一次，不代表供应商 HTTP 请求数。",
    ),
    chatRequests: count(
      calls.length - tasks.length,
      "chat-count-v1",
      "已记录文字请求次数，不含未采集历史。",
    ),
    succeeded: count(
      succeeded,
      "success-count-v1",
      "当前状态成功的任务及文字请求。",
    ),
    failed: count(
      failed,
      "failed-count-v2",
      "当前明确 failed 状态；不包括取消、中断、暂停或未知。",
    ),
    cancelled: count(
      calls.filter((f) => f.status === "cancelled").length,
      "cancelled-v1",
      "明确用户取消；与供应商失败分列。",
    ),
    paused: count(
      calls.filter((f) => f.status === "paused").length,
      "paused-v1",
      "暂停等待处理，不能判为失败。",
    ),
    interrupted: count(
      calls.filter((f) => f.status === "interrupted").length,
      "interrupted-v1",
      "文字请求中断，结果不确定。",
    ),
    uncertain: count(
      uncertainCalls.length,
      "uncertain-v1",
      "明确结果待核查，排除确定失败分母；可与暂停当前状态重合，不可简单相加。",
    ),
    pending: count(
      calls.filter((f) => ["waiting", "processing"].includes(f.status)).length,
      "pending-v1",
      "当前 waiting 或 processing 请求。",
    ),
    generatedImages: metric(
      outputs.length,
      "count",
      "saved-image-results-v2",
      "成功图片任务已保存结果去重；显式原图/导出版本合并，不按请求 n 计数。覆盖样本单位为成功图片任务；缺输出任务不能推算图片数。",
      images.length - missingImageOutputs,
      missingImageOutputs,
    ),
    visits: count(
      usageFactCount(facts.filter((f) => f.kind === "event" && f.action === "visit")),
      "recorded-visits-v1",
      "已记录访问次数，不表示全部真实访问。",
    ),
    interactions: count(
      usageFactCount(facts.filter(
        (f) => f.kind === "event" && !["visit", "gap"].includes(f.action),
      )),
      "recorded-interactions-v1",
      "已记录非访问业务操作；不含 gap。",
    ),
    successRate: ratio(
      succeeded,
      succeeded + failed,
      "terminal-success-rate-v2",
      "成功 /（成功 + 明确失败）；取消、暂停、中断和进行中不进入分母。",
    ),
    generationBookedCny: totalMoney,
    imageBookedCny: imageMoney,
    costPerImage: perImage,
    resultUseRate: useRate,
    formalAdoptionRate: adoption,
    costPerUsedImage: {
      ...costPer(
        used,
        "booked-per-used-image-v1",
        "同队列全部图片记账金额 / 有使用证据的图片；使用覆盖不全，只可参考。",
      ),
      state: used && imageMoney.value !== null ? "partial" : "unavailable",
    },
    waitMsP50: latency(
      "wait_ms",
      0.5,
      "成功任务提交到首次 Worker 处理的中位数；有效完整样本，不是模型排队时长。",
    ),
    runMsP50: latency(
      "run_ms",
      0.5,
      "成功任务首次处理到完成的中位数，包含槽等待、重试与保存，不是纯模型推理。",
    ),
    totalMsP50: latency(
      "total_ms",
      0.5,
      "成功任务提交到完成 P50，筛选全集计算，不平均每日分位数。",
    ),
    totalMsP90: latency(
      "total_ms",
      0.9,
      "成功任务提交到完成 P90，筛选全集计算，不平均每日分位数。",
    ),
    activeSeconds: {
      ...usageUnavailable(
        "active-seconds-unavailable",
        "历史无可信心跳，不能补造软件可见活跃时长。",
        usageFactCount(active),
      ),
      unit: "seconds",
    },
    revisionRounds: usageUnavailable(
      "revision-rounds-unavailable",
      "无完整服务端编辑血缘；Worker attempts 不是设计师改稿轮次。",
      tasks.length,
    ),
  };
}
/** Outcome cohorts currently have unequal as-of observation lengths; withhold their deltas. */
export function compareUsageV2Metrics(
  current: UsageV2Metrics,
  previous?: UsageV2Metrics,
): UsageV2Metrics {
  if (!previous) return current;
  for (const key of Object.keys(current) as Array<keyof UsageV2Metrics>) {
    const a = current[key],
      b = previous[key],
      incomplete =
        a.value === null ||
        b.value === null ||
        a.state !== "available" ||
        b.state !== "available" ||
        ["resultUseRate", "formalAdoptionRate", "costPerUsedImage"].includes(key);
    a.comparison = {
      value: b.value,
      absoluteDelta: incomplete
        ? null
        : (a.value! - b.value!) * (a.unit === "ratio" ? 100 : 1),
      relativeDelta:
        incomplete || b.value === 0 || a.unit === "ratio"
          ? null
          : (a.value! - b.value!) / b.value!,
      ...(incomplete
        ? { reason: "insufficient_data" as const }
        : b.value === 0 && a.unit !== "ratio"
          ? { reason: "zero_baseline" as const }
          : {}),
      unit: a.unit === "ratio" ? "percentage_points" : "absolute",
    };
  }
  return current;
}
function metricsFor(
  data: Data,
  facts = data.facts,
  prior = data.comparisonFacts,
) {
  return compareUsageV2Metrics(
    usageV2Metrics(facts),
    data.comparisonScope ? usageV2Metrics(prior) : undefined,
  );
}
function meta(data: Data): UsageV2Meta {
  const metrics = usageV2Metrics(data.facts);
  const reportedDropped = data.facts
    .filter((f) => f.action === "gap")
    .reduce((sum, f) => sum + Number(f.parameters.droppedEventCount ?? 0) * usageFactWeight(f), 0);
  return {
    schemaVersion: 2,
    metricVersion: METRIC_VERSION,
    scope: data.scope,
    comparisonScope: data.comparisonScope,
    asOf: data.asOf,
    computedThrough: data.snapshot?.oldestComputedAt ?? data.asOf,
    provisional: true,
    dataMode: data.dataMode,
    ...(data.liveFrom ? { liveFrom: data.liveFrom, lagSeconds: 0 } : {}),
    ...(data.snapshot ? { snapshot: data.snapshot, lagSeconds: Math.max(0, Math.floor((Date.parse(data.observedAt!) - Date.parse(data.snapshot.oldestComputedAt)) / 1000)) } : {}),
    coverage: [
      ...Object.entries(metrics).map(([key, value]) => ({
        metric: key,
        state: value.state,
        since: ["visits", "interactions", "chatRequests"].includes(key)
          ? data.since
          : null,
        eligible: value.availableCount + value.missingCount,
        matched: value.availableCount,
        unknown: value.missingCount,
        notes: [value.definition],
      })),
      {
        metric: "reportedCollectionGaps",
        state: "partial",
        since: data.since,
        eligible: reportedDropped,
        matched: 0,
        unknown: reportedDropped,
        notes: [
          "仅客户端已报告的丢弃数量；未上报缺口无法量化，0 不证明采集完整。模型、部门或操作筛选可能排除无法归属的 gap 记录。",
        ],
      },
    ],
    notes: [
      data.liveFrom
        ? "北京时间今天从liveFrom起实时读取；更早日期只读日事实投影。asOf为本次只读事务观察时间，snapshot仅描述历史日，computedThrough为历史最旧快照（没有历史日时等于asOf）；历史与今天不是统一历史观察快照。未启用时长或流程补采集，不承诺目标规模下的查询时延。"
        : data.snapshot
        ? "读取可重建的按日精确事实投影；asOf为参与日快照最新时间，computedThrough为最旧时间，多日可能使用不同观察时点，不是同一历史观察快照。未启用时长或流程补采集，不承诺目标规模下的查询时延。"
        : "只读现有事实实时计算；尚未启用时长或流程补采集，不承诺目标规模下的查询时延。",
      "任务以首次提交时间归队列；实时段状态按本次事务观察，日事实段按各日补算观察，不是历史当时状态快照。所有边界含起不含终，日期及小时使用北京时间。",
      data.scope.departmentBasis === "at_event"
        ? "部门按任务提交时快照；旧点击及文字无部门快照，归入未记录部门，按部门筛选时不补用当前部门。人员名称旁仍显示当前部门。"
        : "部门按员工当前部门；调岗会改变历史归属，不代表当时部门。",
      "已记账费用不等于供应商实付；文字、失败或未知调用的上游费用未覆盖。",
      "时长/路径/预算/改稿轮次缺少可靠事实，明确不可用；记录为空不代表没有使用或人员效率低。",
      "筛选模型/操作类型时，未带这些维度的旧业务事件不会进入统计，不能据此推断无访问。",
    ],
  };
}
function dimensions(
  data: Data,
  key: (fact: Fact) => string,
  label: (key: string) => string,
  onlyCalls = false,
): UsageV2Dimension[] {
  const rows = onlyCalls
    ? data.facts.filter((f) => f.kind !== "event")
    : data.facts;
  const previous = group(
    onlyCalls
      ? data.comparisonFacts.filter((f) => f.kind !== "event")
      : data.comparisonFacts,
    key,
  );
  return [...group(rows, key)]
    .map(([key, facts]) => ({
      key,
      label: label(key),
      metrics: metricsFor(data, facts, previous.get(key) ?? []),
    }))
    .sort(
      (a, b) =>
        (b.metrics.generationRequests.value ?? 0) -
          (a.metrics.generationRequests.value ?? 0) ||
        a.key.localeCompare(b.key),
    );
}
const boards = (data: Data) =>
  dimensions(
    data,
    (f) => f.board_key ?? "unknown",
    (key) => usageBoardLabels[key] ?? "未记录板块",
  );
const departments = (data: Data) =>
  dimensions(
    data,
    (f) => f.department_id ?? "unknown",
    (key) => data.departments.get(key) ?? "未记录部门",
  );
const models = (data: Data) =>
  dimensions(
    data,
    (f) => f.model_config_id ?? "unknown",
    (key) => data.models.get(key) ?? "未记录模型",
    true,
  );
const daily = (facts: Fact[]) =>
  [...group(facts, (f) => day(f.occurred_at))]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, rows]) => ({ day, metrics: usageV2Metrics(rows) }));
function heatmap(facts: Fact[]) {
  return [
    ...group(facts.filter(isActive), (f) => {
      const date = new Date(new Date(f.occurred_at).getTime() + 8 * 3600000);
      return `${(date.getUTCDay() + 6) % 7}:${date.getUTCHours()}`;
    }),
  ]
    .map(([key, rows]) => {
      const [weekday, hour] = key.split(":").map(Number);
      return { weekday: weekday!, hour: hour!, count: usageFactCount(rows) };
    })
    .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
}
function person(
  data: Data,
  row: Person,
  facts = data.facts.filter((f) => f.user_id === row.id),
  prior = data.comparisonFacts.filter((f) => f.user_id === row.id),
): UsageV2Person {
  const top = (model: boolean) =>
    [
      ...group(
        facts.filter((f) => isActive(f) && (!model || f.kind !== "event")),
        (f) => (model ? f.model_config_id : f.board_key) ?? "unknown",
      ),
    ]
      .map(([key, rows]) => ({
        key,
        label: model
          ? (data.models.get(key) ?? "未记录模型")
          : (usageBoardLabels[key] ?? "未记录板块"),
        count: usageFactCount(rows),
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, 3);
  const times = facts
    .filter(isActive)
    .map((f) => iso(f.occurred_at))
    .sort();
  return {
    userId: row.id,
    displayName: row.display_name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    metrics: metricsFor(data, facts, prior),
    lastActivityAt: times.at(-1) ?? null,
    topBoards: top(false),
    topModels: top(true),
  };
}
function overviewSpendBaseline(data: Data) {
  // Only already-loaded, fully covered calendar days are eligible. Do not fetch
  // extra employee history outside the administrator's selected scope.
  const observedEnd = Math.min(Date.parse(data.scope.to), Date.parse(data.observedAt ?? data.asOf));
  const end = Date.parse(usageDayStart(day(new Date(observedEnd))));
  const targetStart = end - DAY, baselineStart = targetStart - 30 * DAY;
  if (!Number.isFinite(end) || Date.parse(data.scope.from) > baselineStart) return undefined;
  const eligible = data.facts.filter((fact) => fact.kind === "task" && new Date(fact.occurred_at).getTime() >= baselineStart && new Date(fact.occurred_at).getTime() < end);
  const names = new Map(data.people.map((person) => [person.id, person.display_name]));
  return {
    targetDay: day(new Date(targetStart)), baselineFrom: day(new Date(baselineStart)), baselineDays: 30 as const,
    people: [...group(eligible, (fact) => fact.user_id)].map(([userId, facts]) => ({
      userId, name: names.get(userId) ?? "所选员工",
      current: usageV2Metrics(facts.filter((fact) => new Date(fact.occurred_at).getTime() >= targetStart)).generationBookedCny,
      baseline: usageV2Metrics(facts.filter((fact) => new Date(fact.occurred_at).getTime() < targetStart)).generationBookedCny,
    })),
  };
}
export async function usageV2Overview(
  db: Database,
  scope: UsageV2Scope,
  options: UsageV2ReadOptions = {},
): Promise<UsageV2Overview> {
  const data = await loadData(db, scope, { ...options, includeReleaseNotes: true }),
    metrics = metricsFor(data);
  const hourly = heatmap(data.facts);
  const reportedGaps = (facts: Fact[]) => facts.filter((fact) => fact.action === "gap")
    .reduce((sum, fact) => {
      const value = Number(fact.parameters.droppedEventCount ?? 0);
      return sum + (Number.isSafeInteger(value) && value >= 0 ? value * usageFactWeight(fact) : 0);
    }, 0);
  return {
    meta: meta(data),
    metrics,
    daily: daily(data.facts),
    comparisonDaily: daily(data.comparisonFacts),
    hourlyHeatmap: hourly,
    departments: departments(data),
    releaseContext: data.releaseContext,
    controlDaily: usageControlDaily(data.facts),
    insights: usageInsights(metrics, {
      models: models(data), boards: boards(data), hourly,
      collectionGaps: { current: reportedGaps(data.facts), previous: data.comparisonScope ? reportedGaps(data.comparisonFacts) : null },
      spend: overviewSpendBaseline(data),
    }),
  };
}
export async function usageV2People(
  db: Database,
  scope: UsageV2Scope,
  query: ParsedUsageV2Query,
  options: UsageV2ReadOptions = {},
): Promise<UsageV2People> {
  const data = await loadData(db, scope, options),
    byUser = group(data.facts, (f) => f.user_id),
    previousByUser = group(data.comparisonFacts, (f) => f.user_id);
  const people = data.people.map((row) =>
    person(
      data,
      row,
      byUser.get(row.id) ?? [],
      previousByUser.get(row.id) ?? [],
    ),
  );
  const sortValue = (row: UsageV2Person) =>
    query.sort === "lastActivity"
      ? row.lastActivityAt === null
        ? null
        : Date.parse(row.lastActivityAt)
      : row.metrics[query.sort].value;
  people.sort((a, b) => {
    const x = sortValue(a),
      y = sortValue(b);
    return x === null && y !== null
      ? 1
      : y === null && x !== null
        ? -1
        : x !== null && y !== null && x !== y
          ? (x - y) * (query.order === "asc" ? 1 : -1)
          : a.userId.localeCompare(b.userId);
  });
  return {
    meta: meta(data),
    metrics: metricsFor(data),
    people: people.slice(
      (query.page - 1) * query.pageSize,
      query.page * query.pageSize,
    ),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: people.length,
    },
  };
}
/** Same-scope total divided by a stated population; missing billing stays partial/unavailable. */
export function usagePeopleTeamBaseline(metrics: UsageV2Metrics, rosterPeople: number, populationDefinition: string): UsagePeopleTeamBaseline {
  const cost = metrics.generationBookedCny;
  const perPerson = (denominator: number, basis: "active" | "roster"): UsageV2Metric => {
    const usable = Number.isSafeInteger(denominator) && denominator > 0 && cost.value !== null && cost.state !== "unavailable" && typeof cost.amount === "string";
    const divided = usable ? (usageMoneyMicros(cost.amount!) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator) : null;
    return {
      value: divided === null ? null : Number(divided) / 1000000,
      unit: "CNY", currency: "CNY", basis: "booked",
      state: !usable ? "unavailable" : cost.state === "partial" || cost.missingCount > 0 ? "partial" : "available",
      availableCount: cost.availableCount, missingCount: cost.missingCount,
      ...(divided === null ? {} : { amount: amount(divided) }),
      ...(cost.value === null ? {} : { numerator: cost.value }), denominator,
      definitionId: `team-booked-per-${basis}-person-v1`,
      definition: `同一原始共享筛选内的已记账生成金额 / ${basis === "active" ? "本期至少一条已记录业务活动的去重员工" : "本次范围可识别名册人数（含无本期记录者）"}；六位小数半进位，缺结算不补零，不是供应商实付、编制人数或效率评价。`,
      source: `generationBookedCny / ${basis === "active" ? "activePeople" : "scope roster"}`,
    };
  };
  return { metrics, rosterPeople, perActivePersonBookedCny: perPerson(metrics.activePeople.value ?? 0, "active"), perRosterPersonBookedCny: perPerson(rosterPeople, "roster"), populationDefinition };
}

/** One load/transaction for the original team and selected people; never query each person separately. */
export async function usageV2PeopleComparison(db: Database, scope: UsageV2Scope, selectedUserIds: string[], options: UsageV2ReadOptions = {}): Promise<UsagePeopleComparison> {
  if (selectedUserIds.length < 2 || selectedUserIds.length > 5 || new Set(selectedUserIds).size !== selectedUserIds.length || selectedUserIds.some(id => scope.userIds?.length && !scope.userIds.includes(id)))
    throw new UsageError("USAGE_COMPARISON_OUT_OF_SCOPE", "请选择原共享筛选范围内的 2–5 位不同员工；未扩大团队范围", 400);
  const data = await loadData(db, scope, options);
  const roster = new Map(data.people.map(row => [row.id, row]));
  if (selectedUserIds.some(id => !roster.has(id)))
    throw new UsageError("USAGE_COMPARISON_OUT_OF_SCOPE", "部分所选员工不在本次范围名册中；未扩大筛选或显示不完整对照", 409);
  const byUser = group(data.facts, fact => fact.user_id), priorByUser = group(data.comparisonFacts, fact => fact.user_id);
  const populationDefinition = [
    "团队保留原日期、对比期、人员、部门、姓名搜索、板块、模型和操作筛选；所选 2–5 人只决定并排列，不替换团队范围。",
    scope.departmentIds?.length && scope.departmentBasis === "at_event"
      ? "事件时部门下的范围名册：原人员/姓名筛选内、本期或对比期存在匹配事实且仍可识别的员工；无历史部门证据者不猜配，不是当时部门编制。"
      : "范围名册：原人员/姓名与当前部门（如适用）筛选内的非访客账号，包含没有本期业务记录者；不等于在职编制或历史名册。",
    "板块、模型、操作和日期限制业务事实与活跃人数；除事件时部门需要匹配事实外，不把这些条件下无记录的名册员工删掉或认定为未工作。",
    "团队率以合并分子分母计算，时延按全部有效任务原样本计算；计数/金额为团队合计，不是个人均值。活跃天数在团队列为活跃人日之和。两种人均费用另外明确分母。",
  ].join(" ");
  return {
    meta: meta(data), selectedUserIds: [...selectedUserIds],
    people: selectedUserIds.map(id => person(data, roster.get(id)!, byUser.get(id) ?? [], priorByUser.get(id) ?? [])),
    team: usagePeopleTeamBaseline(metricsFor(data), data.people.length, populationDefinition),
  };
}

function recordedShare(matched: number, recorded: number, missing: number, id: string, definition: string): UsageV2Metric {
  return { ...metric(recorded ? matched / recorded : null, "ratio", id, definition, recorded, missing, "tasks / usage_daily_facts safe projection"), numerator: matched, denominator: recorded };
}
function parameterDistributions(facts: Fact[]): UsageV2Parameter[] {
  const result: UsageV2Parameter[] = [];
  for (const [boardKey, tasks] of group(facts.filter(f => f.kind === "task"), f => f.board_key ?? "unknown")) {
    for (const parameter of ["size", "resolution", "quality", "aspectRatio"]) {
      const recorded = tasks.filter(f => typeof f.parameters[parameter] === "string");
      const missing = tasks.length - recorded.length;
      const values: Array<[string | null, Fact[]]> = recorded.length
        ? [...group(recorded, f => String(f.parameters[parameter]))]
        : [[null, []]];
      for (const [value, rows] of values) result.push({
        boardKey, boardLabel: usageBoardLabels[boardKey] ?? "未记录板块", parameter, value,
        count: rows.length, eligible: tasks.length, missing,
        rate: recordedShare(rows.length, recorded.length, missing, `board-${parameter}-recorded-share-v1`, "同板块该选项的任务数 / 有该参数有效记录的任务数；缺失另列，未跨板块混合，不证明所有任务的真实偏好。"),
      });
    }
  }
  return result.sort((a, b) => a.boardKey.localeCompare(b.boardKey) || a.parameter.localeCompare(b.parameter) || (a.value ?? "").localeCompare(b.value ?? ""));
}
function profileHabits(facts: Fact[]): UsageV2Profile["habits"] {
  const tasks = facts.filter(f => f.kind === "task"), images = tasks.filter(isImage);
  const rate = (key: UsageV2Profile["habits"]["rates"][number]["key"], label: string, rows: Fact[], read: (fact: Fact) => boolean | null, definition: string) => {
    const values = rows.map(read), known = values.filter(value => value !== null), matched = known.filter(Boolean).length;
    const missing = values.length - known.length;
    return { key, label, eligible: rows.length, matched, missing, rate: recordedShare(matched, known.length, missing, `habit-${key}-v1`, definition) };
  };
  const recognized = new Set<string>(operationSchema.options);
  const imageOrUnknown = tasks.filter(f => isImage(f) || !recognized.has(f.operation_type));
  const references = images.filter(f => typeof f.source_count === "number" && Number.isSafeInteger(f.source_count) && f.source_count >= 0);
  const missingReferences = images.length - references.length;
  return {
    rates: [
      rate("batchLinked", "批次关联任务占比", tasks, f => typeof f.batch_linked === "boolean" ? f.batch_linked : null, "有 batch_id 关联的任务 / 可读取批次标记的任务；同批多任务逐条计数，一任务多图不等于批量。"),
      rate("optimizedMarked", "有优化标记任务占比", tasks, f => typeof f.optimized === "boolean" ? f.optimized : null, "prompt_optimized=true 的任务 / 可读取布尔标记的任务；false 仅表示无标记，旧链路可能未标记，不证明未使用优化。"),
      rate("inpaint", "明确局部重绘任务占比", imageOrUnknown, f => recognized.has(f.operation_type) ? f.operation_type === "inpaint" : null, "operation_type=inpaint 的任务 / 操作类型明确的图片任务；视频、音频与文字不进分母，未识别操作另列缺失，不从提示词或多图推断。"),
    ],
    referenceCounts: {
      eligible: images.length, missing: missingReferences,
      items: [...group(references, f => String(f.source_count))].map(([value, rows]) => ({
        value: Number(value), count: rows.length,
        rate: recordedShare(rows.length, references.length, missingReferences, "submitted-reference-count-v1", "提交该参考项数的图片任务 / source_urls 为数组的图片任务；数组长度不去重，不等于不同图片数，不读取参考 URL 或图片内容。"),
      })).sort((a, b) => a.value - b.value),
    },
    parameters: parameterDistributions(tasks),
    notes: [
      "只描述当前筛选内已记录任务；无记录/字段缺失不补成零比例，不评价员工能力或连续工作时长。",
      "提交的参考项数按图片任务 source_urls 数组长度计算；重复项不去重，不推断不同图片数，非图像操作排除。",
      "参数仅使用安全白名单；各板块独立分母，比例基于该参数有有效记录的任务，缺失或不适用数量另列，不合并不同参数名的语义。",
    ],
  };
}
export async function usageV2Profile(
  db: Database,
  scope: UsageV2Scope,
  id: string,
  query: ParsedUsageV2Query,
  options: UsageV2ReadOptions = {},
): Promise<UsageV2Profile> {
  if (scope.userIds && !scope.userIds.includes(id))
    throw new UsageError("USAGE_PERSON_NOT_FOUND", "员工不在当前筛选中", 404);
  const data = await loadData(db, { ...scope, userIds: [id] }, { ...options, activityPagination: { page: query.page, pageSize: query.pageSize } }),
    row = data.people[0];
  if (!row)
    throw new UsageError(
      "USAGE_PERSON_NOT_FOUND",
      "员工不存在或不在当前筛选中",
      404,
    );
  const records = data.facts
    .filter(isActive)
    .sort(
      (a, b) =>
        new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime() ||
        a.id.localeCompare(b.id),
    );
  return {
    meta: meta(data),
    person: person(data, row),
    metrics: metricsFor(data),
    daily: daily(data.facts),
    hourlyHeatmap: heatmap(data.facts),
    boards: boards(data),
    models: models(data),
    habits: profileHabits(data.facts),
    activityPage: data.activityPage ?? {
      records: records
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map((f) => ({
          id: `${f.kind}:${f.id}`,
          kind: f.kind,
          occurredAt: iso(f.occurred_at),
          boardKey: f.board_key,
          action: f.action,
          modelConfigId: f.model_config_id,
          status: f.status,
          generatedImages: f.outputs?.length ?? 0,
          bookedCny: f.booked,
          totalMs: f.total_ms ?? null,
        })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: records.length,
      },
    },
  };
}
export async function usageV2Boards(
  db: Database,
  scope: UsageV2Scope,
  options: UsageV2ReadOptions = {},
): Promise<UsageV2Boards> {
  const data = await loadData(db, scope, options);
  const activeByBoard = group(
    data.facts.filter(isActive),
    (f) => f.board_key ?? "unknown",
  );
  return {
    meta: meta(data),
    boards: boards(data),
    parameters: parameterDistributions(data.facts),
    controlUsage: [
      ...group(
        data.facts.filter(
          (f) => f.kind === "event" && !["visit", "gap"].includes(f.action),
        ),
        (f) => `${f.board_key ?? "unknown"}|${f.control_key ?? "unknown"}`,
      ),
    ].map(([, rows]) => {
      const boardKey = rows[0]!.board_key ?? "unknown",
        controlKey = rows[0]!.control_key ?? "unknown",
        users = new Set(rows.map((r) => r.user_id)).size,
        eligibleUsers = new Set(
          (activeByBoard.get(boardKey) ?? []).map((r) => r.user_id),
        ).size;
      const rate = ratio(
        users,
        eligibleUsers,
        "control-user-reach-v1",
        "操作该控件的去重员工 / 板块有记录活跃员工；非会话转化率。",
      );
      if (rate.value !== null) rate.state = "partial";
      return {
        boardKey,
        controlKey,
        label: usageControlLabel(controlKey) ?? "未记录控件",
        users,
        eligibleUsers,
        rate,
      };
    }),
    conversion: usageUnavailable(
      "visit-submit-unavailable",
      "无 visit/task 稳定关联，不能用提交次数 / 访问次数伪造转化率。",
      usageFactCount(data.facts),
    ),
    abandonment: usageUnavailable(
      "abandonment-unavailable",
      "缺少可靠访问会话和离开事件，不能补造放弃点。",
      usageFactCount(data.facts),
    ),
    insights: usageInsights(metricsFor(data)),
  };
}
function optimizationCosts(rows: Compilation[]): UsageV2OptimizationCosts {
  const executed = rows.filter((r) => !r.reused_from_id),
    costs = new Map<
      string,
      {
        currency: string;
        providerReportedAmount: string;
        estimatedAmount: string;
        knownCount: number;
        estimatedCount: number;
        unknownCount: number;
        actual: bigint;
        estimated: bigint;
      }
    >();
  for (const row of executed) {
    const currency =
        row.currency && /^[A-Z]{3}$/.test(row.currency)
          ? row.currency
          : "unknown",
      cost = costs.get(currency) ?? {
        currency,
        providerReportedAmount: "0.000000",
        estimatedAmount: "0.000000",
        knownCount: 0,
        estimatedCount: 0,
        unknownCount: 0,
        actual: 0n,
        estimated: 0n,
      };
    const actual = usageOptimizationMoneyMicros(row.actual),
      estimated = usageOptimizationMoneyMicros(row.estimated);
    if (actual !== null && currency !== "unknown") {
      cost.actual += actual;
      cost.knownCount++;
    } else if (estimated !== null && currency !== "unknown") {
      cost.estimated += estimated;
      cost.estimatedCount++;
    } else cost.unknownCount++;
    costs.set(currency, cost);
  }
  const tokens = (key: "input_tokens" | "output_tokens") => {
    const known = executed.filter(
      (r) =>
        r[key] !== null &&
        /^\d+$/.test(r[key]!) &&
        Number.isSafeInteger(Number(r[key])),
    );
    return metric(
      !known.length && executed.length
        ? null
        : known.reduce((s, r) => s + Number(r[key]), 0),
      "count",
      key,
      "仅独立编译执行的已知 Token，缓存引用不重复计费。",
      known.length,
      executed.length - known.length,
      "prompt_compilations.details selected fields",
    );
  };
  return {
    executions: executed.length,
    cacheHits: rows.length - executed.length,
    uncertain: executed.filter((r) => r.status === "uncertain").length,
    inputTokens: tokens("input_tokens"),
    outputTokens: tokens("output_tokens"),
    costs: [...costs.values()].map(({ actual, estimated, ...cost }) => ({
      ...cost,
      providerReportedAmount: amount(actual),
      estimatedAmount: amount(estimated),
    })),
    notes: [
      "只含关联本筛选任务的编译及其缓存源；未提交到任务的优化不在此集合。按编译 ID 去重，跨不同任务筛选的结果不可直接相加。",
      "供应商返回费用与估算按币种分列，不并入生成记账金额，也不表示财务账单已对账。",
    ],
  };
}
/** Exact filtered success-task sample, including persisted per-fact latencies; never daily quantile averages. */
export function usageLatencyDistribution(facts: Fact[]): UsageV2LatencyDistribution {
  const successful = facts.filter((fact) => fact.kind === "task" && fact.status === "success");
  const values = successful.flatMap((fact) => typeof fact.total_ms === "number" && Number.isFinite(fact.total_ms) && fact.total_ms >= 0 ? [fact.total_ms] : []).sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (!values.length) return null;
    const position = (values.length - 1) * p, lower = Math.floor(position), upper = Math.ceil(position);
    return values[lower]! + (values[upper]! - values[lower]!) * (position - lower);
  };
  return {
    eligible: successful.length, available: values.length, missing: successful.length - values.length,
    unit: "ms", method: "full_sample_linear_interpolation",
    min: values[0] ?? null, q1: percentile(.25), median: percentile(.5), q3: percentile(.75), max: values.at(-1) ?? null,
    notes: ["仅当前筛选的成功生成任务，取提交到完成的有效非负耗时；文字请求、失败和未完成任务不进入样本。", "按全部原样本排序后线性插值计算 P25/P50/P75；须线为最小/最大值，不是 Tukey 1.5 IQR，也不把慢任务称异常。", "不平均每日分位数；缺失时间单列，任务端到端耗时不等于供应商纯推理时间。"],
  };
}
export async function usageV2Models(
  db: Database,
  scope: UsageV2Scope,
  options: UsageV2ReadOptions = {},
): Promise<UsageV2Models> {
  const data = await loadData(db, scope, options);
  const key = (f: Fact) =>
    JSON.stringify([f.model_config_id, f.operation_type, f.board_key]);
  const modelFacts = group(data.facts.filter((fact) => fact.kind !== "event"), key);
  return {
    meta: meta(data),
    models: dimensions(
      data,
      key,
      (key) => {
        const [id, operation, board] = JSON.parse(key);
        return `${data.models.get(id) ?? "未记录模型"} · ${operation} · ${usageBoardLabels[board] ?? "未记录板块"}`;
      },
      true,
    ).map((row) => {
      const [modelConfigId, operationType, boardKey] = JSON.parse(row.key);
      const facts = modelFacts.get(row.key) ?? [];
      const failed = facts.filter((fact) => fact.status === "failed");
      return {
        ...row, modelConfigId, operationType, boardKey,
        latency: usageLatencyDistribution(facts),
        failures: [...group(failed, (fact) => fact.failure_category ?? classifyUsageFailure(fact.status, fact.failure_reason))]
          .map(([category, failures]) => ({ category, label: usageFailureLabels[category] ?? "未分类原因", count: failures.length }))
          .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      };
    }),
    costBreakdown: {
      departments: departments(data),
      people: dimensions(
        data,
        (f) => f.user_id,
        (key) => data.people.find((p) => p.id === key)?.display_name ?? "员工",
      ),
      boards: boards(data),
      operations: dimensions(
        data,
        (f) => f.operation_type ?? "unknown",
        (key) => key,
        true,
      ),
      models: dimensions(data, (fact) => fact.model_config_id ?? "unknown", (id) => data.models.get(id) ?? "未记录模型", true),
    },
    optimizationCosts: optimizationCosts(data.compilations),
    budget: usageUnavailable(
      "cash-budget-unavailable",
      "未配置人民币预算；内部积分额度不是现金预算。",
    ),
    insights: usageInsights(metricsFor(data)),
  };
}
export async function usageV2Quality(
  db: Database,
  scope: UsageV2Scope,
  options: UsageV2ReadOptions = {},
): Promise<UsageV2Quality> {
  const data = await loadData(db, scope, options),
    tasks = data.facts.filter((f) => f.kind === "task"),
    metrics = metricsFor(data);
  const failed = data.facts.filter(
    (f) =>
      f.kind !== "event" &&
      ["failed", "cancelled", "interrupted", "paused", "uncertain"].includes(
        f.status,
      ),
  );
  return {
    meta: meta(data),
    metrics,
    failureRuleVersion: USAGE_FAILURE_RULE_VERSION,
    failures: [
      ...group(failed, (f) =>
        JSON.stringify([
          f.failure_category ?? classifyUsageFailure(f.status, f.failure_reason),
          f.model_config_id,
          f.board_key,
          f.operation_type,
        ]),
      ),
    ].map(([key, rows]) => {
      const [category, modelConfigId, boardKey, operationType] =
        JSON.parse(key);
      return {
        category,
        label: usageFailureLabels[category] ?? "未分类原因",
        count: rows.length,
        modelConfigId,
        boardKey,
        operationType,
      };
    }),
    retries: [...group(tasks, (f) => String(f.attempts))]
      .map(([attempts, rows]) => ({
        attempts: Number(attempts),
        tasks: rows.length,
      }))
      .sort((a, b) => a.attempts - b.attempts),
    resultUse: resultUse(data.facts, data.asOf),
    lineage: metrics.revisionRounds,
    optimizationComparison: [
      ...group(tasks, (f) =>
        JSON.stringify([
          f.model_config_id,
          f.board_key,
          f.operation_type,
          f.optimized,
        ]),
      ),
    ].map(([key, rows]) => {
      const [modelConfigId, boardKey, operationType, optimized] =
        JSON.parse(key);
      return {
        modelConfigId,
        boardKey,
        operationType,
        optimized,
        metrics: usageV2Metrics(rows),
      };
    }),
    insights: usageInsights(metrics),
  };
}
export async function usageV2Flows(
  db: Database,
  scope: UsageV2Scope,
  options: UsageV2ReadOptions = {},
): Promise<UsageV2Flows> {
  const data = await loadData(db, scope, options),
    use = resultUse(data.facts, data.asOf);
  return {
    meta: meta(data),
    nodes: [],
    links: [],
    paths: [],
    transfers: [],
    funnels: [
      {
        key: "result-stages",
        label: "同生成队列的结果使用阶段覆盖（非有序漏斗）",
        mode: "stage_coverage",
        stages: use.stages,
      },
    ],
    pathCoverage: usageUnavailable(
      "linked-paths-unavailable",
      "历史没有稳定 session/visit/workflow 关系，不根据时间相近推造路径或跨板块流转。",
      usageFactCount(data.facts),
    ),
    resultUse: use,
    insights: [],
  };
}
export async function usageV2Options(
  db: Database,
  query: ParsedUsageV2Query,
): Promise<UsageV2Options> {
  const values = [
      query.search ? searchPattern(query.search) : null,
      query.departmentIds ?? null,
    ],
    where =
      "WHERE COALESCE(u.is_guest,false)=false AND ($1::text IS NULL OR u.display_name ILIKE $1 OR u.username ILIKE $1) AND ($2::uuid[] IS NULL OR u.department_id=ANY($2::uuid[]))";
  const people = (
    await db.query<{ id: string; name: string; departmentId: string | null }>(
      `SELECT u.id,u.display_name AS name,u.department_id AS "departmentId" FROM users u ${where} ORDER BY u.display_name,u.id LIMIT $3 OFFSET $4`,
      [...values, query.pageSize, (query.page - 1) * query.pageSize],
    )
  ).rows;
  const total = Number(
    (await db.query(`SELECT count(*) AS total FROM users u ${where}`, values))
      .rows[0]?.total ?? 0,
  );
  return {
    departments: (
      await db.query("SELECT id,name FROM departments ORDER BY name,id")
    ).rows,
    people,
    models: (
      await db.query("SELECT id,name FROM model_configs ORDER BY name,id")
    ).rows,
    boards: Object.entries(usageBoardLabels).map(([key, label]) => ({
      key,
      label: String(label),
    })),
    operationTypes: [...operationSchema.options],
    peoplePagination: { page: query.page, pageSize: query.pageSize, total },
    notes: ["人员选项展示当前部门；统计可另选事件时部门归属。"],
  };
}
