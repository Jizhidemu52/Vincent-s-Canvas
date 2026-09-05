import { expect, test } from "bun:test";

import { createCanvasPerformanceTracker } from "@/lib/canvas/canvas-performance-metrics";

test("reports frame timing statistics without storing canvas content", () => {
    const tracker = createCanvasPerformanceTracker();
    tracker.start("pan", 0);
    tracker.frame(16);
    tracker.frame(70);

    const metrics = tracker.finish(90, { totalNodes: 500, visibleNodes: 42, totalConnections: 1000, visibleConnections: 85 });

    expect(metrics.p95FrameMs).toBe(70);
    expect(metrics.longFrameCount).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain("prompt");
});

test("keeps browser throttling gaps separate from actual long frames", () => {
    const tracker = createCanvasPerformanceTracker();
    tracker.start("pan", 0);
    tracker.frame(18);
    tracker.frame(1001);
    tracker.frame(120);

    const metrics = tracker.finish(1200, { totalNodes: 5000, visibleNodes: 30, totalConnections: 10000, visibleConnections: 56 });

    expect(metrics.p95FrameMs).toBe(120);
    expect(metrics.longFrameCount).toBe(1);
    expect(metrics.stalledFrameGapCount).toBe(1);
    expect(metrics.averageFps).toBeGreaterThan(0);
});
