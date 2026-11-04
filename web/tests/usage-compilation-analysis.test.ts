import { afterEach, expect, test } from "bun:test";
import { getUsageCompilationAnalysis } from "../src/services/api/usage-compilation-analysis";
import { compilationDepartment, compilationFixture, compilationPerson, compilationScope, emptyCompilationSummary } from "./usage-compilation-analysis-fixture";
import type { UsageV2Scope } from "../../shared/usage-analytics-v2";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const respond = (data: unknown) => { globalThis.fetch = (async () => Response.json({ code: 0, data })) as typeof fetch; };

test("explicit compilation reads retain supported shared filters and preserve three groups, currencies, status and missing values", async () => {
    const scope: UsageV2Scope = { ...compilationScope, departmentIds: [compilationDepartment], userIds: [compilationPerson], search: "甲" };
    const input = structuredClone(scope), fixture = compilationFixture(scope), calls: string[] = [];
    globalThis.fetch = (async (path, options) => {
        calls.push(String(path));
        expect(options?.credentials).toBe("include"); expect(options?.cache).toBe("no-store"); expect(options?.redirect).toBe("error");
        expect(options?.body).toBeUndefined(); expect(options?.method ?? "GET").toBe("GET");
        return Response.json({ code: 0, data: fixture });
    }) as typeof fetch;
    const result = await getUsageCompilationAnalysis(scope);
    expect(scope).toEqual(input);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!, "http://local.invalid");
    expect(url.pathname).toBe("/api/admin/usage/compilations");
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: scope.from, to: scope.to, compare: "previous_period", departmentBasis: "current", departmentIds: compilationDepartment, userIds: compilationPerson, search: "甲" });
    expect(result.current.all).toMatchObject({ requests: 9, linkedRequests: 5, unlinkedRequests: 4, sourceCalls: 5, cacheHits: 4, adminTests: { yes: 2, no: 4, unknown: 3 }, statuses: { failed: 1, uncertain: 3 }, cacheSourceOutsideScope: 2, cacheSourceMissing: 1 });
    expect(result.current.linked.outputTokens.value).toBe(0);
    expect(result.current.unlinked.inputTokens.value).toBeNull();
    expect(result.current.unlinked.latency.meanMs).toBeNull();
    expect(result.current.all.costs).toEqual(fixture.current.all.costs);
    expect(result.comparison?.all.costs[0]?.estimatedAmount).toBe("0.010000");
});

test("unsupported shared dimensions are rejected without any request or mutation", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("must not request"); }) as typeof fetch;
    for (const change of [
        { departmentBasis: "at_event" as const, departmentIds: [compilationDepartment] },
        { boardKeys: ["image"] }, { modelConfigIds: [compilationPerson] }, { operationTypes: ["image_generation"] },
    ]) {
        const scope = { ...compilationScope, ...change }, before = structuredClone(scope);
        await expect(getUsageCompilationAnalysis(scope)).rejects.toThrow("不支持");
        expect(scope).toEqual(before);
    }
    expect(calls).toBe(0);
});

test("wrong periods, employee scopes, incomplete metrics and raw private extra fields are never returned", async () => {
    const mutations: Array<(data: any) => void> = [
        value => { value.meta.scope.userIds = [compilationPerson]; },
        value => { value.meta.scope.from = "2026-10-02T16:00:00.000Z"; },
        value => { value.meta.comparisonScope.to = value.meta.scope.to; },
        value => { value.comparison = null; },
        value => { value.current.from = value.current.to; },
        value => { value.current.all.prompt = "PRIVATE_PROMPT"; },
        value => { value.meta.rules = "PRIVATE_RULES"; },
        value => { value.current.all.costs[0].rawError = "PRIVATE_PROVIDER_ERROR"; },
        value => { value.current.all.people = [{ name: "PRIVATE_EMPLOYEE" }]; },
        value => { delete value.current.all.adminTests.unknown; },
        value => { delete value.current.all.statuses.uncertain; },
        value => { value.current.all.sourceCalls += 1; },
        value => { value.current.all.inputTokens.value = null; },
        value => { value.current.all.inputTokens.state = "available"; },
        value => { value.current.all.costs[0].actualAmount = null; },
        value => { value.current.all.costs[0].estimatedAmount = "0.12"; },
        value => { value.comparison.all.completeTokenCalls = 0; value.comparison.unlinked.completeTokenCalls = 0; },
        value => { value.current.all.costs[2].actualAmount = "0.000000"; },
        value => { value.current.all.costs.push({ ...value.current.all.costs[0] }); },
        value => { value.current.all.latency.meanMs = -1; },
    ];
    for (const mutate of mutations) {
        const data = compilationFixture(); mutate(data); respond(data);
        await expect(getUsageCompilationAnalysis(compilationScope)).rejects.toThrow("响应");
    }
});

test("empty periods keep unavailable null values and no comparison stays absent", async () => {
    const scope = { ...compilationScope, compare: "none" as const }, data = compilationFixture(scope);
    data.current = { from: scope.from, to: scope.to, all: emptyCompilationSummary(), linked: emptyCompilationSummary(), unlinked: emptyCompilationSummary() };
    respond(data);
    const value = await getUsageCompilationAnalysis(scope);
    expect(value.current.all.requests).toBe(0);
    expect(value.current.all.inputTokens).toEqual({ value: null, state: "unavailable", availableCount: 0, missingCount: 0 });
    expect(value.current.all.costs).toEqual([]);
    expect(value.comparison).toBeNull();
});

test("previous-year leap-day comparison is checked independently of response metadata", async () => {
    const scope: UsageV2Scope = { ...compilationScope, from: "2024-02-27T16:00:00.000Z", to: "2024-02-28T16:00:00.000Z", compare: "previous_year" };
    const data = compilationFixture(scope);
    data.meta.comparisonScope = { ...scope, compare: "none", from: "2023-02-27T16:00:00.000Z", to: "2023-02-28T16:00:00.000Z" };
    data.comparison!.from = data.meta.comparisonScope.from; data.comparison!.to = data.meta.comparisonScope.to;
    respond(data);
    expect((await getUsageCompilationAnalysis(scope)).comparison?.to).toBe("2023-02-28T16:00:00.000Z");
    data.meta.comparisonScope.to = "2023-02-27T16:00:00.000Z";
    data.comparison!.to = data.meta.comparisonScope.to;
    respond(data);
    await expect(getUsageCompilationAnalysis(scope)).rejects.toThrow("响应");
});

test("aborted and failed reads never retry or expose arbitrary response details", async () => {
    let calls = 0;
    const controller = new AbortController();
    globalThis.fetch = (async (_path, options) => {
        calls++; expect(options?.signal).toBe(controller.signal); controller.abort();
        return Response.json({ code: 0, data: compilationFixture() });
    }) as typeof fetch;
    await expect(getUsageCompilationAnalysis(compilationScope, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    for (const status of [400, 401, 403, 404, 422, 503]) {
        globalThis.fetch = (async () => { calls++; return new Response("PRIVATE_PROVIDER_ERROR", { status }); }) as typeof fetch;
        const before = calls;
        try { await getUsageCompilationAnalysis(compilationScope); throw new Error("expected rejection"); }
        catch (error) { expect(String(error)).not.toContain("PRIVATE_PROVIDER_ERROR"); expect(error).toMatchObject({ status }); }
        expect(calls).toBe(before + 1);
    }
});
