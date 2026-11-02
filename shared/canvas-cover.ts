type CoverNode = { id: string; type: string; metadata?: { content?: string; storageKey?: string; status?: string; sourceTaskId?: string; generationOrigin?: unknown; generationRecord?: { createdAt?: string } } };

/** User choice wins; otherwise prefer the newest completed generated image. */
export function selectCanvasCoverNode<T extends CoverNode>(nodes: readonly T[], preferredId?: string): T | undefined {
    const images = nodes.filter(node => node.type === "image" && node.metadata?.status !== "loading" && node.metadata?.status !== "error" && (node.metadata?.storageKey || node.metadata?.content));
    const preferred = preferredId ? images.find(node => node.id === preferredId) : undefined;
    if (preferred) return preferred;
    let generated: T | undefined;
    let latest = -Infinity;
    for (const node of images) {
        if (!node.metadata?.sourceTaskId && !node.metadata?.generationOrigin && !node.metadata?.generationRecord) continue;
        const timestamp = Date.parse(node.metadata.generationRecord?.createdAt || "");
        const order = Number.isFinite(timestamp) ? timestamp : 0;
        // Equal/unknown timestamps use the later canvas result, not the source.
        if (order >= latest) { generated = node; latest = order; }
    }
    return generated || images[0];
}
