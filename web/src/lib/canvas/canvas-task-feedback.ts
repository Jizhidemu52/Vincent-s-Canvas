import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasTaskProgress = { total: number; completed: number; active: number; successful: number; failed: number; stopped: number };
type Attempt = { nodeId: string; state: "active" | "successful" | "failed" | "stopped"; startedAt?: number; recovered: boolean };

/** Observe the existing graph only; this helper cannot submit or query a task. */
export function createCanvasTaskFeedbackTracker() {
    let initialized = false;
    let attempts: Attempt[] = [];
    let previousLoading = new Set<string>();
    return {
        update(nodes: readonly CanvasNodeData[], connections: readonly CanvasConnection[], now = performance.now()) {
            const byId = new Map(nodes.map(node => [node.id, node]));
            const sourceIds = new Set(connections.filter(edge => edge.kind === "generation-output").map(edge => edge.fromNodeId));
            const excluded = (node: CanvasNodeData) => node.type === CanvasNodeType.Config || node.metadata?.isBatchRoot
                || (node.type === CanvasNodeType.Text && sourceIds.has(node.id) && !node.metadata?.generationOrigin && !node.metadata?.textRequestId);
            // Source text can briefly be loading while its output is being
            // prepared. Once the output edge exists it is not another result.
            attempts = attempts.filter(attempt => !byId.has(attempt.nodeId) || !excluded(byId.get(attempt.nodeId)!));
            const wasActive = attempts.some(attempt => attempt.state === "active");
            const pending = nodes.filter(node => !excluded(node) && node.metadata?.status === "loading");
            const newPending = pending.filter(node => !previousLoading.has(node.id));
            if (!wasActive && newPending.length) attempts = [];
            const active = new Map(attempts.filter(attempt => attempt.state === "active").map(attempt => [attempt.nodeId, attempt]));
            for (const node of newPending) {
                const attempt: Attempt = { nodeId: node.id, state: "active", recovered: !initialized };
                attempts.push(attempt);
                active.set(node.id, attempt);
            }
            const completedIds: string[] = [], timings: number[] = [];
            for (const attempt of active.values()) {
                const node = byId.get(attempt.nodeId);
                if (node?.metadata?.status === "loading") {
                    // The persisted binding is written immediately before POST.
                    // Restored bindings have no local start time: do not invent one.
                    if (!attempt.recovered && attempt.startedAt === undefined && (node.metadata.imageTask || node.metadata.mediaTask)) attempt.startedAt = now;
                    continue;
                }
                attempt.state = node?.metadata?.status === "success" ? "successful" : node?.metadata?.status === "error" ? "failed" : "stopped";
                if (attempt.state === "successful") {
                    completedIds.push(attempt.nodeId);
                    if (attempt.startedAt !== undefined && now >= attempt.startedAt) timings.push(now - attempt.startedAt);
                }
            }
            previousLoading = new Set(pending.map(node => node.id));
            initialized = true;
            const progress: CanvasTaskProgress = { total: attempts.length, completed: 0, active: 0, successful: 0, failed: 0, stopped: 0 };
            for (const attempt of attempts) progress[attempt.state]++;
            progress.completed = progress.successful + progress.failed + progress.stopped;
            return { progress, completedIds, timings, batchFinished: wasActive && progress.active === 0 && progress.total > 0 };
        },
    };
}

export function canvasTaskProgressTitle(original: string, progress: CanvasTaskProgress) {
    return progress.active > 0 ? `(${progress.completed}/${progress.total}) ${original}` : original;
}
