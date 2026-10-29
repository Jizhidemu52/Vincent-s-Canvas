import { expect, test } from "bun:test";
import { createCanvasExperienceMetrics } from "@/lib/canvas/canvas-experience-metrics";
import { canvasExperienceReport, canvasPerformanceReport } from "@/lib/canvas/canvas-performance-report";

const sample = { interaction: "drag", averageFps: 59.9, p95FrameMs: 16.666, maxFrameMs: 32, longFrameCount: 0, stalledFrameGapCount: 1, sampledFrameCount: 123, totalNodes: 500, visibleNodes: 32, totalConnections: 400, visibleConnections: 21 };
test("manual performance report names the scene and numeric frame/visibility data", () => {
    const report = canvasPerformanceReport(sample);
    expect(report).toContain("节点拖拽");
    expect(report).toContain("总计 500 / 可见 32");
    expect(report).toContain("P95：16.7 ms");
    expect(report).toContain("采样帧：123");
    expect(report).toContain("后台停顿（≥750 ms）：1");
});
test("unknown interactions and extra fields cannot leak content into local summaries or clipboard", () => {
    const metrics = createCanvasExperienceMetrics();
    const hostile = { ...sample, interaction: "private-user-secret https://private/image", title: "private-title-secret", prompt: "private-prompt-secret", nodeIds: ["private-node-secret"] };
    metrics.recordOpen(120, 500);
    metrics.recordTask(800);
    metrics.recordInteraction(hostile);
    const report = canvasExperienceReport(metrics.getSnapshot());
    expect(report).toContain("其他交互");
    expect(report).toContain("完整任务：1 次");
    expect(report).not.toContain("private-");
    expect(JSON.stringify(metrics.getSnapshot())).not.toContain("private-");
    expect(canvasPerformanceReport(hostile)).not.toContain("private-");
    metrics.clear();
    expect(canvasExperienceReport(metrics.getSnapshot())).toContain("暂无交互样本");
});
test("report handles missing samples and non-finite optional numbers without raw JSON", () => {
    expect(canvasPerformanceReport(null)).toContain("暂无交互样本");
    expect(canvasPerformanceReport({ ...sample, maxFrameMs: Infinity, sampledFrameCount: NaN })).not.toMatch(/Infinity|NaN|undefined/);
});
