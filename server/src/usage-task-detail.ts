import { z } from "zod";
import type { Database } from "./db";
import { UsageError } from "./usage-analytics";
import {
    USAGE_TASK_EVIDENCE_LABELS,
    USAGE_TASK_PARAMETER_LABELS,
    type UsageTaskDetail,
    type UsageTaskParameter,
    type UsageTaskPrompt,
    type UsageTaskResult,
} from "../../shared/usage-task-detail";

export const usageTaskDetailQuery = z
    .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        pageSize: z.coerce.number().int().min(1).max(24).default(12),
    })
    .strict();
const parameterSql = `jsonb_strip_nulls(jsonb_build_object(${Object.keys(USAGE_TASK_PARAMETER_LABELS)
    .map((key) => `'${key}',CASE WHEN octet_length((t.parameters->'${key}')::text)<=80 THEN t.parameters->'${key}' END`)
    .join(",")}))`;
const outputSql = "COALESCE(h.result_urls,t.result_urls)";
const joins =
    "FROM tasks t JOIN users u ON u.id=t.user_id LEFT JOIN generation_history h ON h.task_id=t.id AND h.user_id=t.user_id AND h.status='success'";
const ownerWhere = "t.id=$1 AND t.user_id=$2 AND COALESCE(u.is_guest,false)=false";
const notFound = () => new UsageError("USAGE_TASK_NOT_FOUND", "任务不存在或不属于当前员工，未读取详情", 404);
const iso = (value: unknown): string | null => {
    const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
function safeParameters(value: unknown): UsageTaskDetail["parameters"] {
    const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const result: UsageTaskDetail["parameters"] = {};
    for (const name of Object.keys(USAGE_TASK_PARAMETER_LABELS) as UsageTaskParameter[]) {
        const item = source[name];
        const valid =
            typeof item === "number"
                ? Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER
                : typeof item === "string" && (name === "size" || name === "resolution")
                  ? /^(?:auto|small|medium|large|\d{2,5}[xX×:*]\d{2,5}|[1248][Kk]|\d{3,4}p)$/.test(item)
                  : typeof item === "string" && name === "aspectRatio"
                    ? /^\d{1,3}:\d{1,3}$/.test(item)
                    : typeof item === "string" && name === "quality"
                      ? /^(?:auto|low|standard|medium|high|hd)$/.test(item)
                      : typeof item === "string" && /^-?\d{1,12}(?:\.\d{1,6})?$/.test(item);
        if (valid) result[name] = item as string | number;
    }
    return result;
}
const interval = (start: string | null, end: string | null) => {
    if (!start || !end) return null;
    const value = Date.parse(end) - Date.parse(start);
    return value >= 0 && Number.isFinite(value) ? value : null;
};

/** Metadata and paged protected asset identities only; raw prompts, URLs and arbitrary parameters never enter this result. */
export async function readUsageTaskDetail(
    db: Database,
    userId: string,
    taskId: string,
    query: z.infer<typeof usageTaskDetailQuery>,
): Promise<UsageTaskDetail> {
    const client = await db.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const row = (
            await client.query(
                `SELECT t.status,t.operation_type,t.tool_key,t.queued_at,t.started_at,t.completed_at,m.name AS model_name,${parameterSql} AS parameters,CASE WHEN t.status='success' THEN h.rmb_cost::text END AS booked,CASE WHEN jsonb_typeof(t.source_urls)='array' THEN jsonb_array_length(t.source_urls) END AS reference_count,CASE WHEN jsonb_typeof(${outputSql})='array' THEN jsonb_array_length(${outputSql}) END AS result_count ${joins} LEFT JOIN model_configs m ON m.id=t.model_config_id WHERE ${ownerWhere}`,
                [taskId, userId],
            )
        ).rows[0];
        if (!row) throw notFound();
        const asOf = new Date().toISOString();
        // Match only canonical server asset references. No old external URL or raw result metadata is returned.
        const results = await client.query(
            `SELECT r.ordinality::int AS position,a.id AS asset_id,a.kind,(a.thumbnail_256_key IS NOT NULL) AS thumbnail_available,(a.thumbnail_1024_key IS NOT NULL) AS preview_available ${joins}
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${outputSql})='array' THEN ${outputSql} ELSE '[]'::jsonb END) WITH ORDINALITY r(value,ordinality)
            LEFT JOIN assets a ON a.id=(regexp_match(CASE WHEN jsonb_typeof(r.value)='string' THEN r.value#>>'{}' END,'^/api/assets/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/content$'))[1]::uuid
                AND a.owner_user_id=t.user_id AND a.task_id=t.id AND a.status='ready' AND a.deleted_at IS NULL AND ((a.kind='image' AND a.mime_type LIKE 'image/%') OR (a.kind='video' AND a.mime_type LIKE 'video/%'))
            WHERE ${ownerWhere} AND r.ordinality>$3 ORDER BY r.ordinality LIMIT $4`,
            [taskId, userId, (query.page - 1) * query.pageSize, query.pageSize],
        );
        const ids = [...new Set(results.rows.flatMap((r) => (r.asset_id ? [String(r.asset_id)] : [])))];
        const evidence = ids.length
            ? (
                  await client.query(
                      `SELECT e.asset_id,e.event_type,count(*)::int AS count,max(e.occurred_at) AS last_at FROM asset_events e
            WHERE e.asset_id=ANY($1::uuid[]) AND e.designer_user_id=$2 AND e.task_id=$3 AND e.event_type=ANY($4::text[]) AND e.occurred_at<=$5::timestamptz
            AND NOT EXISTS(SELECT 1 FROM asset_events reverse WHERE reverse.source_event_id=e.id AND reverse.asset_id=e.asset_id AND reverse.task_id=e.task_id AND reverse.event_type='asset.event_reversed' AND reverse.occurred_at<=$5::timestamptz)
            GROUP BY e.asset_id,e.event_type ORDER BY e.event_type`,
                      [ids, userId, taskId, Object.keys(USAGE_TASK_EVIDENCE_LABELS), asOf],
                  )
              ).rows
            : [];
        const items: UsageTaskResult[] = results.rows.map((r) => ({
            position: r.position,
            assetId: r.asset_id ?? null,
            kind: r.asset_id ? r.kind : null,
            thumbnailAvailable: Boolean(r.asset_id && r.thumbnail_available),
            previewAvailable: Boolean(r.asset_id && r.preview_available),
            evidence: evidence
                .filter((e) => e.asset_id === r.asset_id)
                .map((e) => ({
                    eventType: e.event_type,
                    count: e.count,
                    lastAt: iso(e.last_at)!,
                    basis: ["asset.downloaded", "asset.exported"].includes(e.event_type)
                        ? "client_reported"
                        : "server_confirmed",
                })),
        }));
        await client.query("COMMIT");
        const queuedAt = iso(row.queued_at)!,
            startedAt = iso(row.started_at),
            completedAt = iso(row.completed_at);
        return {
            userId,
            taskId,
            asOf,
            status: row.status,
            operationType: row.operation_type,
            boardKey: row.tool_key ?? null,
            modelName: row.model_name ?? null,
            queuedAt,
            startedAt,
            completedAt,
            timing: {
                waitMs: interval(queuedAt, startedAt),
                runMs: interval(startedAt, completedAt),
                totalMs: interval(queuedAt, completedAt),
            },
            bookedCny: row.booked ?? null,
            parameters: safeParameters(row.parameters),
            submittedReferenceCount: row.reference_count ?? null,
            results: {
                items,
                pagination: { page: query.page, pageSize: query.pageSize, total: row.result_count ?? 0 },
                available: row.result_count !== null,
            },
        };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

/** Separate explicit operation. Do not load user_input.fields, source URLs or compiler internals. */
export async function readUsageTaskPrompt(db: Database, userId: string, taskId: string): Promise<UsageTaskPrompt> {
    const row = (
        await db.query(
            `SELECT left(t.prompt,32000) AS prompt,length(t.prompt) AS prompt_length,CASE WHEN jsonb_typeof(t.user_input->'userText')='string' THEN left(t.user_input->>'userText',32000) END AS user_input,CASE WHEN jsonb_typeof(t.user_input->'userText')='string' THEN length(t.user_input->>'userText') END AS user_input_length FROM tasks t JOIN users u ON u.id=t.user_id WHERE ${ownerWhere}`,
            [taskId, userId],
        )
    ).rows[0];
    if (!row) throw notFound();
    return {
        userId,
        taskId,
        prompt: row.prompt,
        userInput: row.user_input ?? null,
        promptLength: row.prompt_length,
        userInputLength: row.user_input_length ?? null,
        truncated: row.prompt_length > 32000 || row.user_input_length > 32000,
    };
}
