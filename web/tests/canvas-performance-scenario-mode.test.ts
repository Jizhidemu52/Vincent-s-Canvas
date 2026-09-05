import { expect, test } from "bun:test";

import { canvasPerformanceFixtureSize, isCanvasPerformanceModeEnabled, shouldUseCanvasPerformanceScenario } from "@/lib/canvas/canvas-performance-scenario-mode";

test("allows production performance sampling only when a build explicitly enables it", () => {
    expect(isCanvasPerformanceModeEnabled(true, false, "1")).toBe(true);
    expect(isCanvasPerformanceModeEnabled(false, false, "1")).toBe(false);
    expect(isCanvasPerformanceModeEnabled(false, true, "1")).toBe(true);
    expect(isCanvasPerformanceModeEnabled(false, true, null)).toBe(false);
});

test("enables the transient scenario only from an enabled performance route", () => {
    expect(shouldUseCanvasPerformanceScenario(true, "1")).toBe(true);
    expect(shouldUseCanvasPerformanceScenario(false, "1")).toBe(false);
    expect(shouldUseCanvasPerformanceScenario(true, null)).toBe(false);
    expect(shouldUseCanvasPerformanceScenario(true, "true")).toBe(false);
});

test("accepts only explicit bounded workload sizes", () => {
    expect(canvasPerformanceFixtureSize(true, "1")).toBe(500);
    expect(canvasPerformanceFixtureSize(true, "2000")).toBe(2000);
    expect(canvasPerformanceFixtureSize(true, "5000")).toBe(5000);
    expect(canvasPerformanceFixtureSize(false, "5000")).toBe(null);
    expect(canvasPerformanceFixtureSize(true, "5001")).toBe(null);
});
