import type { Database } from "./db";
import { UsageError } from "./usage-analytics";
import { usageComparisonScope, usageMoneyMicros, usageV2SqlFilter } from "./usage-analytics-v2";
import type { UsageV2Scope } from "../../shared/usage-analytics-v2";
import { USAGE_MATURE_RESULTS_VERSION, type UsageMaturePeriod, type UsageMatureResults, type UsageMatureSummary } from "../../shared/usage-mature-results";

const MAX_TASKS = 50_000, MAX_RELATED = 100_000, MAX_BYTES = 32 * 1024 * 1024;
const USE_TYPES = ["asset.downloaded", "asset.exported", "asset.project_added", "asset.reused", "asset.adopted", "asset.delivered"];
const IMAGE_OPERATIONS = ["image_generation", "inpaint", "upscale", "remove_background", "batch_image", "seamless_stitch"];
type ResultRef = { assetId: string | null; key: string };
type TaskRow = {
    id: string; user_id: string; current_period: boolean; comparison_period: boolean;
    maturity: "mature" | "immature" | "missing" | "invalid";
    results: ResultRef[] | null; booked: string | null; explicit_link: boolean;
};
type AssetRow = { id: string; task_id: string | null; owner_user_id: string; kind: string; mime_type: string; result_version: unknown; result_index: unknown; result_role: unknown };
type EventRow = { asset_id: string; event_type: string; before_completion: boolean; reversed: boolean };
type Result = { linked: boolean; events: EventRow[] };
type Task = TaskRow & { outputs: Result[]; beforeEvents: number; windowEvents: number; reversedEvents: number };
const amount = (value: bigint) => `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
const tooLarge = () => new UsageError("USAGE_MATURE_SCOPE_TOO_LARGE", "成熟结果窗超过 5 万任务、10 万关联记录或 32 MiB 读取预算；请缩小原筛选，未截断数据", 422);
const group = <T>(rows: T[], key: (row: T) => string) => {
    const result = new Map<string, T[]>();
    for (const row of rows) { const id = key(row), list = result.get(id) ?? []; list.push(row); result.set(id, list); }
    return result;
};
function resultIndex(asset: AssetRow): number | null {
    return asset.result_version === 1 && typeof asset.result_index === "number" && Number.isSafeInteger(asset.result_index) && asset.result_index >= 0 && ["primary", "provider-original", "export"].includes(String(asset.result_role)) ? asset.result_index : null;
}
function summarize(tasks: Task[]): UsageMatureSummary {
    const outputs = tasks.flatMap(task => task.outputs), known = tasks.filter(task => task.booked !== null);
    const outputKnownTasks = tasks.filter(task => task.outputs.length > 0).length, missingOutputTasks = tasks.length - outputKnownTasks;
    const linkedResults = outputs.filter(result => result.linked).length, unknownBindingResults = outputs.length - linkedResults;
    const usedResults = outputs.filter(result => result.events.length > 0).length;
    const formallyAdoptedResults = outputs.filter(result => result.events.some(event => ["asset.adopted", "asset.delivered"].includes(event.event_type))).length;
    const rate = (numerator: number) => ({ value: outputs.length && linkedResults ? numerator / outputs.length : null,
        state: !outputs.length || !linkedResults ? "unavailable" as const : missingOutputTasks || unknownBindingResults ? "partial" as const : "available" as const });
    const total = known.reduce((sum, task) => sum + usageMoneyMicros(task.booked!), 0n);
    const costState = !known.length ? "unavailable" : known.length === tasks.length ? "available" : "partial";
    return {
        tasks: tasks.length, outputKnownTasks, missingOutputTasks, generatedResults: outputs.length, linkedResults, unknownBindingResults,
        usedResults, formallyAdoptedResults, linkedNoEvidenceResults: outputs.filter(result => result.linked && !result.events.length).length,
        clientReportedUsedResults: outputs.filter(result => result.events.some(event => ["asset.downloaded", "asset.exported"].includes(event.event_type))).length,
        serverConfirmedUsedResults: outputs.filter(result => result.events.some(event => !["asset.downloaded", "asset.exported"].includes(event.event_type))).length,
        beforeCompletionEvents: tasks.reduce((sum, task) => sum + task.beforeEvents, 0),
        windowEvents: tasks.reduce((sum, task) => sum + task.windowEvents, 0),
        reversedWindowEvents: tasks.reduce((sum, task) => sum + task.reversedEvents, 0),
        useRate: rate(usedResults), adoptionRate: rate(formallyAdoptedResults),
        cost: { bookedAmount: known.length ? amount(total) : null, settledTasks: known.length, missingSettlementTasks: tasks.length - known.length, state: costState,
            perRecordedUsedResult: usedResults && known.length ? amount((total + BigInt(Math.floor(usedResults / 2))) / BigInt(usedResults)) : null,
            perUsedState: !usedResults || !known.length ? "unavailable" : costState === "partial" || rate(usedResults).state !== "available" ? "partial" : "available" },
    };
}
function period(tasks: Task[], scope: UsageV2Scope): UsageMaturePeriod {
    const mature = tasks.filter(task => task.maturity === "mature");
    return { from: scope.from, to: scope.to,
        cohort: { successfulImageTasks: tasks.length, matureTasks: mature.length, immatureTasks: tasks.filter(task => task.maturity === "immature").length,
            missingCompletedAtTasks: tasks.filter(task => task.maturity === "missing").length, invalidTimelineTasks: tasks.filter(task => task.maturity === "invalid").length },
        all: summarize(mature), optimizationGroups: [
            { key: "explicit_link", summary: summarize(mature.filter(task => task.explicit_link)) },
            { key: "no_explicit_marker", summary: summarize(mature.filter(task => !task.explicit_link)) },
        ],
    };
}

/** Independent historical-cutoff read. Never consume current rollup event state or change global rates. */
export async function readUsageMatureResults(db: Database, scope: UsageV2Scope): Promise<UsageMatureResults> {
    const comparisonScope = usageComparisonScope(scope), values: unknown[] = [];
    const condition = (selected: UsageV2Scope) => {
        const filter = usageV2SqlFilter(selected), offset = values.length;
        values.push(...filter.values);
        return filter.where.slice("WHERE ".length).replace(/\$(\d+)/g, (_match, number: string) => `$${Number(number) + offset}`);
    };
    const currentWhere = condition(scope), comparisonWhere = comparisonScope ? condition(comparisonScope) : "false";
    const urls = "COALESCE(h.result_urls,t.result_urls)";
    // Expose only one-way URL identity and an asset UUID to the application, never URLs or task bodies.
    const refs = `(SELECT jsonb_agg(jsonb_build_object('assetId',substring(v#>>'{}' from '^/api/assets/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/content$'),'key',md5(v#>>'{}'))) FROM (SELECT DISTINCT v FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${urls})='array' THEN ${urls} ELSE '[]'::jsonb END) v WHERE jsonb_typeof(v)='string' AND btrim(v#>>'{}')<>'') unique_urls)`;
    const cte = `WITH facts AS (SELECT t.id,t.user_id,t.queued_at AS occurred_at,t.department_id AS event_department_id,u.department_id AS current_department_id,
        COALESCE(t.tool_key,t.parameters->>'tool') AS board_key,t.model_config_id,t.operation_type,
        CASE WHEN t.completed_at IS NULL THEN 'missing' WHEN NOT isfinite(t.completed_at) OR t.completed_at<t.queued_at OR t.completed_at>transaction_timestamp() OR (t.started_at IS NOT NULL AND (NOT isfinite(t.started_at) OR t.started_at<t.queued_at OR t.started_at>t.completed_at)) THEN 'invalid'
        WHEN t.completed_at + interval '168 hours'<=transaction_timestamp() THEN 'mature' ELSE 'immature' END AS maturity,
        ${refs} AS results,h.rmb_cost::text AS booked,
        EXISTS(SELECT 1 FROM prompt_compilations c WHERE c.id=t.prompt_compilation_id AND c.user_id=t.user_id::text) AS explicit_link
        FROM tasks t JOIN users u ON u.id=t.user_id LEFT JOIN generation_history h ON h.task_id=t.id AND h.status='success' AND h.user_id=t.user_id
        WHERE t.status='success' AND t.operation_type=ANY(ARRAY[${IMAGE_OPERATIONS.map(value => `'${value}'`).join(",")}]) AND COALESCE(u.is_guest,false)=false AND t.queued_at<=transaction_timestamp()),
        selected AS (SELECT f.id,f.user_id,f.maturity,f.results,f.booked,f.explicit_link,(${currentWhere}) AS current_period,(${comparisonWhere}) AS comparison_period FROM facts f WHERE (${currentWhere}) OR (${comparisonWhere}))`;
    const client = await db.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL statement_timeout='15000ms'");
        const snapshot = (await client.query<{ snapshot_at: string | Date }>("SELECT transaction_timestamp() AS snapshot_at")).rows[0]!;
        const asOf = new Date(snapshot.snapshot_at).toISOString();
        const budget = (await client.query<{ count: number; bytes: string; results: string }>(`${cte} SELECT count(*)::int AS count,COALESCE(sum(octet_length(row_to_json(s)::text)),0)::text AS bytes,COALESCE(sum(jsonb_array_length(s.results)),0)::text AS results FROM selected s`, values)).rows[0]!;
        if (Number(budget.count) > MAX_TASKS || Number(budget.bytes) > MAX_BYTES || Number(budget.results) > MAX_RELATED) throw tooLarge();
        const rows = (await client.query<TaskRow>(`${cte} SELECT s.id,s.user_id,s.maturity,s.results,s.booked,s.explicit_link,s.current_period,s.comparison_period FROM selected s`, values)).rows;
        const mature = rows.filter(task => task.maturity === "mature"), ids = mature.map(task => task.id);
        const referenced = [...new Set(mature.flatMap(task => (task.results ?? []).flatMap(ref => ref.assetId ? [ref.assetId.toLowerCase()] : [])))];
        const assets = ids.length ? (await client.query<AssetRow>(`SELECT id,task_id,owner_user_id,kind,mime_type,
            CASE WHEN jsonb_typeof(metadata->'imageResult'->'version')='number' AND length((metadata->'imageResult'->'version')::text)<16 THEN metadata->'imageResult'->'version' END AS result_version,
            CASE WHEN jsonb_typeof(metadata->'imageResult'->'resultIndex')='number' AND length((metadata->'imageResult'->'resultIndex')::text)<16 THEN metadata->'imageResult'->'resultIndex' END AS result_index,
            CASE WHEN metadata->'imageResult'->>'role' IN ('primary','provider-original','export') THEN metadata->'imageResult'->>'role' END AS result_role
            FROM assets WHERE task_id=ANY($1::uuid[]) OR id=ANY($2::uuid[]) LIMIT ${MAX_RELATED + 1}`, [ids, referenced])).rows : [];
        if (assets.length > MAX_RELATED) throw tooLarge();
        const imageAssets = assets.filter(asset => asset.kind === "image" && asset.mime_type.startsWith("image/"));
        const byId = new Map(assets.map(asset => [asset.id, asset])), byResult = group(imageAssets.filter(asset => resultIndex(asset) !== null), asset => `${asset.task_id}:${asset.owner_user_id}:${resultIndex(asset)}`);
        // Keep PostgreSQL timestamp precision at both half-open boundaries. first_effective is deliberately ignored.
        const events = ids.length ? (await client.query<EventRow>(`SELECT e.asset_id,e.event_type,(e.occurred_at<t.completed_at) AS before_completion,
            EXISTS(SELECT 1 FROM asset_events r WHERE r.source_event_id=e.id AND r.event_type='asset.event_reversed'
                AND r.asset_id=e.asset_id AND r.task_id=e.task_id AND r.designer_user_id=e.designer_user_id
                AND r.occurred_at>=e.occurred_at AND r.occurred_at<t.completed_at+interval '168 hours') AS reversed
            FROM asset_events e JOIN assets a ON a.id=e.asset_id JOIN tasks t ON t.id=a.task_id
            WHERE t.id=ANY($1::uuid[]) AND e.task_id=t.id AND e.designer_user_id=t.user_id AND a.owner_user_id=t.user_id
                AND a.kind='image' AND a.mime_type LIKE 'image/%' AND e.event_type=ANY($2::text[])
                AND e.occurred_at<t.completed_at+interval '168 hours' LIMIT ${MAX_RELATED + 1}`, [ids, USE_TYPES])).rows : [];
        if (events.length > MAX_RELATED) throw tooLarge();
        const eventsByAsset = group(events, event => event.asset_id);
        const tasks: Task[] = rows.map(task => {
            const outputs = new Map<string, Result>(), associatedIds = new Set<string>();
            if (task.maturity === "mature") for (const ref of task.results ?? []) {
                const asset = byId.get(ref.assetId?.toLowerCase() ?? "");
                if (asset && (asset.kind !== "image" || !asset.mime_type.startsWith("image/"))) continue;
                const owned = asset && asset.task_id === task.id && asset.owner_user_id === task.user_id;
                const index = owned ? resultIndex(asset) : null, key = index === null ? ref.assetId ? `asset:${ref.assetId.toLowerCase()}` : ref.key : `result:${index}`;
                const related = owned ? index === null ? [asset] : byResult.get(`${task.id}:${task.user_id}:${index}`) ?? [asset] : [];
                for (const candidate of related) associatedIds.add(candidate.id);
                const evidence = related.flatMap(candidate => eventsByAsset.get(candidate.id) ?? []).filter(event => !event.before_completion && !event.reversed);
                const previous = outputs.get(key);
                outputs.set(key, { linked: Boolean(owned) || Boolean(previous?.linked), events: [...previous?.events ?? [], ...evidence] });
            }
            const relevant = [...associatedIds].flatMap(id => eventsByAsset.get(id) ?? []);
            return { ...task, outputs: [...outputs.values()], beforeEvents: relevant.filter(event => event.before_completion).length,
                windowEvents: relevant.filter(event => !event.before_completion).length,
                reversedEvents: relevant.filter(event => !event.before_completion && event.reversed).length };
        });
        const result: UsageMatureResults = { meta: { metricVersion: USAGE_MATURE_RESULTS_VERSION, scope, comparisonScope, asOf, observationHours: 168, dataMode: "live_existing_result_events", notes: [
            "按原提交时间 [from,to) 与全部原筛选选取成功图片任务；本期、对比期同一次只读事务。独立读取既有任务、结果与事件，不使用日汇总，不改全局涨跌。",
            "成熟仅指任务 completed_at + 168 小时不晚于观察点；它不是单图完成时间。未成熟、缺完成时间和异常时间单列，不混入成熟分母。",
            "仅计 [completed_at,completed_at+168小时) 的使用事件；截止前有效撤销才扣除，第8天撤销不抹掉第7天证据。完成前事件独立诊断，不作为使用；不按 first_effective 排除回执。",
            "分母是成熟任务最终保存的去重图片结果，含无法绑定资产的结果；同任务同用户的 original/export 副本按结果序号去重。缺输出不能确立分母，不补零；未知绑定与缺输出使费率或使用率不完整。当前软删除状态不筛历史结果。",
            "下载开始/导出属于客户端回执，可漏报；加入项目、带入复用编辑器、采纳/交付属于服务端事件，不保证真正完成后续设计或业务交付。无记录仅表示窗口内无已记录证据，不等于真实未用；各证据类别可重叠。",
            "费用仅取同成熟成功图片任务 generation_history 的 CNY 已记账金额，不用模型现价或任务预估，不等于实付。每已记录使用图费用=该成熟队列全部已记账金额/已记录使用结果数，不是使用图片自身成本；缺结算保留不完整，零分母不可用。",
            "优化组仅分同用户真实编译关联与无明确关联标记；无标记不等于未优化。不同模型/板块/操作混合，组间差异不能推断优化因果效果，也不作人员绩效评价。",
            "这是当前数据库对历史窗口的重建，不承诺不可变历史；完整观察时间不等于完整采集。除回显原请求筛选外，响应仅有聚合，不增加员工身份、提示词、媒体地址、原始错误或任务明细。",
        ] }, current: period(tasks.filter(task => task.current_period), scope), comparison: comparisonScope ? period(tasks.filter(task => task.comparison_period), comparisonScope) : null };
        await client.query("COMMIT");
        return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
}
