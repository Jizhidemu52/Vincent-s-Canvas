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
