export interface CanvasHoverState {
    activeId: string | null;
    pendingId: string | null;
}

export function beginCanvasHover(state: CanvasHoverState, nodeId: string): CanvasHoverState {
    if (state.activeId === nodeId) return { activeId: nodeId, pendingId: null };
    return { activeId: state.activeId, pendingId: nodeId };
}

export function commitCanvasHover(state: CanvasHoverState): CanvasHoverState {
    if (!state.pendingId) return state;
    return { activeId: state.pendingId, pendingId: null };
}

export function endCanvasHover(state: CanvasHoverState, nodeId: string): CanvasHoverState {
    if (state.pendingId === nodeId) return { activeId: null, pendingId: null };
    if (state.activeId === nodeId && state.pendingId) return state;
    if (state.activeId === nodeId) return { activeId: null, pendingId: null };
    return state;
}

/** Canvas movement invalidates hover affordances until the pointer settles again. */
export function resetCanvasHover(_state: CanvasHoverState): CanvasHoverState {
    return { activeId: null, pendingId: null };
}
