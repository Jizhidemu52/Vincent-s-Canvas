import { afterEach, expect, test } from "bun:test";
import {
    generateUsageV2Report,
    usageV2ReportAnonymousScope,
    usageV2ReportComparisonScope,
    type UsageV2ReportRequest,
} from "../src/services/api/usage-analytics-v2";
import { reportFixture } from "./usage-report-fixture";
import { departmentId, modelId, personId } from "./usage-v2-browser/fixture";
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});
const input: UsageV2ReportRequest = {
    page: "overview",
    period: "selected",
    filters: {
        from: "2026-09-30T16:00:00.000Z",
        to: "2026-10-07T16:00:00.000Z",
        compare: "previous_period",
        departmentBasis: "at_event",
        userIds: [personId],
        departmentIds: [departmentId],
        modelConfigIds: [modelId],
        boardKeys: ["canvas"],
        operationTypes: ["image_generation"],
        search: "private search",
    },
};

test("anonymous comparison scope preserves the real Beijing leap-day fallback without identities", () => {
    const scope = usageV2ReportAnonymousScope({
        ...input.filters,
        from: "2024-02-28T00:00:00+08:00",
        to: "2024-02-29T00:00:00+08:00",
        timezone: "Asia/Shanghai",
        compare: "previous_year",
        departmentBasis: "at_event",
    });
    expect(usageV2ReportComparisonScope(scope)).toMatchObject({
        from: "2023-02-27T16:00:00.000Z",
        to: "2023-02-28T16:00:00.000Z",
        compare: "none",
    });
    expect(JSON.stringify(scope)).not.toContain(personId);
    expect(JSON.stringify(scope)).not.toContain("private search");
    expect(usageV2ReportComparisonScope({ ...scope, compare: "none" })).toBeNull();
});

test("free report sends only exact normalized filters and validates all six synthetic adapter results", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
        expect(init).toMatchObject({ method: "POST", credentials: "include", cache: "no-store" });
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return Response.json({ code: 0, data: reportFixture(body) });
    }) as typeof fetch;
    for (const page of ["overview", "people", "boards", "models", "quality", "flows"] as const) {
        const result = await generateUsageV2Report({
            ...input,
            page,
            filters: {
                ...input.filters,
                userIds: [personId, personId],
                search: " private search ",
                page: 3,
                metrics: { privateValue: 999 },
            } as any,
        });
        expect(result.page).toBe(page);
        expect(result.content).not.toContain("private search");
        expect(result.content).not.toContain(personId);
        expect(calls.at(-1)).toEqual({ url: "/api/admin/usage/report-v2", body: { ...input, page } });
    }
});

test("free report refuses mismatched inner/outer scope, comparison, filters and partial content", async () => {
    const good = reportFixture(input);
    for (const mutate of [
        (value: any) => {
            const decoded = JSON.parse(value.content);
            decoded.scope.from = "2020-01-01T00:00:00.000Z";
            value.content = JSON.stringify(decoded);
            value.estimatedCharacters = value.content.length;
        },
        (value: any) => {
            value.scope.filters.selectedPeopleCount = 99;
        },
        (value: any) => {
            value.comparisonScope = null;
        },
        (value: any) => {
            value.content = JSON.stringify({ schemaVersion: 2, page: input.page, period: input.period });
            value.estimatedCharacters = value.content.length;
        },
        (value: any) => {
            value.content = "{";
            value.estimatedCharacters = 1;
        },
    ]) {
        const value = structuredClone(good);
        mutate(value);
        globalThis.fetch = (async () => Response.json({ code: 0, data: value })) as typeof fetch;
        await expect(generateUsageV2Report(input)).rejects.toMatchObject({ code: "INVALID_REPORT_RESPONSE" });
    }
});

test("invalid calendar templates do not send; server errors are bounded and never automatically retried", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        return Response.json({ code: "USAGE_ROLLUP_REFRESH_REQUIRED", msg: "PRIVATE_SECRET" }, { status: 409 });
    }) as typeof fetch;
    await expect(generateUsageV2Report({ ...input, period: "week" })).rejects.toMatchObject({
        code: "USAGE_REPORT_PERIOD_MISMATCH",
    });
    expect(calls).toBe(0);
    await expect(generateUsageV2Report(input)).rejects.toMatchObject({
        code: "USAGE_ROLLUP_REFRESH_REQUIRED",
        status: 409,
    });
    expect(calls).toBe(1);
    globalThis.fetch = (async () => {
        calls++;
        return Response.json({ code: "OTHER", msg: "PRIVATE_SECRET" }, { status: 503 });
    }) as typeof fetch;
    await expect(generateUsageV2Report(input)).rejects.toThrow("使用分析暂不可用");
    expect(calls).toBe(2);
});
