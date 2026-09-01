import type { CanvasInteractionMetrics } from "@/lib/canvas/canvas-performance-metrics";

export function CanvasPerformancePanel({ metrics }: { metrics: CanvasInteractionMetrics | null }) {
    if (!metrics) return null;

    return (
        <aside className="fixed bottom-5 right-5 z-[200] w-64 rounded-2xl border border-slate-300/70 bg-white/95 p-3 text-xs text-slate-700 shadow-xl backdrop-blur" data-canvas-no-zoom>
            <div className="mb-2 flex items-center justify-between font-semibold text-slate-900">
                <span>Canvas perf</span>
                <span>{metrics.interaction}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 tabular-nums">
                <span>FPS {metrics.averageFps}</span>
                <span>P95 {metrics.p95FrameMs}ms</span>
                <span>long {metrics.longFrameCount}</span>
                <span>max {metrics.maxFrameMs}ms</span>
                <span>nodes {metrics.visibleNodes}/{metrics.totalNodes}</span>
                <span>links {metrics.visibleConnections}/{metrics.totalConnections}</span>
            </div>
        </aside>
    );
}
