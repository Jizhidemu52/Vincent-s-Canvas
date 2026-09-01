export type CanvasNodePromptDraftSource = {
    metadata?: { content?: string; prompt?: string; draftPrompt?: string };
};

export function canvasNodePromptDraft(node: CanvasNodePromptDraftSource) {
    if (node.metadata?.draftPrompt !== undefined) {
        return node.metadata.draftPrompt;
    }

    // Existing media keeps its original generation prompt as provenance. An edit
    // starts from an intentionally blank draft, then survives panel unmounts.
    return node.metadata?.content ? "" : node.metadata?.prompt ?? "";
}

export function canvasNodePromptDraftPatch(draftPrompt: string) {
    return { draftPrompt };
}
