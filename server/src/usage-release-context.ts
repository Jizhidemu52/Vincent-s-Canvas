import type { UsageControlDaily, UsageReleaseContext } from "../../shared/usage-release-context";
import type { UsageV2Scope } from "../../shared/usage-analytics-v2";
import type { UsageQueryClient } from "./usage-rollup-reader";
import { usageBoardLabels, usageControlLabel } from "./usage-analytics";
import { usageFactWeight } from "./usage-event-aggregation";

const beijingDay = (value: string | Date) =>
    new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);

export async function readUsageReleaseContext(
    client: UsageQueryClient,
    scope: UsageV2Scope,
    observedAt: string,
): Promise<UsageReleaseContext> {
    const rows = (
        await client.query<{ version: string; title: string; published_at: string | Date }>(
            `SELECT version,title,published_at FROM release_notes
         WHERE published_at >= $1::timestamptz AND published_at < $2::timestamptz AND published_at <= $3::timestamptz
         ORDER BY published_at,version LIMIT 201`,
            [scope.from, scope.to, observedAt],
        )
    ).rows;
    return {
        source: "release_notes.published_at",
        scope: "global_publications_in_selected_dates",
        observedAt,
        limit: 200,
        truncated: rows.length > 200,
        releases: rows
            .slice(0, 200)
            .map((row) => ({
                version: row.version,
                title: row.title,
                publishedAt: new Date(row.published_at).toISOString(),
                day: beijingDay(row.published_at),
            })),
    };
}

type ControlFact = {
    kind: string;
    action: string;
    board_key: string | null;
    control_key: string | null;
    occurred_at: string | Date;
    eventWeight?: number;
};
/** Already-filtered facts; no extra historical read or release-to-feature inference. */
export function usageControlDaily(facts: readonly ControlFact[]): UsageControlDaily {
    const groups = new Map<string, UsageControlDaily["series"][number] & { counts: Map<string, number> }>();
    let missingControlRecords = 0;
    for (const fact of facts) {
        if (fact.kind !== "event" || ["visit", "gap"].includes(fact.action)) continue;
        if (!fact.control_key) {
            missingControlRecords += usageFactWeight(fact);
            continue;
        }
        const boardKey = fact.board_key ?? "unknown",
            controlKey = fact.control_key,
            key = JSON.stringify([boardKey, controlKey]);
        let row = groups.get(key);
        if (!row) {
            row = {
                boardKey,
                boardLabel: usageBoardLabels[boardKey] ?? "未知板块",
                controlKey,
                label: usageControlLabel(controlKey) ?? "未记录控件",
                total: 0,
                daily: [],
                counts: new Map(),
            };
            groups.set(key, row);
        }
        const day = beijingDay(fact.occurred_at);
        row.total += usageFactWeight(fact);
        row.counts.set(day, (row.counts.get(day) ?? 0) + usageFactWeight(fact));
    }
    const rows = [...groups.values()].sort(
        (a, b) => b.total - a.total || a.boardKey.localeCompare(b.boardKey) || a.controlKey.localeCompare(b.controlKey),
    );
    return {
        source: "usage_events",
        mappingSource: "existing_control_keys_and_labels",
        totalControls: rows.length,
        limit: 20,
        truncated: rows.length > 20,
        missingControlRecords,
        series: rows
            .slice(0, 20)
            .map(({ counts, ...row }) => ({
                ...row,
                daily: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
            })),
    };
}
