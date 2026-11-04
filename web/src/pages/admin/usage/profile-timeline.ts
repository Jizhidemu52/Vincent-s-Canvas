import type { UsageV2Activity } from "@/services/api/usage-analytics-v2";

/** Group only the loaded page; a day may continue on another server page. */
export function groupActivityPage(records: UsageV2Activity[]) {
    const groups = new Map<string, UsageV2Activity[]>();
    for (const record of records) {
        const time = Date.parse(record.occurredAt);
        const day = Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : "日期未知";
        const group = groups.get(day) || [];
        group.push(record);
        groups.set(day, group);
    }
    return [...groups].sort(([a], [b]) => (a === "日期未知" ? 1 : b === "日期未知" ? -1 : b.localeCompare(a))).map(([day, rows]) => ({ day, records: rows }));
}
