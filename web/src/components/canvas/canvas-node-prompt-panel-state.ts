import { canvasGenerationEditorState, visibleCanvasEditorReferences } from "@/lib/canvas/canvas-generation-editor";
import { canvasNodeGenerationReferences, hasIncompleteCanvasGenerationReferences } from "@/lib/canvas/canvas-generation-record";
import { canvasImageReferenceMentions } from "@/lib/canvas/canvas-image-references";
import { createCanvasTextDraft, type CanvasTextDraftScheduler } from "@/lib/canvas/canvas-text-draft";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/** Empty/loading/error results use the same inputs as the creation rail. */
export function canvasNodePromptPanelInput(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], config: AiConfig) {
    const editor = canvasGenerationEditorState(node, nodes, connections, config);
    const references = canvasNodeGenerationReferences(node, nodes, connections);
    const visibleKeys = new Set(visibleCanvasEditorReferences(editor.references, nodes).map(reference => reference.id));
    const metadata = node.metadata;
    const usesSnapshot = Boolean(metadata?.generationRecord || metadata?.draftImageReferences !== undefined || metadata?.generationType || metadata?.sourceTaskId);
    return {
        prompt: editor.prompt,
        config: usesSnapshot ? { ...config, model: editor.model, size: editor.size, quality: editor.quality, imageOptions: editor.imageOptions, count: String(editor.count) } : config,
        references,
        // Preserve positions in the full request, even when a deleted source is hidden.
        visibleReferences: references.map((reference, index) => ({ reference, index })).filter(({ reference }) => visibleKeys.has(reference.referenceKey)),
        mentions: canvasImageReferenceMentions(references).filter(reference => visibleKeys.has(reference.id)),
        usesSnapshot,
        incompleteReferences: metadata?.draftImageReferences === undefined && hasIncompleteCanvasGenerationReferences(node),
    };
}

/** A delayed commit must never adopt the id of a subsequently selected node. */
export function createCanvasNodePromptDraft(nodeId: string, prompt: string, onCommit: (nodeId: string, value: string) => void, scheduler?: CanvasTextDraftScheduler) {
    return createCanvasTextDraft(prompt, value => onCommit(nodeId, value), scheduler);
}
