import { type UsageRollupJob, type UsageRollupRequest, validUsageRollupJob } from "@/services/api/usage-analytics-v2";
import { beijingDay, usageQuery, type UsageFilterForm } from "./filters";
export type RollupAttempt = { request: UsageRollupRequest; job: UsageRollupJob | null; rejected: boolean };
export type DayRange = { fromDay: string; toDay: string };
export function rollupRangeError(range: DayRange, now = new Date()) {
    const start = Date.parse(`${range.fromDay}T00:00:00Z`),
        end = Date.parse(`${range.toDay}T00:00:00Z`);
    if (
        ![range.fromDay, range.toDay].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        new Date(start).toISOString().slice(0, 10) !== range.fromDay ||
        new Date(end).toISOString().slice(0, 10) !== range.toDay ||
        start > end
    )
        return "请选择有效的起止日期。";
    if ((end - start) / 86400000 + 1 > 31) return "一次重算最多 31 天，请缩短所选日期；不会截断或自动拆分新任务。";
    if (range.toDay > beijingDay(now)) return "日事实不能刷新未来日期，请调整范围。";
    return "";
}
/** Mirrors the backend half-open Beijing comparison interval, including leap-day clamps. */
export function comparisonDayRange(filters: UsageFilterForm): DayRange | null {
    if (filters.compare === "none") return null;
    const scope = usageQuery(filters),
        from = Date.parse(scope.from!),
        to = Date.parse(scope.to!);
    const priorYear = (value: number) => {
        const date = new Date(value + 8 * 3600000),
            month = date.getUTCMonth();
        date.setUTCFullYear(date.getUTCFullYear() - 1);
        if (date.getUTCMonth() !== month) date.setUTCDate(0);
        return date.getTime() - 8 * 3600000;
    };
    const priorFrom = filters.compare === "previous_year" ? priorYear(from) : from - (to - from);
    const candidateTo = filters.compare === "previous_year" ? priorYear(to) : from;
    const priorTo = candidateTo > priorFrom ? candidateTo : priorFrom + to - from;
    return { fromDay: beijingDay(new Date(priorFrom)), toDay: beijingDay(new Date(priorTo - 1)) };
}
export function rollupTerminal(job: UsageRollupJob | null) {
    return job?.status === "completed" || job?.status === "failed";
}
const storageKey = (actorId: string) => `usage-rollup-attempt:${actorId}`;
export function readRollupAttempt(actorId: string): RollupAttempt | null {
    try {
        const value = JSON.parse(sessionStorage.getItem(storageKey(actorId)) || "null") as RollupAttempt | null;
        if (!value || !value.request || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.request.idempotencyKey) || rollupRangeError(value.request) || typeof value.rejected !== "boolean") return null;
        if (value.job !== null && (!validUsageRollupJob(value.job) || value.job.fromDay !== value.request.fromDay || value.job.toDay !== value.request.toDay)) return null;
        return value;
    } catch {
        return null;
    }
}
export function saveRollupAttempt(actorId: string, value: RollupAttempt) {
    try {
        sessionStorage.setItem(storageKey(actorId), JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}
export function abortableRollupDelay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}
