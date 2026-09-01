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
};

export function createCanvasPerformanceTracker() {
    let interaction = "idle";
    let startedAt = 0;
    let frameDurations: number[] = [];

    return {
        start(nextInteraction: string, now: number) {
            interaction = nextInteraction;
            startedAt = now;
            frameDurations = [];
        },
        frame(durationMs: number) {
            if (Number.isFinite(durationMs) && durationMs >= 0) frameDurations.push(durationMs);
        },
        finish(now: number, counts: CanvasVisibilityCounts): CanvasInteractionMetrics {
            const samples = frameDurations.slice().sort((a, b) => a - b);
            const totalDuration = samples.reduce((sum, duration) => sum + duration, 0);
            const averageFrameMs = samples.length ? totalDuration / samples.length : Math.max(now - startedAt, 0);
            const p95Index = samples.length ? Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * 0.95) - 1)) : 0;
            const metrics = {
                interaction,
                averageFps: averageFrameMs > 0 ? Math.round((1000 / averageFrameMs) * 10) / 10 : 0,
                p95FrameMs: samples[p95Index] || 0,
                maxFrameMs: samples.at(-1) || 0,
                longFrameCount: samples.filter((duration) => duration > 50).length,
                ...counts,
            };
            interaction = "idle";
            startedAt = 0;
            frameDurations = [];
            return metrics;
        },
    };
}
