import { useUiText, uiText } from "@/lib/i18n";
import { useEffect } from "react";
import { Copy, LocateFixed, Settings2 } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy-text";
import { canvasExperienceReport } from "@/lib/canvas/canvas-performance-report";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasDiagnosticsEnabled } from "@/lib/canvas/use-canvas-diagnostics-enabled";
import { useCanvasExperienceMetrics } from "@/lib/canvas/canvas-experience-metrics";
import { useCanvasTaskFeedback, type CanvasTaskFeedbackValue } from "@/pages/canvas/use-canvas-task-feedback";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/** Lazy boundary: feedback logic does not enlarge the first canvas route chunk. */
export function CanvasTaskFeedbackRuntime({ onHighlightChange, ...props }: {
    projectId: string; enabled: boolean; nodes: CanvasNodeData[]; connections: CanvasConnection[];
    onLocate: (ids: string[]) => void; onHighlightChange: (ids: string[]) => void;
}) {
    const t = useUiText();
    const feedback = useCanvasTaskFeedback(props);
    useEffect(() => { onHighlightChange(feedback.highlightedNodeIds); }, [feedback.highlightedNodeIds, onHighlightChange]);
    useEffect(() => () => onHighlightChange([]), [onHighlightChange]);
    return <CanvasTaskFeedback feedback={feedback} />;
}

const seconds = (ms: number) => uiText("{value1} 秒", { value1: (ms / 1000).toFixed(2) });
export function CanvasTaskFeedback({ feedback }: { feedback: CanvasTaskFeedbackValue }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const metrics = useCanvasExperienceMetrics();
    const diagnosticsEnabled = useCanvasDiagnosticsEnabled();
    const copy = useCopyText();
    const { progress } = feedback;
    return <div className="flex items-center gap-3 text-xs" style={{ color: theme.toolbar.item }} data-canvas-no-zoom data-testid="canvas-task-feedback">
        <span role="status" aria-live="polite" aria-atomic="true">
            {progress.active ? t("生成进度 {value1}/{value2}", { value1: progress.completed, value2: progress.total }) : progress.total ? t("已结束：{value1} 个成功{value2}{value3}", { value1: progress.successful, value2: progress.failed ? uiText("，{value1} 个失败", { value1: progress.failed }) : "", value3: progress.stopped ? uiText("，{value1} 个已停止观察", { value1: progress.stopped }) : "" }) : ""}
        </span>
        {feedback.latestResultIds.length ? <button type="button" className="inline-flex items-center gap-1.5 rounded px-1 py-1 hover:opacity-75" onClick={feedback.locateLatest}>
            <LocateFixed size={14} />{t("定位到结果")}</button> : null}
        {diagnosticsEnabled ? <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 hover:opacity-75" aria-label={t("本页体验数据")}><Settings2 size={14} /><span>{t("体验数据")}</span></summary>
            <div className="absolute bottom-full right-0 z-[220] mb-3 w-72 max-w-[calc(100vw-2rem)] rounded-xl border p-4 text-xs" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                <div>
                    <div className="mb-2 font-medium">{t("本页体验数据")}</div>
                    <dl className="space-y-2 tabular-nums">
                        <div><dt>{t("画布打开 / 最近节点数")}</dt><dd>{metrics.open.count ? t("{value1} / {value2} 个", { value1: seconds(metrics.open.lastMs), value2: metrics.open.lastNodeCount }) : t("暂无样本")}</dd></div>
                        <div><dt>{t("拖拽与平移 / 最近 FPS · P95")}</dt><dd>{metrics.interaction.count ? `${metrics.interaction.lastFps} · ${Math.round(metrics.interaction.lastP95Ms)} ms` : t("暂无样本")}</dd></div>
                        <div><dt>{t("交互长帧 (>50ms) / 后台停顿")}</dt><dd>{metrics.interaction.longFrameCount} / {metrics.interaction.stalledFrameGapCount}</dd></div>
                        <div><dt>{t("提交开始至结果就绪 / 平均")}</dt><dd>{metrics.task.count ? t("{value1}（{value2} 次）", { value1: seconds(metrics.task.meanMs), value2: metrics.task.count }) : t("暂无本页完整提交样本")}</dd></div>
                    </dl>
                    <button type="button" className="mt-3 inline-flex items-center gap-1.5 rounded py-1 hover:opacity-75" onClick={() => copy(canvasExperienceReport(metrics), t("体验报告已复制（不含画布内容）"))}><Copy size={13} />{t("复制体验报告")}</button>
                    <p className="mt-3 leading-5" style={{ color: theme.node.muted }}>{t("仅本页内存汇总，刷新清空；不含提示词、图片或任务标识，不对外发送。恢复旧任务不计入本页完整提交耗时。")}</p>
                </div>
            </div>
        </details> : null}
    </div>;
}
