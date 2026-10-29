import { useSyncExternalStore } from "react";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasInteractionMetrics } from "./canvas-performance-metrics";

type DurationSummary = { count: number; lastMs: number; meanMs: number; maxMs: number };
export type CanvasExperienceMetrics = {
    open: DurationSummary & { lastNodeCount: number };
    task: DurationSummary;
    interaction: { count: number; longFrameCount: number; stalledFrameGapCount: number; lastFps: number; lastP95Ms: number; worstFrameMs: number; lastSample: CanvasInteractionMetrics | null };
};
const duration = (): DurationSummary => ({ count: 0, lastMs: 0, meanMs: 0, maxMs: 0 });
const empty = (): CanvasExperienceMetrics => ({ open: { ...duration(), lastNodeCount: 0 }, task: duration(), interaction: { count: 0, longFrameCount: 0, stalledFrameGapCount: 0, lastFps: 0, lastP95Ms: 0, worstFrameMs: 0, lastSample: null } });
const validDuration = (ms: number) => Number.isFinite(ms) && ms >= 0;
function addDuration(previous: DurationSummary, ms: number): DurationSummary {
    const count = previous.count + 1;
    return { count, lastMs: Math.round(ms), meanMs: previous.meanMs + (ms - previous.meanMs) / count, maxMs: Math.max(previous.maxMs, Math.round(ms)) };
}

/** Fixed-size, page-lifetime aggregates. No history, identifiers, prompt data,
 * local database writes, analytics endpoint or background collection. */
export function createCanvasExperienceMetrics() {
    let snapshot = empty();
    const listeners = new Set<() => void>();
    const publish = (next: CanvasExperienceMetrics) => { snapshot = next; for (const listener of listeners) listener(); };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        clear() { publish(empty()); },
        recordOpen(ms: number, nodeCount: number) {
            if (!validDuration(ms) || !Number.isFinite(nodeCount) || nodeCount < 0) return;
            publish({ ...snapshot, open: { ...addDuration(snapshot.open, ms), lastNodeCount: Math.floor(nodeCount) } });
        },
        recordTask(ms: number) {
            if (validDuration(ms)) publish({ ...snapshot, task: addDuration(snapshot.task, ms) });
        },
        recordInteraction(metrics: CanvasInteractionMetrics) {
            if (![metrics.averageFps, metrics.p95FrameMs, metrics.maxFrameMs, metrics.longFrameCount, metrics.stalledFrameGapCount].every(validDuration)) return;
            if (metrics.averageFps === 0 && !metrics.stalledFrameGapCount) return;
            const previous = snapshot.interaction;
            publish({ ...snapshot, interaction: {
                count: previous.count + 1,
                longFrameCount: previous.longFrameCount + metrics.longFrameCount,
                stalledFrameGapCount: previous.stalledFrameGapCount + metrics.stalledFrameGapCount,
                lastFps: metrics.averageFps, lastP95Ms: metrics.p95FrameMs, worstFrameMs: Math.max(previous.worstFrameMs, metrics.maxFrameMs),
                lastSample: {
                    interaction: ["canvas", "drag", "pan", "zoom", "resize", "marquee", "idle"].includes(metrics.interaction) ? metrics.interaction : "other",
                    averageFps: metrics.averageFps, p95FrameMs: metrics.p95FrameMs, maxFrameMs: metrics.maxFrameMs,
                    longFrameCount: metrics.longFrameCount, stalledFrameGapCount: metrics.stalledFrameGapCount,
                    sampledFrameCount: metrics.sampledFrameCount,
                    totalNodes: metrics.totalNodes, visibleNodes: metrics.visibleNodes,
                    totalConnections: metrics.totalConnections, visibleConnections: metrics.visibleConnections,
                },
            } });
        },
    };
}

const localMetrics = createCanvasExperienceMetrics();
export const recordCanvasOpen = localMetrics.recordOpen;
export const recordCanvasTaskTiming = localMetrics.recordTask;
export const recordCanvasInteraction = localMetrics.recordInteraction;
export function useCanvasExperienceMetrics() {
    return useSyncExternalStore(localMetrics.subscribe, localMetrics.getSnapshot, localMetrics.getSnapshot);
}
useUserStore.subscribe((state, previous) => { if (state.user?.id !== previous.user?.id) localMetrics.clear(); });
