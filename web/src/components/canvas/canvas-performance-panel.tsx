import { useUiText } from "@/lib/i18n";
import { memo } from "react";
import { Copy } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy-text";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasInteractionLabel, canvasPerformanceReport } from "@/lib/canvas/canvas-performance-report";

import type { CanvasInteractionMetrics } from "@/lib/canvas/canvas-performance-metrics";

export const CanvasPerformancePanel = memo(function CanvasPerformancePanel({ metrics }: { metrics: CanvasInteractionMetrics | null }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const copy = useCopyText();
    if (!metrics) return null;

    return (
        <aside className="fixed bottom-5 right-5 z-[200] w-72 max-w-[calc(100vw-2.5rem)] rounded-2xl border p-3 text-xs shadow-xl backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} data-canvas-no-zoom>
            <div className="mb-2 flex items-center justify-between font-semibold">
                <span>Canvas perf</span>
                <span>{canvasInteractionLabel(metrics.interaction)}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 tabular-nums">
                <span>FPS {metrics.averageFps}</span>
                <span>P95 {metrics.p95FrameMs}ms</span>
                <span>long {metrics.longFrameCount}</span>
                <span>max {metrics.maxFrameMs}ms</span>
                <span>stalled {metrics.stalledFrameGapCount}</span>
                <span>nodes {metrics.visibleNodes}/{metrics.totalNodes}</span>
                <span>links {metrics.visibleConnections}/{metrics.totalConnections}</span>
            </div>
            <button type="button" className="mt-3 inline-flex items-center gap-1.5 rounded py-1 hover:opacity-75" onClick={() => copy(canvasPerformanceReport(metrics), t("性能报告已复制（不含画布内容）"))}><Copy size={13} />{t("复制性能报告")}</button>
        </aside>
    );
});
