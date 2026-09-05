export type CanvasAbortableRequest = {
    controller: Pick<AbortController, "abort">;
};

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

/** Cancels network work that belongs to the canvas the user just left. */
export function abortPendingCanvasRequests<T extends CanvasAbortableRequest>(requests: Map<string, T>) {
    requests.forEach((request) => request.controller.abort());
    requests.clear();
}
