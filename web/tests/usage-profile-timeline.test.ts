import { expect, test } from "bun:test";
import { groupActivityPage } from "../src/pages/admin/usage/profile-timeline";
import type { UsageV2Activity } from "../src/services/api/usage-analytics-v2";
const row = (id: string, occurredAt: string) => ({ id, occurredAt }) as UsageV2Activity;
test("profile timeline groups the loaded page at Beijing midnight without inventing absent days", () => {
    const records = [row("before", "2026-11-03T15:59:59Z"), row("after", "2026-11-03T16:00:00Z"), row("same", "2026-11-04T00:00:00Z")];
    expect(groupActivityPage(records).map((group) => [group.day, group.records.map((item) => item.id)])).toEqual([
        ["2026-11-04", ["after", "same"]],
        ["2026-11-03", ["before"]],
    ]);
    expect(records.map((item) => item.id)).toEqual(["before", "after", "same"]);
});
test("invalid timestamps remain visible as unknown and empty pages remain empty", () => {
    expect(groupActivityPage([row("bad", "invalid"), row("valid", "2026-11-03T16:00:00Z")]).map((group) => group.day)).toEqual(["2026-11-04", "日期未知"]);
    expect(groupActivityPage([])).toEqual([]);
});
