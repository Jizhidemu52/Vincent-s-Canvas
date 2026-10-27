import { useEffect } from "react";
import { LocateFixed, Settings2 } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasExperienceMetrics } from "@/lib/canvas/canvas-experience-metrics";
import { useCanvasTaskFeedback, type CanvasTaskFeedbackValue } from "@/pages/canvas/use-canvas-task-feedback";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/** Lazy boundary: feedback logic does not enlarge the first canvas route chunk. */
export function CanvasTaskFeedbackRuntime({ onHighlightChange, ...props }: {
    projectId: string; enabled: boolean; nodes: CanvasNodeData[]; connections: CanvasConnection[];
    onLocate: (ids: string[]) => void; onHighlightChange: (ids: string[]) => void;
}) {
    const feedback = useCanvasTaskFeedback(props);
    useEffect(() => { onHighlightChange(feedback.highlightedNodeIds); }, [feedback.highlightedNodeIds, onHighlightChange]);
    useEffect(() => () => onHighlightChange([]), [onHighlightChange]);
    return <CanvasTaskFeedback feedback={feedback} />;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;
export function CanvasTaskFeedback({ feedback }: { feedback: CanvasTaskFeedbackValue }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const metrics = useCanvasExperienceMetrics();
    const { progress } = feedback;
    return <div className="flex items-center gap-3 text-xs" style={{ color: theme.toolbar.item }} data-canvas-no-zoom data-testid="canvas-task-feedback">
        <span role="status" aria-live="polite" aria-atomic="true">
            {progress.active ? `生成进度 ${progress.completed}/${progress.total}` : progress.total ? `已结束：${progress.successful} 个成功${progress.failed ? `，${progress.failed} 个失败` : ""}${progress.stopped ? `，${progress.stopped} 个已停止观察` : ""}` : ""}
        </span>
        {feedback.latestResultIds.length ? <button type="button" className="inline-flex items-center gap-1.5 rounded px-1 py-1 hover:opacity-75" onClick={feedback.locateLatest}>
            <LocateFixed size={14} />定位到结果
        </button> : null}
        <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 hover:opacity-75" aria-label="本页体验数据"><Settings2 size={14} /><span>体验数据</span></summary>
            <div className="absolute bottom-full right-0 z-[220] mb-3 w-72 max-w-[calc(100vw-2rem)] rounded-xl border p-4 text-xs" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                <div>
                    <div className="mb-2 font-medium">本页体验数据</div>
                    <dl className="space-y-2 tabular-nums">
                        <div><dt>画布打开 / 最近节点数</dt><dd>{metrics.open.count ? `${seconds(metrics.open.lastMs)} / ${metrics.open.lastNodeCount} 个` : "暂无样本"}</dd></div>
                        <div><dt>拖拽与平移 / 最近 FPS · P95</dt><dd>{metrics.interaction.count ? `${metrics.interaction.lastFps} · ${Math.round(metrics.interaction.lastP95Ms)} ms` : "暂无样本"}</dd></div>
                        <div><dt>交互长帧 (&gt;50ms) / 后台停顿</dt><dd>{metrics.interaction.longFrameCount} / {metrics.interaction.stalledFrameGapCount}</dd></div>
                        <div><dt>提交开始至结果就绪 / 平均</dt><dd>{metrics.task.count ? `${seconds(metrics.task.meanMs)}（${metrics.task.count} 次）` : "暂无本页完整提交样本"}</dd></div>
                    </dl>
                    <p className="mt-3 leading-5" style={{ color: theme.node.muted }}>仅本页内存汇总，刷新清空；不含提示词、图片或任务标识，不对外发送。恢复旧任务不计入本页完整提交耗时。</p>
                </div>
            </div>
        </details>
    </div>;
}
