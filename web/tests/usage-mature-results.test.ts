import { afterEach, expect, test } from "bun:test";
import { getUsageMatureResults } from "../src/services/api/usage-mature-results";
import {
    emptyMatureSummary,
    matureDepartment,
    matureFixture,
    matureModel,
    maturePerson,
    matureScope,
} from "./usage-mature-results-fixture";
import type { UsageV2Scope } from "../../shared/usage-analytics-v2";

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});
const respond = (data: unknown) => {
    globalThis.fetch = (async () => Response.json({ code: 0, data })) as typeof fetch;
};

test("explicit mature reads preserve every shared filter and return observed rates, exact costs and overlapping evidence", async () => {
    const scope: UsageV2Scope = {
        ...matureScope,
        departmentIds: [matureDepartment],
        userIds: [maturePerson],
        boardKeys: ["image", "canvas-image"],
        modelConfigIds: [matureModel],
        operationTypes: ["image_generation", "inpaint"],
        search: "甲",
    };
    const before = structuredClone(scope),
        calls: string[] = [];
    globalThis.fetch = (async (path, options) => {
        calls.push(String(path));
        expect(options?.credentials).toBe("include");
        expect(options?.cache).toBe("no-store");
        expect(options?.redirect).toBe("error");
        expect(options?.method ?? "GET").toBe("GET");
        expect(options?.body).toBeUndefined();
        const data = matureFixture(scope);
        data.meta.scope.boardKeys?.reverse();
        return Response.json({ code: 0, data });
    }) as typeof fetch;
    const result = await getUsageMatureResults(scope);
    expect(scope).toEqual(before);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!, "http://local.invalid");
    expect(url.pathname).toBe("/api/admin/usage/mature-results");
    expect(Object.fromEntries(url.searchParams)).toEqual({
        from: scope.from,
        to: scope.to,
        compare: "previous_period",
        departmentBasis: "at_event",
        departmentIds: matureDepartment,
        userIds: maturePerson,
        boardKeys: "image,canvas-image",
        modelConfigIds: matureModel,
        operationTypes: "image_generation,inpaint",
        search: "甲",
    });
    expect(result.current.cohort).toEqual({
        successfulImageTasks: 10,
        matureTasks: 7,
        immatureTasks: 1,
        missingCompletedAtTasks: 1,
        invalidTimelineTasks: 1,
    });
    expect(result.current.all.useRate).toEqual({ value: 0.4, state: "partial" });
    expect(result.current.all.cost.perRecordedUsedResult).toBe("0.750000");
    expect(result.current.all).toMatchObject({
        clientReportedUsedResults: 2,
        serverConfirmedUsedResults: 3,
        usedResults: 4,
    });
    expect(result.comparison?.all.useRate).toEqual({ value: 0, state: "available" });
    expect(result.comparison?.all.cost).toMatchObject({ bookedAmount: "0.000000", perRecordedUsedResult: null });
});

test("invalid requests fail without sending or silently dropping any selected scope", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        throw new Error("must not request");
    }) as typeof fetch;
    for (const change of [
        { from: matureScope.to },
        { timezone: "UTC" },
        { userIds: ["bad-id"] },
        { boardKeys: ["image,image"] },
        { operationTypes: ["inpaint", "inpaint"] },
        { search: "x".repeat(101) },
        { to: "2028-10-01T16:00:00Z" },
        { privateScope: "PRIVATE" },
    ]) {
        await expect(getUsageMatureResults({ ...matureScope, ...change } as UsageV2Scope)).rejects.toThrow("筛选");
    }
    expect(calls).toBe(0);
});

test("mismatched scopes, raw extras, false completeness and inconsistent cohort/rate/money totals are rejected", async () => {
    const mutations: Array<(data: any) => void> = [
        (value) => {
            value.meta.scope.userIds = [maturePerson];
        },
        (value) => {
            value.meta.scope.departmentBasis = "current";
        },
        (value) => {
            value.meta.comparisonScope.to = value.meta.scope.to;
        },
        (value) => {
            value.current.from = value.current.to;
        },
        (value) => {
            value.comparison = null;
        },
        (value) => {
            value.meta.observationHours = 24;
        },
        (value) => {
            value.meta.metricVersion = "different";
        },
        (value) => {
            value.meta.dataMode = "persisted_daily_facts";
        },
        (value) => {
            value.current.all.prompt = "PRIVATE_PROMPT";
        },
        (value) => {
            value.current.all.cost.rawAmount = "PRIVATE_VALUE";
        },
        (value) => {
            value.current.all.useRate.url = "PRIVATE_URL";
        },
        (value) => {
            value.current.cohort.people = ["PRIVATE_NAME"];
        },
        (value) => {
            value.current.optimizationGroups[0].metadata = {};
        },
        (value) => {
            value.meta.notes = ["x".repeat(2001)];
        },
        (value) => {
            value.current.cohort.matureTasks++;
        },
        (value) => {
            value.current.all.unknownBindingResults++;
        },
        (value) => {
            value.current.all.generatedResults = 100001;
        },
        (value) => {
            value.current.all.useRate.value = 0.6;
        },
        (value) => {
            value.current.all.useRate.state = "available";
        },
        (value) => {
            value.current.all.adoptionRate.value = null;
        },
        (value) => {
            value.current.all.cost.bookedAmount = "3.000002";
        },
        (value) => {
            value.current.all.cost.bookedAmount = "3";
        },
        (value) => {
            value.current.all.cost.perRecordedUsedResult = "0.750001";
        },
        (value) => {
            value.current.all.cost.perUsedState = "available";
        },
        (value) => {
            value.current.all.cost.missingSettlementTasks = 0;
        },
        (value) => {
            value.current.all.reversedWindowEvents = 9;
        },
        (value) => {
            value.current.all.clientReportedUsedResults = 5;
        },
        (value) => {
            value.current.all.formallyAdoptedResults = 5;
        },
        (value) => {
            value.current.optimizationGroups[0].summary.formallyAdoptedResults = 3;
            value.current.optimizationGroups[0].summary.adoptionRate.value = 0.75;
            value.current.all.formallyAdoptedResults = 4;
            value.current.all.adoptionRate.value = 0.4;
        },
        (value) => {
            value.current.optimizationGroups[0].key = "no_explicit_marker";
        },
        (value) => {
            value.current.optimizationGroups[0].summary = structuredClone(value.current.all);
        },
        (value) => {
            delete value.current.all.beforeCompletionEvents;
        },
    ];
    for (const mutate of mutations) {
        const data = matureFixture();
        mutate(data);
        respond(data);
        await expect(getUsageMatureResults(matureScope)).rejects.toThrow("响应");
    }
});

test("empty and wholly unbound outputs remain unavailable while explicit zero and missing settlement are distinct", async () => {
    const scope = { ...matureScope, compare: "none" as const },
        data = matureFixture(scope);
    const empty = emptyMatureSummary();
    data.current = {
        from: scope.from,
        to: scope.to,
        cohort: {
            successfulImageTasks: 1,
            matureTasks: 1,
            immatureTasks: 0,
            missingCompletedAtTasks: 0,
            invalidTimelineTasks: 0,
        },
        all: {
            ...empty,
            tasks: 1,
            outputKnownTasks: 1,
            generatedResults: 1,
            unknownBindingResults: 1,
            cost: { ...empty.cost, missingSettlementTasks: 1 },
        },
        optimizationGroups: [],
    };
    data.current.optimizationGroups = [
        { key: "explicit_link", summary: emptyMatureSummary() },
        { key: "no_explicit_marker", summary: structuredClone(data.current.all) },
    ];
    respond(data);
    const value = await getUsageMatureResults(scope);
    expect(value.current.all.useRate).toEqual({ value: null, state: "unavailable" });
    expect(value.current.all.cost.bookedAmount).toBeNull();
    expect(value.comparison).toBeNull();
    data.current.all.useRate = { value: 0, state: "available" };
    respond(data);
    await expect(getUsageMatureResults(scope)).rejects.toThrow("响应");
    const blank = matureFixture(scope);
    blank.current = {
        from: scope.from,
        to: scope.to,
        cohort: {
            successfulImageTasks: 0,
            matureTasks: 0,
            immatureTasks: 0,
            missingCompletedAtTasks: 0,
            invalidTimelineTasks: 0,
        },
        all: emptyMatureSummary(),
        optimizationGroups: [
            { key: "explicit_link", summary: emptyMatureSummary() },
            { key: "no_explicit_marker", summary: emptyMatureSummary() },
        ],
    };
    respond(blank);
    expect((await getUsageMatureResults(scope)).current.all.cost.perRecordedUsedResult).toBeNull();
});

test("previous-year leap-day comparison keeps the true requested period instead of accepting returned dates blindly", async () => {
    const scope: UsageV2Scope = {
        ...matureScope,
        from: "2024-02-27T16:00:00.000Z",
        to: "2024-02-28T16:00:00.000Z",
        compare: "previous_year",
    };
    const data = matureFixture(scope);
    data.meta.comparisonScope = {
        ...scope,
        compare: "none",
        from: "2023-02-27T16:00:00.000Z",
        to: "2023-02-28T16:00:00.000Z",
    };
    data.comparison!.from = data.meta.comparisonScope.from;
    data.comparison!.to = data.meta.comparisonScope.to;
    respond(data);
    expect((await getUsageMatureResults(scope)).comparison?.to).toBe("2023-02-28T16:00:00.000Z");
    data.meta.comparisonScope.to = "2023-02-27T16:00:00.000Z";
    data.comparison!.to = data.meta.comparisonScope.to;
    respond(data);
    await expect(getUsageMatureResults(scope)).rejects.toThrow("响应");
});

test("a valid 366-day request accepts its exact 367-day previous-year window without widening the input limit", async () => {
    const scope: UsageV2Scope = {
        ...matureScope,
        from: "2024-12-31T16:00:00.000Z",
        to: "2026-01-01T16:00:00.000Z",
        compare: "previous_year",
    };
    const data = matureFixture(scope);
    data.meta.comparisonScope = {
        ...scope,
        compare: "none",
        from: "2023-12-31T16:00:00.000Z",
        to: "2025-01-01T16:00:00.000Z",
    };
    data.comparison!.from = data.meta.comparisonScope.from;
    data.comparison!.to = data.meta.comparisonScope.to;
    respond(data);
    expect((await getUsageMatureResults(scope)).comparison?.to).toBe("2025-01-01T16:00:00.000Z");
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        return Response.json({ code: 0, data });
    }) as typeof fetch;
    await expect(getUsageMatureResults({ ...scope, to: "2026-01-02T16:00:00.000Z" })).rejects.toThrow("筛选");
    expect(calls).toBe(0);
});

test("cancelled, malformed and failed mature reads do not retry or reveal server/private errors", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async () => {
        calls++;
        return Response.json({ code: 0, data: matureFixture() });
    }) as typeof fetch;
    await expect(getUsageMatureResults(matureScope, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
    const late = new AbortController();
    globalThis.fetch = (async (_path, options) => {
        calls++;
        expect(options?.signal).toBe(late.signal);
        late.abort();
        return Response.json({ code: 0, data: matureFixture() });
    }) as typeof fetch;
    await expect(getUsageMatureResults(matureScope, late.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    for (const status of [400, 401, 403, 404, 422, 503]) {
        globalThis.fetch = (async () => {
            calls++;
            return new Response("PRIVATE_PROVIDER_ERROR", { status });
        }) as typeof fetch;
        const before = calls;
        try {
            await getUsageMatureResults(matureScope);
            throw new Error("expected rejection");
        } catch (error) {
            expect(String(error)).not.toContain("PRIVATE_");
            expect(error).toMatchObject({ status });
        }
        expect(calls).toBe(before + 1);
    }
    globalThis.fetch = (async () => {
        calls++;
        return new Response("PRIVATE_INVALID_JSON", { status: 200 });
    }) as typeof fetch;
    await expect(getUsageMatureResults(matureScope)).rejects.toThrow("响应");
});
