export type CanvasNodePromptDraftSource = {
    metadata?: { content?: string; prompt?: string; draftPrompt?: string; quickImageAction?: "remove-background" | "hd-upscale" | "item-extract" };
};

export function canvasNodePromptDraft(node: CanvasNodePromptDraftSource) {
    if (node.metadata?.draftPrompt !== undefined) {
        return node.metadata.draftPrompt;
    }

    // Show the original generation prompt until the user saves an edit draft.
    // Editing remains separate from provenance, including intentionally empty drafts.
    return node.metadata?.quickImageAction ? "" : node.metadata?.prompt ?? "";
}

export function canvasNodePromptDraftPatch(draftPrompt: string) {
    return { draftPrompt };
}
