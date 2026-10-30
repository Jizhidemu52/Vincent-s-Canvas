import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { moduleDefinitions } from "../../shared/feature-catalog";
import { USAGE_ACTIONS, USAGE_CONTROLS, USAGE_FALLBACK_CONTROL_PATTERN, USAGE_CANVAS_CONTROL_PATTERN, USAGE_MAX_EVENT_AGE_MS, USAGE_MAX_EVENT_FUTURE_MS, type UsageControlKey, type UsageClientEvent, type UsageFilters, type UsageParameters, type UsageRecord, type UsageCoverage, type UsageSummary, type UsageBreakdowns } from "../../shared/usage-analytics";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";

export class UsageError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const usageBoardLabels = Object.fromEntries([...moduleDefinitions.map(item => [item.moduleKey, item.label]), ["home", "首页"], ["dashboard", "工作台"]]);
export const usageControlLabels: Record<string, string> = { navigation: "板块导航", model: "模型选择", size: "尺寸", resolution: "分辨率", quality: "画质", "reference-upload": "参考图上传", submit: "提交", export: "导出", tab: "页签", mask: "蒙版", settings: "参数设置", template: "模板", download: "下载", "copy-prompt": "复制提示词", favorite: "收藏", "search-filter": "筛选", "canvas-tool": "画布工具", "local-tool": "本地工具", dialog: "对话框", history: "历史记录", reset: "重置" };
export function usageControlLabel(key: string | null) {
  if (!key) return null;
  if (usageControlLabels[key]) return usageControlLabels[key]!;
  if (USAGE_CANVAS_CONTROL_PATTERN.test(key)) return `画布操作 · ${key.slice("canvas-tool.".length)}`;
  if (USAGE_FALLBACK_CONTROL_PATTERN.test(key)) { const [, tag, path] = key.split(":"); return `结构控件 · ${tag} #${path}`; }
  const commands: Record<string, string> = { undo: "撤销", redo: "重做", "delete-selection": "删除选中", paste: "粘贴", zoom: "缩放", drag: "拖动完成", "collection-gap": "采集缺口" };
  return commands[key] ?? "未记录控件";
}
const boardSchema = z.string().refine(value => Object.hasOwn(usageBoardLabels, value), "未知业务板块");
const sizeSchema = z.string().max(24).regex(/^(?:auto|[1-9]\d{0,4}(?:\.\d{1,2})?[:x][1-9]\d{0,4}(?:\.\d{1,2})?)$/);
export const usageParametersSchema = z.object({
  modelConfigId: z.string().uuid().optional(),
  resolution: z.enum(["0.5K", "1K", "2K", "4K", "720P", "1080P"]).optional(),
  aspectRatio: sizeSchema.optional(), size: sizeSchema.optional(),
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
  referenceCount: z.number().int().min(0).max(32).optional(),
  enabled: z.boolean().optional(), count: z.literal(1).optional(), droppedEventCount: z.number().int().min(1).max(100000).optional(),
  n: z.literal(1).optional(), width: z.number().int().min(1).max(32768).optional(), height: z.number().int().min(1).max(32768).optional(),
  duration: z.number().positive().max(3600).optional(), steps: z.number().int().min(1).max(1000).optional(), seed: z.number().int().min(-1).max(4294967295).optional(),
  strength: z.number().min(0).max(1).optional(), guidanceScale: z.number().min(0).max(100).optional(), creativity: z.number().min(0).max(100).optional(), redrawStrength: z.number().min(0).max(1).optional(),
  cutWidth: z.number().int().min(0).max(32768).optional(), redrawWidth: z.number().int().min(0).max(32768).optional(), blurAmount: z.number().min(0).max(1000).optional(),
  watermark: z.boolean().optional(), googleSearch: z.boolean().optional(), googleImageSearch: z.boolean().optional(), officialFallback: z.boolean().optional(), nsfw_check: z.boolean().optional(),
  background: z.enum(["auto", "transparent", "opaque"]).optional(), output_format: z.enum(["png", "jpeg", "webp"]).optional(), output_compression: z.number().int().min(0).max(100).optional(), moderation: z.enum(["auto", "low"]).optional(),
  midjourneySpeed: z.enum(["relax", "fast", "turbo"]).optional(), midjourneyQuality: z.number().min(.25).max(4).optional(),
  stylize: z.number().min(0).max(1000).optional(), chaos: z.number().min(0).max(100).optional(), weird: z.number().min(0).max(3000).optional(), stop: z.number().min(1).max(100).optional(), tile: z.boolean().optional(), raw: z.boolean().optional(),
}).strict();
export const usageEventsSchema = z.object({ events: z.array(z.object({
  eventId: z.string().uuid(), occurredAt: z.string().datetime({ offset: true }), boardKey: boardSchema,
  action: z.enum(USAGE_ACTIONS), controlKey: z.union([z.enum(USAGE_CONTROLS), z.string().refine(value => USAGE_FALLBACK_CONTROL_PATTERN.test(value) || USAGE_CANVAS_CONTROL_PATTERN.test(value)).transform(value => value as UsageControlKey)]).optional(), parameters: usageParametersSchema.optional(),
}).strict().refine(event => event.action === "visit" || !!event.controlKey, "交互必须使用语义控件标识")
  .refine(event => Date.now() - Date.parse(event.occurredAt) <= USAGE_MAX_EVENT_AGE_MS && Date.parse(event.occurredAt) - Date.now() <= USAGE_MAX_EVENT_FUTURE_MS, "离线事件必须在过去 7 天内且未来偏差不能超过 5 分钟")
  .refine(event => event.action === "gap" ? event.controlKey === "collection-gap" && !!event.parameters?.droppedEventCount : !event.parameters?.droppedEventCount && event.controlKey !== "collection-gap", "采集缺口必须使用专用事件"))
  .min(1).max(50) }).strict();
const filterShape = { userIds: z.array(z.string().uuid()).min(1).max(5000).optional(), search: z.string().trim().max(100).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), modelConfigId: z.string().uuid().optional(), boardKey: boardSchema.optional() };
const orderedDates = (value: UsageFilters) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to);
export const usageFiltersSchema = z.object(filterShape).strict().refine(orderedDates, "开始时间不能晚于结束时间");
export const usagePreviewSchema = z.object({ ...filterShape, includePromptSamples: z.boolean().default(false) }).strict().refine(orderedDates, "开始时间不能晚于结束时间");
export const usageQuerySchema = z.object({ from: filterShape.from, to: filterShape.to, modelConfigId: filterShape.modelConfigId, boardKey: boardSchema.optional(), search: filterShape.search, page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }).strict().refine(orderedDates, "开始时间不能晚于结束时间");

/** Preserve design prose, never credential-like values, links or inline image payloads. */
export function sanitizeUsagePrompt(value: unknown, names: string[] = []) {
  const original = typeof value === "string" ? value : "";
  let text = original
    .replace(/data:[^\s,;]+(?:;[^,]*)?,[^\s"'<>]+/gi, "[已移除内嵌数据]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[已移除链接]")
    .replace(/file:\/\/[^\s"'<>]+|(?:[A-Z]:\\|\\\\)[^\s"'<>]+|\/(?:Users|home|tmp|etc|var)\/[^\s"'<>]+/gi, "[已移除本地路径]")
    .replace(/\b(?:cookie|set-cookie|authorization)["']?\s*[:=]\s*[^\r\n]+/gi, "[已移除认证标头]")
    .replace(/(?:password|passwd|api[_ -]?key|secret|cookie|authorization|access[_ -]?token|refresh[_ -]?token|oa[_ -]?token|密码|密钥|令牌)["']?\s*[=:：]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;，；]+)/gi, "[已移除敏感字段]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[已移除凭据]")
    .replace(/\b(?:sk-|sk_|ghp_|github_pat_|AKIA)[A-Za-z0-9_\-]{8,}/g, "[已移除密钥]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[已移除令牌]")
    .replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, "[已移除长编码]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已移除邮箱]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[已移除手机号]");
  for (const name of new Set(names.filter(Boolean))) text = text.split(name).join("[员工]");
  return { text, redacted: text !== original };
}
export function safeUsageParameters(value: unknown): UsageParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: UsageParameters = {};
  for (const key of Object.keys(usageParametersSchema.shape)) {
    const mapped = key === "aspectRatio" ? input.aspectRatio ?? input.size : input[key];
    const parsed = usageParametersSchema.shape[key as keyof typeof usageParametersSchema.shape].safeParse(mapped);
    if (parsed.success && parsed.data !== undefined) Object.assign(result, { [key]: parsed.data });
  }
  // Current submissions are one image, but saved historical counts remain factual.
  for (const key of ["count", "n"] as const) if (typeof input[key] === "number" && Number.isInteger(input[key]) && input[key] >= 1 && input[key] <= 10000) result[key] = input[key];
  return result;
}
export async function insertUsageEvents(db: Database, userId: string, events: UsageClientEvent[]) {
  return withTransaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`usage:${userId}`]);
    const recent = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM usage_events WHERE user_id=$1 AND received_at>now()-interval '1 minute'", [userId]);
    if ((recent.rows[0]?.count ?? 0) + events.length > 600) throw new UsageError("USAGE_RATE_LIMIT", "使用记录过于频繁，请稍后发送", 429);
    let accepted = 0;
    for (const event of events) {
      if (event.parameters?.modelConfigId) {
        const model = await client.query("SELECT id FROM model_configs WHERE id=$1", [event.parameters.modelConfigId]);
        if (!model.rows.length) throw new UsageError("USAGE_MODEL_INVALID", "模型标识不存在");
      }
      const result = await client.query("INSERT INTO usage_events(event_id,user_id,board_key,action,control_key,parameters,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,event_id) DO NOTHING RETURNING id", [event.eventId, userId, event.boardKey, event.action, event.controlKey ?? null, event.parameters ?? {}, event.occurredAt]);
      accepted += result.rows.length;
    }
    return { accepted, duplicates: events.length - accepted };
  });
}
/** Only the newest actual user turn; continuation tool outputs are not typed prompts. */
export function submittedChatPrompt(input: unknown[]) {
  const last = input.at(-1);
  if (!last || typeof last !== "object" || !("role" in last) || last.role !== "user" || !("content" in last)) return { text: "", redacted: false };
  const text = typeof last.content === "string" ? last.content : Array.isArray(last.content)
    ? last.content.filter(part => part?.type === "input_text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
  return sanitizeUsagePrompt(text);
}
export async function beginUsageChat(db: Database, input: { userId: string; modelConfigId: string; boardKey: string; input: unknown[] }) {
  const id = randomUUID(); const prompt = submittedChatPrompt(input.input);
  await db.query("INSERT INTO usage_chat_requests(id,user_id,model_config_id,board_key,prompt,prompt_redacted) VALUES($1,$2,$3,$4,$5,$6)", [id, input.userId, input.modelConfigId, input.boardKey, prompt.text, prompt.redacted]);
  return id;
}
export async function finishUsageChat(db: Database, id: string, status: "success" | "failed" | "interrupted") {
  await db.query("UPDATE usage_chat_requests SET status=$2,updated_at=now() WHERE id=$1 AND status='processing'", [id, status]);
}

/** generation_history.task_id is UNIQUE: keep one row per task, never one row per output.
 * Costs are saved successful history amounts, not current prices or reservation estimates.
 * Output counts use saved image results, never requested n/count or video/audio results. */
export const usageRecordsCte = `WITH usage_records AS (
 SELECT 'event:'||e.id::text AS id,e.user_id,u.display_name,u.department_id,CASE WHEN e.action='visit' THEN 'visit' WHEN e.action='gap' THEN 'gap' ELSE 'interaction' END AS kind,e.board_key,e.action,e.control_key,(e.parameters->>'modelConfigId')::uuid AS model_config_id,'recorded'::text AS status,NULL::text AS prompt,false AS prompt_redacted,e.parameters,e.occurred_at,e.received_at AS updated_at,0::numeric AS total_rmb_cost,0::int AS generated_images,false AS missing_generation_history
 FROM usage_events e JOIN users u ON u.id=e.user_id WHERE COALESCE(u.is_guest,false)=false
 UNION ALL
 SELECT 'task:'||t.id::text,t.user_id,u.display_name,u.department_id,'generation',COALESCE(t.tool_key,t.parameters->>'tool'),t.operation_type,NULL,t.model_config_id,t.status,t.prompt,false,t.parameters,t.queued_at,t.updated_at,
 CASE WHEN t.status='success' AND h.status='success' THEN h.rmb_cost ELSE 0 END,
 CASE WHEN t.status='success' AND t.operation_type IN('image_generation','inpaint','upscale','batch_image','seamless_stitch') THEN
   (SELECT count(DISTINCT output.value #>> '{}')::int FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(COALESCE(h.result_urls,t.result_urls))='array' THEN COALESCE(h.result_urls,t.result_urls) ELSE '[]'::jsonb END
   ) AS output(value) WHERE jsonb_typeof(output.value)='string' AND btrim(output.value #>> '{}')<>''
     AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=substring(output.value #>> '{}' FROM '^/api/assets/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/content$')::uuid
       AND (a.kind<>'image' OR a.mime_type NOT LIKE 'image/%'))) ELSE 0 END,
 t.status='success' AND h.task_id IS NULL
 FROM tasks t JOIN users u ON u.id=t.user_id LEFT JOIN generation_history h ON h.task_id=t.id AND h.status='success' WHERE COALESCE(u.is_guest,false)=false
 UNION ALL
 SELECT 'chat:'||c.id::text,c.user_id,u.display_name,u.department_id,'chat',c.board_key,'chat',NULL,c.model_config_id,c.status,c.prompt,c.prompt_redacted,'{}'::jsonb,c.created_at,c.updated_at,0::numeric,0::int,false
 FROM usage_chat_requests c JOIN users u ON u.id=c.user_id WHERE COALESCE(u.is_guest,false)=false
)`;
const usageSearchPattern = (search: string) => `%${search.trim().replace(/[\\%_]/g, "\\$&")}%`;
export function usageSqlFilter(filters: UsageFilters, alias = "r") {
  const values: unknown[] = []; const clauses: string[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(`${alias}.${sql.replace("?", `$${values.length}`)}`); };
  if (filters.userIds) add("user_id=ANY(?::uuid[])", filters.userIds);
  if (filters.from) add("occurred_at>=?::timestamptz", filters.from);
  if (filters.to) add("occurred_at<?::timestamptz", filters.to);
  if (filters.modelConfigId) add("model_config_id=?::uuid", filters.modelConfigId);
  if (filters.boardKey) add("board_key=?", filters.boardKey);
  if (filters.search?.trim()) {
    values.push(usageSearchPattern(filters.search));
    clauses.push(`${alias}.user_id IN(SELECT id FROM users WHERE display_name ILIKE $${values.length} OR username ILIKE $${values.length})`);
  }
  return { values, where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "" };
}
const summarySelect = `count(*) FILTER(WHERE kind='visit')::int AS visits,count(*) FILTER(WHERE kind='interaction')::int AS interactions,count(*) FILTER(WHERE kind='generation')::int AS "generationRequests",count(*) FILTER(WHERE kind='chat')::int AS "chatRequests",count(*) FILTER(WHERE kind IN('generation','chat') AND status='success')::int AS succeeded,count(*) FILTER(WHERE kind IN('generation','chat') AND status IN('failed','cancelled','interrupted'))::int AS failed,count(*) FILTER(WHERE kind IN('generation','chat') AND status NOT IN('success','failed','cancelled','interrupted'))::int AS pending,COALESCE(sum(total_rmb_cost),0)::float8 AS "totalRmbCost",COALESCE(sum(generated_images),0)::int AS "generatedImages"`;
export const emptyUsageSummary = (): UsageSummary => ({ visits: 0, interactions: 0, generationRequests: 0, chatRequests: 0, succeeded: 0, failed: 0, pending: 0, totalRmbCost: 0, generatedImages: 0 });
export async function usageCoverage(db: Pick<Database, "query">, filters: UsageFilters = {}): Promise<UsageCoverage> {
  const result = await db.query("SELECT started_at AS \"startedAt\" FROM usage_collection_metadata WHERE singleton=true");
  const scope = usageSqlFilter(filters);
  const dropped = await db.query(`${usageRecordsCte} SELECT COALESCE(sum((parameters->>'droppedEventCount')::int) FILTER(WHERE kind='gap'),0)::int AS count,count(*) FILTER(WHERE missing_generation_history)::int AS missing_history FROM usage_records r ${scope.where}`, scope.values);
  const missingHistory = dropped.rows[0]?.missing_history ?? 0;
  return { collectionStartedAt: result.rows[0]?.startedAt ? new Date(result.rows[0].startedAt).toISOString() : null, historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, droppedEventCount: dropped.rows[0]?.count ?? 0, notes: ["历史生成记录来自现有任务表，每个任务只计一次；恢复和重试不增加生成请求。", "生成成本汇总已保存的成功生成历史人民币金额（含图片、视频和音频），不按新单价重算；不含未独立结算的聊天费用及失败、待处理任务的预估金额。", "成功出图张数按图片任务实际保存的非空、去重结果计算，不按请求次数或申请数量推算；视频和音频任务、已确认非图片的内部素材不计为图片。历史外部链接或缺少素材记录时沿用原图片任务类型。", ...(missingHistory ? [`当前筛选中有 ${missingHistory} 个成功任务缺少成功结算历史，费用未计入且不补估；已保存的图片结果仍计入张数。`] : []), "启用采集前的点击、访问及聊天正文未被记录，不能补推；记录缺失不等于未使用。", "客户端明确报告的队列溢出另计采集缺口；离线、关闭页面或未上报的缺口可能未知。", "成功/失败按任务当前状态统计，日期按首次提交时间以北京时间（Asia/Shanghai）归组；取消和中断计入失败。", "仅分析软件工作习惯，不评价人格、能力或绩效；不采集逐键输入、密码、令牌或图片字节。"] };
}
export async function usageSummary(db: Pick<Database, "query">, filters: UsageFilters): Promise<UsageSummary> {
  const scope = usageSqlFilter(filters);
  return (await db.query(`${usageRecordsCte} SELECT ${summarySelect} FROM usage_records r ${scope.where}`, scope.values)).rows[0] ?? emptyUsageSummary();
}
export async function usageBreakdowns(db: Pick<Database, "query">, filters: UsageFilters): Promise<UsageBreakdowns> {
  const scope = usageSqlFilter(filters);
  const group = async (column: string, extra = "") => (await db.query(`${usageRecordsCte} SELECT ${column} AS key,count(*)::int AS count FROM usage_records r ${scope.where}${extra ? `${scope.where ? " AND" : " WHERE"} ${extra}` : ""} GROUP BY ${column} ORDER BY count DESC,key`, scope.values)).rows;
  const boards = await group("board_key");
  const controls = await group("control_key", "kind='interaction'");
  const models = await db.query(`${usageRecordsCte} SELECT r.model_config_id::text AS key,COALESCE(m.name,'未知模型') AS label,count(*)::int AS count FROM usage_records r LEFT JOIN model_configs m ON m.id=r.model_config_id ${scope.where}${scope.where ? " AND" : " WHERE"} r.kind IN('generation','chat') GROUP BY r.model_config_id,m.name ORDER BY count DESC,key`, scope.values);
  const daily = await db.query(`${usageRecordsCte} SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,${summarySelect} FROM usage_records r ${scope.where} GROUP BY day ORDER BY day`, scope.values);
  return { boards: boards.map(row => ({ key: row.key ?? "unknown", label: usageBoardLabels[row.key] ?? "未记录板块", count: row.count })), controls: controls.map(row => ({ key: row.key ?? "unknown", label: usageControlLabel(row.key) ?? "未记录控件", count: row.count })), models: models.rows.map(row => ({ ...row, key: row.key ?? "unknown" })), daily: daily.rows };
}
export async function usagePeople(db: Database, filters: UsageFilters, query: { search?: string; page: number; pageSize: number }) {
  const search = filters.search ?? query.search;
  const scope = usageSqlFilter({ ...filters, search }); const values = [...scope.values];
  let userWhere = "WHERE COALESCE(u.is_guest,false)=false";
  if (filters.userIds) { values.push(filters.userIds); userWhere += ` AND u.id=ANY($${values.length}::uuid[])`; }
  if (search?.trim()) { values.push(usageSearchPattern(search)); userWhere += ` AND (u.display_name ILIKE $${values.length} OR u.username ILIKE $${values.length})`; }
  const base = `${usageRecordsCte}, stats AS (SELECT user_id,${summarySelect},max(occurred_at) AS "lastActivityAt" FROM usage_records r ${scope.where} GROUP BY user_id)`;
  const count = await db.query(`${base} SELECT count(*)::int AS total FROM users u ${userWhere}`, values);
  const result = await db.query(`${base} SELECT u.id AS "userId",u.display_name AS "displayName",d.name AS "departmentName",s.* FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN stats s ON s.user_id=u.id ${userWhere} ORDER BY s."lastActivityAt" DESC NULLS LAST,u.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, query.pageSize, (query.page - 1) * query.pageSize]);
  return { people: result.rows.map(row => ({ userId: row.userId, displayName: row.displayName, departmentName: row.departmentName, summary: Object.fromEntries(Object.entries(emptyUsageSummary()).map(([key]) => [key, row[key] ?? 0])) as UsageSummary, lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null })), pagination: { page: query.page, pageSize: query.pageSize, total: count.rows[0]?.total ?? 0 } };
}
export function mapUsageRecord(row: Record<string, any>): UsageRecord {
  const prompt = row.prompt === null ? null : sanitizeUsagePrompt(row.prompt);
  const boardKey = row.board_key || null;
  return { id: row.id, kind: row.kind, userId: row.user_id, displayName: row.display_name, boardKey, boardLabel: usageBoardLabels[boardKey] ?? "未记录板块", action: row.action, controlKey: row.control_key, controlLabel: usageControlLabel(row.control_key), modelConfigId: row.model_config_id, modelName: row.model_name ?? null, status: row.status, occurredAt: new Date(row.occurred_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), totalRmbCost: Number(row.total_rmb_cost ?? 0), generatedImages: Number(row.generated_images ?? 0), prompt: prompt?.text ?? null, promptRedacted: !!row.prompt_redacted || !!prompt?.redacted, parameters: safeUsageParameters(row.parameters) };
}
export async function usageRecords(db: Pick<Database, "query">, filters: UsageFilters, pagination: { page: number; pageSize: number }) {
  const scope = usageSqlFilter(filters);
  const count = await db.query(`${usageRecordsCte} SELECT count(*)::int AS total FROM usage_records r ${scope.where}`, scope.values);
  const result = await db.query(`${usageRecordsCte} SELECT r.*,m.name AS model_name FROM usage_records r LEFT JOIN model_configs m ON m.id=r.model_config_id ${scope.where} ORDER BY r.occurred_at DESC,r.id DESC LIMIT $${scope.values.length + 1} OFFSET $${scope.values.length + 2}`, [...scope.values, pagination.pageSize, (pagination.page - 1) * pagination.pageSize]);
  return { records: result.rows.map(mapUsageRecord), pagination: { ...pagination, total: count.rows[0]?.total ?? 0 } };
}
export const usageContentHash = (content: string) => createHash("sha256").update(content).digest("hex");
