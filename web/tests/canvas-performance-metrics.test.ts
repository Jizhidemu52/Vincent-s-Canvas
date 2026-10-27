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

test("long drags keep a bounded frame window without losing total long-frame counts", () => {
    const tracker = createCanvasPerformanceTracker();
    tracker.start("drag", 0);
    for (let index = 0; index < 4000; index++) tracker.frame(70);
    for (let index = 0; index < 3600; index++) tracker.frame(16);
    const metrics = tracker.finish(337600, { totalNodes: 5000, visibleNodes: 50, totalConnections: 0, visibleConnections: 0 });
    expect(metrics.sampledFrameCount).toBe(3600);
    expect(metrics.longFrameCount).toBe(4000);
    expect(metrics.p95FrameMs).toBe(16);
    expect(metrics.maxFrameMs).toBe(70);
    expect(metrics.averageFps).toBe(22.5);
});
