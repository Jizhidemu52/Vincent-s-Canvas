import type { CanvasInteractionMetrics } from "./canvas-performance-metrics";
import type { CanvasExperienceMetrics } from "./canvas-experience-metrics";

const number = (value: number | undefined) => Number.isFinite(value) && value! >= 0 ? Math.round(value! * 10) / 10 : 0;
const interactionLabels: Record<string, string> = { canvas: "画布交互（拖拽 / 平移 / 缩放）", drag: "节点拖拽", pan: "画布平移", zoom: "画布缩放", resize: "节点缩放", marquee: "框选", idle: "空闲" };
export const canvasInteractionLabel = (interaction: string) => Object.hasOwn(interactionLabels, interaction) ? interactionLabels[interaction] : "其他交互";

// Whitelist fields explicitly. Never serialize arbitrary metric objects or a
// caller-supplied interaction name, URL, node title or user identifier.
export function canvasPerformanceReport(metrics: CanvasInteractionMetrics | null) {
    return ["画布性能报告（本页内存，手动复制）", ...(metrics ? [
        `最近场景：${canvasInteractionLabel(metrics.interaction)}`,
        `节点：总计 ${number(metrics.totalNodes)} / 可见 ${number(metrics.visibleNodes)}`,
        `连线：总计 ${number(metrics.totalConnections)} / 可见 ${number(metrics.visibleConnections)}`,
        `平均 FPS：${number(metrics.averageFps)}；P95：${number(metrics.p95FrameMs)} ms；最长帧：${number(metrics.maxFrameMs)} ms`,
        `长帧（>50 ms）：${number(metrics.longFrameCount)}；后台停顿（≥750 ms）：${number(metrics.stalledFrameGapCount)}；采样帧：${number(metrics.sampledFrameCount)}`,
    ] : ["最近场景：暂无交互样本，请先拖拽、平移或缩放画布"]),
    "仅统计数据，不含画布内容、图片、提示词、网址或员工信息；未自动上报。"].join("\n");
}

export function canvasExperienceReport(metrics: CanvasExperienceMetrics) {
    return [canvasPerformanceReport(metrics.interaction.lastSample),
        `画布打开：${number(metrics.open.count)} 次；最近 ${number(metrics.open.lastMs)} ms；最近节点数 ${number(metrics.open.lastNodeCount)}`,
        `交互累计：${number(metrics.interaction.count)} 次；长帧 ${number(metrics.interaction.longFrameCount)}；后台停顿 ${number(metrics.interaction.stalledFrameGapCount)}；最长帧 ${number(metrics.interaction.worstFrameMs)} ms`,
        `完整任务：${number(metrics.task.count)} 次；平均 ${number(metrics.task.meanMs)} ms；最长 ${number(metrics.task.maxMs)} ms（不含恢复旧任务）`,
    ].join("\n");
}
