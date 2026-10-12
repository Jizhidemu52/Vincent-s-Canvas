import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Read original prompts once per selection, without replacing an active edit. */
export function createCanvasSelectionPromptSync() {
    let previousSelectionKey: string | undefined;

    return (selectedIds: ReadonlySet<string>, selectedNodes: readonly CanvasNodeData[], projectId?: string) => {
        const selectionKey = JSON.stringify([projectId, ...Array.from(selectedIds).sort()]);
        if (selectionKey === previousSelectionKey) return undefined;

        const node = selectedIds.size === 1 ? selectedNodes.find((candidate) => selectedIds.has(candidate.id)) : undefined;
        // Wait for a selected node to be available rather than consuming its identity early.
        if (selectedIds.size === 1 && !node) return undefined;
        previousSelectionKey = selectionKey;

        // Clicking empty canvas keeps the current draft available for creation.
        if (!selectedIds.size || (node && node.type !== CanvasNodeType.Image)) return undefined;
        // Multiple nodes have no single original prompt; uploaded images may have none.
        return node?.metadata?.prompt ?? "";
    };
}
