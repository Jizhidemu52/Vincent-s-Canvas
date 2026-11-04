import { expect, test } from "bun:test";
import { usageLatencyDistribution, type Fact } from "../src/usage-analytics-v2";
const fact = (total_ms: number | null, status = "success", kind: Fact["kind"] = "task") => ({ total_ms, status, kind }) as Fact;
test("latency five-number summary uses full valid successes, not P90 as max or daily medians", () => {
  const result = usageLatencyDistribution([fact(10), fact(20), fact(30), fact(1000), fact(null), fact(-2), fact(Infinity), fact(9999, "failed"), fact(1, "success", "chat")]);
  expect(result).toMatchObject({ eligible: 7, available: 4, missing: 3, min: 10, q1: 17.5, median: 25, q3: 272.5, max: 1000, method: "full_sample_linear_interpolation" });
  expect(result.notes.join(" ")).toContain("不是 Tukey");
  expect(result.notes.join(" ")).toContain("不平均每日分位数");
});
test("empty and singleton timing sets keep absence and observed zero distinct", () => {
  expect(usageLatencyDistribution([fact(null)])).toMatchObject({ eligible: 1, available: 0, missing: 1, min: null, q1: null, median: null, q3: null, max: null });
  expect(usageLatencyDistribution([fact(0)])).toMatchObject({ eligible: 1, available: 1, missing: 0, min: 0, q1: 0, median: 0, q3: 0, max: 0 });
  expect(usageLatencyDistribution([])).toMatchObject({ eligible: 0, available: 0, missing: 0, median: null });
});
