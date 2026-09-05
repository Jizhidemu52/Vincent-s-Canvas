export type CanvasVisibilityCounts = {
    totalNodes: number;
    visibleNodes: number;
    totalConnections: number;
    visibleConnections: number;
};

export type CanvasInteractionMetrics = CanvasVisibilityCounts & {
    interaction: string;
    averageFps: number;
    p95FrameMs: number;
    maxFrameMs: number;
    longFrameCount: number;
    stalledFrameGapCount: number;
};

// A background/throttled browser commonly reports ~1000 ms rAF gaps. Those
// are not paint costs for the active canvas, so show them separately instead
// of turning a useful interaction sample into a misleading 1 FPS report.
const STALLED_FRAME_GAP_MS = 750;

export function createCanvasPerformanceTracker() {
    let interaction = "idle";
    let frameDurations: number[] = [];
    let stalledFrameGapCount = 0;

    return {
        start(nextInteraction: string, _now: number) {
            interaction = nextInteraction;
            frameDurations = [];
            stalledFrameGapCount = 0;
        },
        frame(durationMs: number) {
            if (!Number.isFinite(durationMs) || durationMs < 0) return;
            if (durationMs >= STALLED_FRAME_GAP_MS) {
                stalledFrameGapCount += 1;
                return;
            }
            frameDurations.push(durationMs);
        },
        finish(_now: number, counts: CanvasVisibilityCounts): CanvasInteractionMetrics {
            const samples = frameDurations.slice().sort((a, b) => a - b);
            const totalDuration = samples.reduce((sum, duration) => sum + duration, 0);
            const averageFrameMs = samples.length ? totalDuration / samples.length : 0;
            const p95Index = samples.length ? Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * 0.95) - 1)) : 0;
            const metrics = {
                interaction,
                averageFps: averageFrameMs > 0 ? Math.round((1000 / averageFrameMs) * 10) / 10 : 0,
                p95FrameMs: samples[p95Index] || 0,
                maxFrameMs: samples.at(-1) || 0,
                longFrameCount: samples.filter((duration) => duration > 50).length,
                stalledFrameGapCount,
                ...counts,
            };
            interaction = "idle";
            frameDurations = [];
            stalledFrameGapCount = 0;
            return metrics;
        },
    };
}
