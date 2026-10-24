import type { CanvasConnection } from "@/types/canvas";

export type CanvasAbortableRequest = {
    controller: Pick<AbortController, "abort">;
};

const OBSERVATION_STOPPED = "已停止本地观察，服务端任务可能继续";
export function stopCanvasObservation(controller: Pick<AbortController, "abort">) {
    controller.abort(new DOMException(OBSERVATION_STOPPED, "AbortError"));
}
export function shouldCancelCanvasGeneration(signal: AbortSignal) {
    return !(signal.reason instanceof Error && signal.reason.message === OBSERVATION_STOPPED);
}

export function canvasGenerationRunsForNodes(ids: ReadonlySet<string>, requests: Iterable<{ targetNodeId: string; originNodeId: string; runningNodeId: string }>, connections: CanvasConnection[]) {
    const runs = new Set<string>();
    for (const request of requests) {
        if (ids.has(request.targetNodeId) || ids.has(request.originNodeId) || ids.has(request.runningNodeId) ||
            connections.some(edge => edge.kind === "config-target" && ids.has(edge.fromNodeId) && edge.toNodeId === request.originNodeId)) runs.add(request.runningNodeId);
    }
    return runs;
}

/** Tracks the one project restore that is allowed to publish React state. */
export function createCanvasProjectAsyncLifecycle() {
    let currentToken = 0;

    return {
        begin() {
            currentToken += 1;
            return currentToken;
        },
        isCurrent(token: number) {
            return currentToken === token;
        },
        invalidate(token: number) {
            if (currentToken === token) currentToken += 1;
        },
    };
}

/** Stop observing a departed canvas without cancelling an accepted paid task. */
export function abortPendingCanvasRequests<T extends CanvasAbortableRequest>(requests: Map<string, T>) {
    requests.forEach((request) => stopCanvasObservation(request.controller));
    requests.clear();
}
