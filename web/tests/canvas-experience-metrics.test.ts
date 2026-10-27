import { expect, test } from "bun:test";
import { createCanvasExperienceMetrics } from "@/lib/canvas/canvas-experience-metrics";

test("keeps bounded local aggregates of open, interaction and result timings without content", () => {
    const metrics = createCanvasExperienceMetrics();
    metrics.recordOpen(120, 500);
    metrics.recordOpen(280, 2000);
    metrics.recordTask(1000);
    metrics.recordTask(3000);
    metrics.recordInteraction({ interaction: "drag", averageFps: 41, p95FrameMs: 70, maxFrameMs: 100, longFrameCount: 3, stalledFrameGapCount: 2, totalNodes: 500, visibleNodes: 40, totalConnections: 200, visibleConnections: 30 });
    const snapshot = metrics.getSnapshot();
    expect(snapshot.open.meanMs).toBe(200);
    expect(snapshot.open.lastNodeCount).toBe(2000);
    expect(snapshot.task.meanMs).toBe(2000);
    expect(snapshot.interaction.longFrameCount).toBe(3);
    expect(snapshot.interaction.stalledFrameGapCount).toBe(2);
    expect(snapshot.interaction.lastFps).toBe(41);
    const beforeSize = JSON.stringify(snapshot).length;
    for (let index = 0; index < 10000; index++) metrics.recordTask(2000);
    expect(JSON.stringify(metrics.getSnapshot()).length).toBeLessThan(beforeSize + 20);
    expect(Object.keys(metrics.getSnapshot())).toEqual(["open", "task", "interaction"]);
});

test("invalid clocks and empty interaction samples cannot corrupt the local aggregate", () => {
    const metrics = createCanvasExperienceMetrics();
    metrics.recordOpen(-1, 10);
    metrics.recordTask(Number.NaN);
    metrics.recordTask(Infinity);
    expect(metrics.getSnapshot().open.count).toBe(0);
    expect(metrics.getSnapshot().task.count).toBe(0);
    metrics.recordTask(400);
    metrics.clear();
    expect(metrics.getSnapshot().task.count).toBe(0);
});
