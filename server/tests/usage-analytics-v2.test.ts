import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db";
import { classifyUsageFailure } from "../src/usage-failure-reasons";
import {
  compareUsageV2Metrics,
  resolveUsageV2Scope,
  usageComparisonScope,
  usageMoneyMicros,
  usageOptimizationMoneyMicros,
  usagePercentile,
  usageV2Overview,
  usageV2Metrics,
  usageV2QuerySchema,
  usageV2SqlFilter,
} from "../src/usage-analytics-v2";

describe("v2 analytics pure contracts", () => {
  test("as-of cohort outcome comparisons do not invent equal observation windows", () => {
    const current = usageV2Metrics([]), previous = usageV2Metrics([]);
    for (const key of ["resultUseRate", "formalAdoptionRate", "costPerUsedImage"] as const) {
      current[key] = { ...current[key], value: .5, state: "available" };
      previous[key] = { ...previous[key], value: 0, state: "available" };
    }
    const compared = compareUsageV2Metrics(current, previous);
    expect(compared.formalAdoptionRate.comparison).toMatchObject({ value: 0, absoluteDelta: null, relativeDelta: null, reason: "insufficient_data" });
  });
  test("strict compound filters, zero-length ranges and unsupported dimensions fail closed", () => {
    const user = "11111111-1111-4111-8111-111111111111";
    const query = usageV2QuerySchema.parse({
      userIds: `${user},${user}`,
      boardKeys: "image,canvas",
      compare: "previous_year",
      departmentBasis: "current",
    });
    expect(query.userIds).toEqual([user]);
    for (const input of [
      { userIds: "" },
      { boardKeys: "not-a-board" },
      { modelConfigIds: "SECRET" },
      { asOf: "yesterday" },
      { from: "2026-10-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    ])
      expect(usageV2QuerySchema.safeParse(input).success).toBe(false);
    expect(() =>
      resolveUsageV2Scope(
        { from: "2025-01-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
        new Date("2026-11-04"),
      ),
    ).toThrow("366");
    const scope = resolveUsageV2Scope(
      {
        ...query,
        from: "2026-10-01T00:00:00+08:00",
        to: "2026-10-03T00:00:00+08:00",
        departmentIds: [user],
        modelConfigIds: [user],
        operationTypes: ["image_generation"],
        search: "%_",
      },
      new Date("2026-11-04"),
    );
    const filter = usageV2SqlFilter(scope);
    expect(filter.where).toContain("current_department_id=ANY");
    expect(filter.values).toContain("%\\%\\_%");
    expect(filter.where).not.toContain("?");
    expect(filter.where).toContain("f.operation_type=ANY");
  });
  test("comparison boundaries are exact previous periods and leap-safe Beijing prior years", () => {
    const base = resolveUsageV2Scope(
      { from: "2026-10-02T00:00:00+08:00", to: "2026-10-04T00:00:00+08:00" },
      new Date("2026-11-04"),
    );
    expect(usageComparisonScope(base)).toMatchObject({
      from: "2026-09-29T16:00:00.000Z",
      to: base.from,
    });
    const leap = {
      ...base,
      from: "2024-02-29T00:00:00+08:00",
      to: "2024-03-01T00:00:00+08:00",
      compare: "previous_year" as const,
    };
    expect(usageComparisonScope(leap)).toMatchObject({
      from: "2023-02-27T16:00:00.000Z",
      to: "2023-02-28T16:00:00.000Z",
    });
    expect(usageComparisonScope({ ...base, compare: "none" })).toBeNull();
  });
  test("percentiles use the full valid sample and money uses exact six-place integer sums", () => {
    expect(usagePercentile([10, 20, 30, 1000], 0.5)).toBe(25);
    expect(usagePercentile([10, 20, 30, 1000], 0.9)).toBeCloseTo(709, 8);
    expect(usagePercentile([NaN, -1, Infinity], 0.5)).toBeNull();
    expect(
      usageMoneyMicros("0.161040") +
        usageMoneyMicros("0.2") +
        usageMoneyMicros("0.3"),
    ).toBe(661040n);
    expect(() => usageMoneyMicros("NaN")).toThrow();
    expect(usageOptimizationMoneyMicros("0.1234565")).toBe(123457n);
    expect(usageOptimizationMoneyMicros("9999999999999999.9999999")).toBe(
      10000000000000000000000n,
    );
    for (const invalid of [
      "Infinity",
      "-1",
      "1e100",
      "0." + "9".repeat(10000),
      "9".repeat(10000),
      null,
    ])
      expect(usageOptimizationMoneyMicros(invalid)).toBeNull();
  });
  test("status semantics take precedence and provider error text never becomes a category", () => {
    expect(classifyUsageFailure("cancelled", "timeout SECRET")).toBe(
      "user_cancelled",
    );
    expect(classifyUsageFailure("paused", "timeout")).toBe("paused");
    expect(classifyUsageFailure("paused", "result uncertain")).toBe(
      "uncertain",
    );
    expect(classifyUsageFailure("failed", "upstream result uncertain")).toBe(
      "uncertain",
    );
    expect(
      classifyUsageFailure("failed", "failed to save result after timeout"),
    ).toBe("result_storage");
    expect(
      classifyUsageFailure(
        "failed",
        "Authorization Bearer SECRET https://private.invalid",
      ),
    ).toBe("unknown");
  });
  test("scope fact budgets abort before reading rows, roll back, and never return a truncated report", async () => {
    for (const budget of [
      { count: 50001, bytes: "1" },
      { count: 1, bytes: String(32 * 1024 * 1024 + 1) },
    ]) {
      const statements: string[] = [];
      let released = false;
      const db = {
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql);
            return {
                rows: sql.includes("AS bytes FROM facts") ? [budget] : sql.includes("transaction_timestamp") ? [{ snapshot_at: "2026-11-04T00:00:00Z" }] : [],
            };
          },
          release: () => {
            released = true;
          },
        }),
      } as unknown as Database;
      const scope = resolveUsageV2Scope(
        { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" },
        new Date("2026-11-04"),
      );
      await expect(usageV2Overview(db, scope)).rejects.toMatchObject({
        code: "USAGE_SCOPE_TOO_LARGE",
        status: 422,
      });
      expect(statements.some((sql) => sql.includes("SELECT f.*"))).toBe(false);
      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(released).toBe(true);
    }
  });
});
