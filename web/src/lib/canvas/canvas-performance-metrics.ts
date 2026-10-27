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
    sampledFrameCount?: number;
};

// A background/throttled browser commonly reports ~1000 ms rAF gaps. Those
// are not paint costs for the active canvas, so show them separately instead
// of turning a useful interaction sample into a misleading 1 FPS report.
const STALLED_FRAME_GAP_MS = 750;
const MAX_FRAME_SAMPLES = 3600;

export function createCanvasPerformanceTracker() {
    let interaction = "idle";
    let frameDurations: number[] = [];
    let stalledFrameGapCount = 0;
    let frameCount = 0, totalFrameDuration = 0, maxFrameMs = 0, longFrameCount = 0;

    return {
        start(nextInteraction: string, _now: number) {
            interaction = nextInteraction;
            frameDurations = [];
            stalledFrameGapCount = 0;
            frameCount = 0; totalFrameDuration = 0; maxFrameMs = 0; longFrameCount = 0;
        },
        frame(durationMs: number) {
            if (!Number.isFinite(durationMs) || durationMs < 0) return;
            if (durationMs >= STALLED_FRAME_GAP_MS) {
                stalledFrameGapCount += 1;
                return;
            }
            // Bound the P95 sample window even when a drag stays active for
            // hours. Totals and worst frame still cover the whole interaction.
            frameDurations[frameCount % MAX_FRAME_SAMPLES] = durationMs;
            frameCount++;
            totalFrameDuration += durationMs;
            maxFrameMs = Math.max(maxFrameMs, durationMs);
            if (durationMs > 50) longFrameCount++;
        },
        finish(_now: number, counts: CanvasVisibilityCounts): CanvasInteractionMetrics {
            const samples = frameDurations.slice().sort((a, b) => a - b);
            const averageFrameMs = frameCount ? totalFrameDuration / frameCount : 0;
            const p95Index = samples.length ? Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * 0.95) - 1)) : 0;
            const metrics = {
                interaction,
                averageFps: averageFrameMs > 0 ? Math.round((1000 / averageFrameMs) * 10) / 10 : 0,
                p95FrameMs: samples[p95Index] || 0,
                maxFrameMs,
                longFrameCount,
                stalledFrameGapCount,
                sampledFrameCount: samples.length,
                ...counts,
            };
            interaction = "idle";
            frameDurations = [];
            stalledFrameGapCount = 0;
            frameCount = 0; totalFrameDuration = 0; maxFrameMs = 0; longFrameCount = 0;
            return metrics;
        },
    };
}
