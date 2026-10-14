import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

type SelectedGenerationSettings = Pick<CanvasNodeMetadata, "model" | "size" | "quality" | "count" | "imageOptions"> & { prompt: string };

/** Read saved image settings once per selection, without replacing active edits. */
export function createCanvasSelectionGenerationSync() {
    let previousSelectionKey: string | undefined;

    return (selectedIds: ReadonlySet<string>, selectedNodes: readonly CanvasNodeData[], projectId?: string): SelectedGenerationSettings | undefined => {
        const selectionKey = JSON.stringify([projectId, ...Array.from(selectedIds).sort()]);
        if (selectionKey === previousSelectionKey) return undefined;

        const node = selectedIds.size === 1 ? selectedNodes.find((candidate) => selectedIds.has(candidate.id)) : undefined;
        // Wait for a selected node to be available rather than consuming its identity early.
        if (selectedIds.size === 1 && !node) return undefined;
        previousSelectionKey = selectionKey;

        // Clicking empty canvas keeps the current draft available for creation.
        if (!selectedIds.size || (node && node.type !== CanvasNodeType.Image)) return undefined;
        // Multiple nodes have no single original prompt; uploaded images may have none.
        const settings: SelectedGenerationSettings = { prompt: node?.metadata?.prompt ?? "" };
        for (const key of ["model", "size", "quality", "imageOptions"] as const) {
            const value = node?.metadata?.[key];
            if (value !== undefined) settings[key] = value;
        }
        if (node?.metadata?.count !== undefined) settings.count = node.metadata.count;
        return settings;
    };
}

/** The assistant still recalls only the original prompt. */
export function createCanvasSelectionPromptSync() {
    const sync = createCanvasSelectionGenerationSync();
    return (selectedIds: ReadonlySet<string>, selectedNodes: readonly CanvasNodeData[], projectId?: string) => sync(selectedIds, selectedNodes, projectId)?.prompt;
}
