export function applyCanvasStreamedTextUpdates(current: ReadonlyMap<string, string>, updates: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    let next: Map<string, string> | null = null;
    updates.forEach((content, nodeId) => {
        if (current.get(nodeId) === content) return;
        if (!next) next = new Map(current);
        next.set(nodeId, content);
    });
    return next || current;
}

export function clearCanvasStreamedText(current: ReadonlyMap<string, string>, nodeIds: Iterable<string>): ReadonlyMap<string, string> {
    let next: Map<string, string> | null = null;
    for (const nodeId of nodeIds) {
        if (!current.has(nodeId)) continue;
        if (!next) next = new Map(current);
        next.delete(nodeId);
    }
    return next || current;
}
