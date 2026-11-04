import { afterEach, expect, test } from "bun:test";
import React from "react";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { getPeopleTeamComparison, validPeopleComparison } from "../src/services/api/usage-people-comparison";
import PeopleComparison, { peopleComparisonExport } from "../src/pages/admin/usage/people-comparison";
import { peopleComparisonFixture } from "./usage-v2-browser/people-comparison-fixture";
import type { UsageV2Query } from "../../shared/usage-analytics-v2";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
const extra = "10000000-0000-4000-8000-000000000003";
const query: UsageV2Query = { from: "2026-09-30T16:00:00.000Z", to: "2026-10-07T16:00:00.000Z", compare: "none", departmentBasis: "current", userIds: [...ids, extra], boardKeys: ["image"], operationTypes: ["image_generation"], search: "员工" };

test("comparison sends exactly one original scope plus selection, not selection as team scope", async () => {
    const calls: Array<{ url: string; options?: RequestInit }> = [];
    globalThis.fetch = (async (input, options) => { calls.push({ url: String(input), options }); return Response.json({ code: 0, data: peopleComparisonFixture(query, ids) }); }) as typeof fetch;
    const result = await getPeopleTeamComparison(query, ids);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/admin/usage/people-compare");
    expect(calls[0].options).toMatchObject({ method: "POST", credentials: "include", cache: "no-store" });
    expect(JSON.parse(String(calls[0].options?.body))).toEqual({ filters: query, selectedUserIds: ids });
    expect(result.meta.scope.userIds).toEqual([...ids, extra]);
    expect(result.people.map(person => person.userId)).toEqual(ids);
    expect(result.team.rosterPeople).toBe(6);
});
test("rejects wrong original team scope, incomplete selection, invalid populations, and fake complete costs", async () => {
    const good = peopleComparisonFixture(query, ids);
    expect(validPeopleComparison(good, query, ids)).toBe(true);
    for (const modify of [
        (data: typeof good) => { data.meta.scope.userIds = ids; },
        (data: typeof good) => { data.meta.scope.boardKeys = []; },
        (data: typeof good) => { data.people.pop(); },
        (data: typeof good) => { data.people[1].userId = ids[0]; },
        (data: typeof good) => { data.team.rosterPeople = 1; },
        (data: typeof good) => { data.team.perActivePersonBookedCny.denominator = 6; },
        (data: typeof good) => { data.team.metrics.generationBookedCny.state = "partial"; data.team.metrics.generationBookedCny.missingCount = 1; },
    ]) { const altered = structuredClone(good); modify(altered); expect(validPeopleComparison(altered, query, ids)).toBe(false); }
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ code: 0, data: good }); }) as typeof fetch;
    await expect(getPeopleTeamComparison(query, [ids[0], "10000000-0000-4000-8000-000000000099"])).rejects.toMatchObject({ code: "INVALID_COMPARISON" });
    expect(calls).toBe(0);
});
test("cleared dashboard dimensions use the same absent-filter wire meaning as existing GET reads", async () => {
    const cleared: UsageV2Query = { ...query, userIds: [], boardKeys: [], modelConfigIds: [], departmentIds: [], operationTypes: [], search: "" };
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, options) => { sent = JSON.parse(String(options?.body)).filters; return Response.json({ code: 0, data: peopleComparisonFixture(cleared, ids) }); }) as typeof fetch;
    await getPeopleTeamComparison(cleared, ids);
    expect(sent).toEqual({ from: query.from, to: query.to, compare: "none", departmentBasis: "current" });
});
test("typed failures do not retry or expose raw errors, and cancellation suppresses a late reply", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ code: "USAGE_COMPARISON_OUT_OF_SCOPE", msg: "PRIVATE_DATABASE_ERROR" }, { status: 409 }); }) as typeof fetch;
    await expect(getPeopleTeamComparison(query, ids)).rejects.toMatchObject({ code: "USAGE_COMPARISON_OUT_OF_SCOPE" });
    expect(calls).toBe(1);
    const abort = new AbortController();
    globalThis.fetch = (async () => { abort.abort(); return Response.json({ code: 0, data: peopleComparisonFixture(query, ids) }); }) as typeof fetch;
    await expect(getPeopleTeamComparison(query, ids, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
});
test("visible comparison and export contain the exact team, persons, coverage, populations and snapshot", () => {
    const data = peopleComparisonFixture(query, ids, ["=公式防护", "员工乙"]);
    Object.assign(data, { prompt: "PRIVATE_PROMPT", imageUrl: "https://private.invalid" });
    const output = peopleComparisonExport(data);
    expect(output.rows).toHaveLength(35);
    expect(output.rows.filter(row => row.对象 === "团队合并基线")).toHaveLength(11);
    expect(output.rows.find(row => row.指标 === "按范围名册人均记账金额")).toMatchObject({ 精确金额: "10.500000", 分母: 6 });
    expect(output.notes.find(row => row.项目 === "原共享筛选")?.说明).toBe(JSON.stringify(data.meta.scope));
    expect(JSON.stringify(output)).toContain("混合刷新时点");
    expect(JSON.stringify(output)).not.toContain("PRIVATE_PROMPT");
    expect(JSON.stringify(output)).not.toContain("private.invalid");
    const html = renderToStaticMarkup(<App><PeopleComparison data={data} onProfile={() => {}} /></App>);
    expect(html).toContain("原范围团队合并基线（非个人均值）");
    expect(html).toContain("导出人员团队对照 Excel");
    expect(html).toContain("10.500000");
});
