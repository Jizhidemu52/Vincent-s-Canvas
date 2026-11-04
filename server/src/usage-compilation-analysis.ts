import type { Database } from "./db";
import { UsageError } from "./usage-analytics";
import { usageComparisonScope, usageOptimizationMoneyMicros } from "./usage-analytics-v2";
import type { UsageV2Scope } from "../../shared/usage-analytics-v2";
import {
    USAGE_COMPILATION_ANALYSIS_VERSION,
    unsupportedCompilationFilters,
    type UsageCompilationAnalysis,
    type UsageCompilationNumber,
    type UsageCompilationPeriod,
    type UsageCompilationStatuses,
    type UsageCompilationSummary,
} from "../../shared/usage-compilation-analysis";

const MAX_ROWS = 50_000;
const MAX_LINKED_TASKS = 100_000;
type CompilationRow = {
    id: string;
    created_at: string;
    reused_from_id: string | null;
    effective_status: keyof UsageCompilationStatuses;
    source_created_at: string | null;
    source_id: string | null;
    admin_test: string | null;
    latency: string | null;
    input_tokens: string | null;
    output_tokens: string | null;
    actual: string | null;
    estimated: string | null;
    currency: string | null;
    linked_tasks: number;
};
const emptyStatuses = (): UsageCompilationStatuses => ({ success: 0, failed: 0, uncertain: 0, optimizing: 0 });
const amount = (value: bigint) => `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
const number = (value: string | null) => value !== null && /^\d{1,16}(?:\.\d{1,6})?$/.test(value) && Number.isFinite(Number(value)) && Number(value) <= Number.MAX_SAFE_INTEGER ? Number(value) : null;
const tokenCount = (value: string | null) => {
    const parsed = number(value);
    return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};
function tokenMetric(rows: CompilationRow[], field: "input_tokens" | "output_tokens"): UsageCompilationNumber {
    const values = rows.map(row => tokenCount(row[field])).filter((value): value is number => value !== null);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(total)) throw new UsageError("USAGE_COMPILATION_VALUE_OVERFLOW", "编译 Token 合计超过精确计数范围；请缩小筛选，未返回不精确合计", 422);
    return { value: values.length ? total : null, state: !values.length ? "unavailable" : values.length === rows.length ? "available" : "partial", availableCount: values.length, missingCount: rows.length - values.length };
}
function quantile(values: number[], p: number) {
    if (!values.length) return null;
    const position = (values.length - 1) * p, lower = Math.floor(position), fraction = position - lower;
    return values[lower]! + (values[Math.ceil(position)]! - values[lower]!) * fraction;
}
function summarize(rows: CompilationRow[], periodIds: Set<string>, asOf: string): UsageCompilationSummary {
    const sources = rows.filter(row => !row.reused_from_id), statuses = emptyStatuses(), sourceStatuses = emptyStatuses();
    const adminTests = { yes: 0, no: 0, unknown: 0 };
    const statusOf = (row: CompilationRow) => {
        if (row.reused_from_id && !row.source_id) return "uncertain";
        if (row.effective_status === "optimizing" && row.source_created_at && Date.parse(asOf) - Date.parse(row.source_created_at) > 200_000) return "uncertain";
        return row.effective_status;
    };
    for (const row of rows) {
        statuses[statusOf(row)]++;
        adminTests[row.admin_test === "true" ? "yes" : row.admin_test === "false" ? "no" : "unknown"]++;
    }
    for (const row of sources) sourceStatuses[statusOf(row)]++;
    const latencies = sources.map(row => number(row.latency)).filter((value): value is number => value !== null).sort((a, b) => a - b);
    const currencies = new Map<string, { sourceCalls: number; actual: bigint; estimated: bigint; actualCount: number; estimatedCount: number; unknownCount: number }>();
    for (const row of sources) {
        const currency = row.currency && /^[A-Z]{3}$/.test(row.currency) ? row.currency : "unknown";
        const group = currencies.get(currency) ?? { sourceCalls: 0, actual: 0n, estimated: 0n, actualCount: 0, estimatedCount: 0, unknownCount: 0 };
        const actual = currency === "unknown" ? null : usageOptimizationMoneyMicros(row.actual);
        const estimated = currency === "unknown" ? null : usageOptimizationMoneyMicros(row.estimated);
        group.sourceCalls++;
        if (actual !== null) { group.actual += actual; group.actualCount++; }
        else if (estimated !== null) { group.estimated += estimated; group.estimatedCount++; }
        else group.unknownCount++;
        currencies.set(currency, group);
    }
    const linkedRequests = rows.filter(row => row.linked_tasks > 0).length;
    return {
        requests: rows.length, linkedRequests, unlinkedRequests: rows.length - linkedRequests,
        linkedTasks: rows.reduce((sum, row) => sum + row.linked_tasks, 0), sourceCalls: sources.length, cacheHits: rows.length - sources.length,
        cacheSourceOutsideScope: rows.filter(row => row.reused_from_id && row.source_id && !periodIds.has(row.source_id)).length,
        cacheSourceMissing: rows.filter(row => row.reused_from_id && !row.source_id).length,
        statuses, sourceStatuses, adminTests,
        inputTokens: tokenMetric(sources, "input_tokens"), outputTokens: tokenMetric(sources, "output_tokens"),
        completeTokenCalls: sources.filter(row => tokenCount(row.input_tokens) !== null && tokenCount(row.output_tokens) !== null).length,
        latency: { sourceCalls: sources.length, availableCount: latencies.length, missingCount: sources.length - latencies.length,
            meanMs: latencies.length ? latencies.reduce((sum, value) => sum + value / latencies.length, 0) : null,
            p50Ms: quantile(latencies, 0.5), p90Ms: quantile(latencies, 0.9) },
        costs: [...currencies].sort(([a], [b]) => a.localeCompare(b)).map(([currency, row]) => ({ currency,
            sourceCalls: row.sourceCalls, actualAmount: row.actualCount ? amount(row.actual) : null, estimatedAmount: row.estimatedCount ? amount(row.estimated) : null,
            actualCount: row.actualCount, estimatedCount: row.estimatedCount, unknownCount: row.unknownCount })),
    };
}
function period(rows: CompilationRow[], scope: UsageV2Scope, asOf: string): UsageCompilationPeriod {
    const selected = rows.filter(row => Date.parse(row.created_at) >= Date.parse(scope.from) && Date.parse(row.created_at) < Date.parse(scope.to));
    const ids = new Set(selected.map(row => row.id));
    return { from: scope.from, to: scope.to, all: summarize(selected, ids, asOf),
        linked: summarize(selected.filter(row => row.linked_tasks > 0), ids, asOf),
        unlinked: summarize(selected.filter(row => row.linked_tasks === 0), ids, asOf) };
}
/** Existing compilation metadata only. No prompt/rules/raw errors, new collection or provider calls. */
export async function readUsageCompilationAnalysis(db: Database, scope: UsageV2Scope): Promise<UsageCompilationAnalysis> {
    const unsupported = unsupportedCompilationFilters(scope);
    if (unsupported.length) throw new UsageError("USAGE_COMPILATION_FILTER_UNSUPPORTED", `编译记录缺少可比口径，不支持当前筛选：${unsupported.join("、")}；未自动移除或扩大范围`, 400);
    const comparisonScope = usageComparisonScope(scope), values: unknown[] = [];
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const windows = [scope, ...(comparisonScope ? [comparisonScope] : [])].map(selected => `(c.created_at::timestamptz>=${bind(selected.from)}::timestamptz AND c.created_at::timestamptz<${bind(selected.to)}::timestamptz)`);
    const where = [`(${windows.join(" OR ")})`, "c.created_at::timestamptz<=transaction_timestamp()"];
    if (scope.userIds?.length) where.push(`c.user_id=ANY(${bind(scope.userIds)}::text[])`);
    if (scope.departmentIds?.length) where.push(`u.department_id=ANY(${bind(scope.departmentIds)}::uuid[])`);
    if (scope.search) {
        const pattern = bind(`%${scope.search.replace(/[\\%_]/g, value => `\\${value}`)}%`);
        where.push(`(u.display_name ILIKE ${pattern} OR u.username ILIKE ${pattern})`);
    }
    const scalar = (field: string, type: "number" | "string" | "boolean" = "number") => `CASE WHEN jsonb_typeof(c.details->'${field}')='${type}' AND length(c.details->>'${field}')<=64 THEN c.details->>'${field}' END`;
    const client = await db.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL statement_timeout='15000ms'");
        const snapshot = (await client.query<{ snapshot_at: string | Date }>("SELECT transaction_timestamp() AS snapshot_at")).rows[0]!;
        const asOf = new Date(snapshot.snapshot_at).toISOString();
        // Read only individual scalar metadata. Never load c.details/r.details or task bodies.
        const rows = (await client.query<CompilationRow>(`SELECT c.id,c.created_at,c.reused_from_id,
            COALESCE(r.status,c.status) AS effective_status,COALESCE(r.created_at,c.created_at) AS source_created_at,r.id AS source_id,
            ${scalar("adminTest", "boolean")} AS admin_test,${scalar("latencyMs")} AS latency,
            ${scalar("inputTokens")} AS input_tokens,${scalar("outputTokens")} AS output_tokens,
            ${scalar("actualCost")} AS actual,${scalar("estimatedCost")} AS estimated,${scalar("currency", "string")} AS currency
            FROM prompt_compilations c LEFT JOIN users u ON u.id::text=c.user_id
            LEFT JOIN prompt_compilations r ON r.id=c.reused_from_id AND r.user_id=c.user_id AND r.reused_from_id IS NULL
            WHERE ${where.join(" AND ")} ORDER BY c.created_at,c.id LIMIT ${MAX_ROWS + 1}`, values)).rows;
        if (rows.length > MAX_ROWS) throw new UsageError("USAGE_COMPILATION_SCOPE_TOO_LARGE", "本期与对比期编译记录超过 5 万条读取预算；请缩小日期或人员范围，未截断数据", 422);
        const linked = rows.length ? (await client.query<{ compilation_id: string; count: string }>(`SELECT c.id AS compilation_id,count(*)::text AS count
            FROM tasks t JOIN prompt_compilations c ON c.id=t.prompt_compilation_id AND c.user_id=t.user_id::text
            WHERE c.id=ANY($1::text[]) AND t.queued_at<=$2::timestamptz GROUP BY c.id`, [rows.map(row => row.id), asOf])).rows : [];
        if (linked.reduce((sum, row) => sum + Number(row.count), 0) > MAX_LINKED_TASKS) throw new UsageError("USAGE_COMPILATION_SCOPE_TOO_LARGE", "关联任务超过 10 万条预算；请缩小日期或人员范围，未截断数据", 422);
        const linkedById = new Map(linked.map(row => [row.compilation_id, Number(row.count)]));
        for (const row of rows) row.linked_tasks = linkedById.get(row.id) ?? 0;
        const result: UsageCompilationAnalysis = {
            meta: { metricVersion: USAGE_COMPILATION_ANALYSIS_VERSION, scope, comparisonScope, asOf, dataMode: "live_existing_compilations", notes: [
                "独立读取既有 prompt_compilations；按编译创建时间归入 [from,to)，北京时间解释日期，本期与对比期来自同一次只读事务。不是日汇总快照。",
                "全部编译包含管理员测试与身份未标记记录；管理员测试 true/false/未记录分别统计，不等同员工使用量。相同 requestId 的重试未新增记录，不是 HTTP 请求总量。",
                "已关联仅指当前观察点存在同用户 tasks.prompt_compilation_id 真正外键；关联任务日期不限定在编译期内。未关联不表示从未提交、放弃或无价值；源编译与复用编译各自按直接外键分组。",
                "缓存记录状态跟随同用户原始源；超过 200 秒仍 optimizing 按既有展示规则标为待核查，缺源也为待核查；只读推导，不写回状态，待核查不并入失败。成功包含可能的基础模板回退，不等同优化成功或图片生成成功。",
                "源调用指本期原筛选中无 reused_from_id 的编译记录，不证明供应商已接受或扣费；缓存不重复计算 Token、耗时和费用。范围外缓存源仅统计数量，旧调用费用不挪入本期。",
                "Token 与耗时只统计源调用白名单有效数值；未记录/无效保持缺失，零仅用于明确记载的零。耗时是编译器记录 latencyMs，不是员工工时或供应商纯推理时长。",
                "费用仅使用当时存储的 actualCost/estimatedCost/currency；按币种分列、不汇率换算、不用现价回填。已记录金额不是最终账单；估算独立，缺值不可用，金额六位小数逐笔半进位。",
                "支持日期、人员、姓名搜索和当前部门；没有事件时部门、板块或操作快照，且生成模型筛选不等同扩写模型筛选，不支持的共享筛选会拒绝，绝不自动清空。",
            ] },
            current: period(rows, scope, asOf), comparison: comparisonScope ? period(rows, comparisonScope, asOf) : null,
        };
        await client.query("COMMIT");
        return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
}
