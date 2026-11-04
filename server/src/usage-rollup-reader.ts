import type { PoolClient } from "pg";
import type { UsageV2Scope, UsageV2Meta } from "../../shared/usage-analytics-v2";
import { UsageError } from "./usage-analytics";

export type UsageQueryClient = Pick<PoolClient, "query">;
export const usageDay = (value: string | Date) => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export const usageDayStart = (day: string) => `${day}T00:00:00+08:00`;
export function usageDays(fromDay: string, toDay: string) {
  const days: string[] = [];
  for (let at = Date.parse(`${fromDay}T00:00:00Z`), end = Date.parse(`${toDay}T00:00:00Z`); at <= end; at += 86400000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}
export const usageDailyFactsCte = `WITH facts AS (
  SELECT p.*,p.fact_id AS id,u.department_id AS current_department_id
  FROM usage_daily_facts p JOIN users u ON u.id=p.user_id WHERE COALESCE(u.is_guest,false)=false
)`;

// Source transactions must not lock the shared history row. Until a bounded
// analytics drain advances it, committed source markers establish older days.
// Retain that coverage after markers become dirty days or completed snapshots.
const usageHistoryFromSql = `LEAST(state.history_from,
  (SELECT min(day) FROM usage_source_invalidations),
  (SELECT min(day) FROM usage_dirty_days),
  (SELECT min(day) FROM usage_daily_snapshots))`;

/** Reads only projection metadata. No GET-triggered refresh or source-history fallback. */
export async function readUsageSnapshot(client: UsageQueryClient, scopes: UsageV2Scope[], observedAt: string, metricVersion: string): Promise<NonNullable<UsageV2Meta["snapshot"]>> {
  const today = usageDay(observedAt);
  const days = [...new Set(scopes.flatMap(scope => usageDays(usageDay(scope.from), usageDay(new Date(Date.parse(scope.to) - 1)))))]
    .filter(day => day <= today);
  const rows = (await client.query<{ day: string; computed_at: Date | string | null; metric_version: string | null; dirty: boolean }>(
    `SELECT r.day::text,s.computed_at,s.metric_version,((d.day IS NOT NULL AND d.ready_after<=$2::timestamptz)
       OR EXISTS(SELECT 1 FROM usage_source_invalidations i WHERE i.day=r.day)) AS dirty
     FROM unnest($1::date[]) r(day) CROSS JOIN usage_rollup_state state
     LEFT JOIN usage_daily_snapshots s ON s.day=r.day LEFT JOIN usage_dirty_days d ON d.day=r.day
     WHERE r.day>=${usageHistoryFromSql} ORDER BY r.day`, [days, observedAt],
  )).rows;
  const invalid = rows.filter(row => !row.computed_at || row.metric_version !== metricVersion || row.dirty);
  if (invalid.length) throw new UsageError("USAGE_ROLLUP_REFRESH_REQUIRED", `所选范围有 ${invalid.length} 天待回填或变更待补算；请刷新所选日期并等待任务完成，未返回过期统计`, 409);
  const times = rows.flatMap(row => row.computed_at ? [new Date(row.computed_at).toISOString()] : []).sort();
  // Empty ranges preceding known history are established by the migration's snapshot,
  // not by fabricated activity or this HTTP request's clock.
  const fallback = times.length ? times[0]! : new Date((await client.query<{ initialized_at: Date | string }>("SELECT initialized_at FROM usage_rollup_state WHERE singleton=true")).rows[0]!.initialized_at).toISOString();
  return { oldestComputedAt: times[0] ?? fallback, newestComputedAt: times.at(-1) ?? fallback, dayCount: rows.length, mixedSnapshots: new Set(times).size > 1 };
}
