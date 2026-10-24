import type { CanvasAgentUndoReport } from "./canvas-agent-ops";

/** Shared text must not pull the lazy inverse engine into an Agent panel. */
export function canvasAgentUndoMessage(report: CanvasAgentUndoReport) {
    if (!report.conflicts.length) return report.applied ? `已撤销上一次助手操作的 ${report.applied} 项修改。` : "本批修改已撤销，无需重复操作。";
    const prefix = report.applied ? `已部分撤销 ${report.applied} 项修改` : "暂未撤销任何修改";
    return `${prefix}；${report.conflicts.length} 处冲突已保留当前内容。处理冲突后可再次点击撤销，仅重试未完成部分。`;
}
