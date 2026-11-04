import { canvasGenerationEditorState } from "@/lib/canvas/canvas-generation-editor";
import { canvasNodeGenerationReferences, hasIncompleteCanvasGenerationReferences } from "@/lib/canvas/canvas-generation-record";
import { canvasImageReferenceMentions } from "@/lib/canvas/canvas-image-references";
import { createCanvasTextDraft, type CanvasTextDraftScheduler } from "@/lib/canvas/canvas-text-draft";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/** Empty/loading/error results use the same inputs as the creation rail. */
export function canvasNodePromptPanelInput(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], config: AiConfig) {
    const editor = canvasGenerationEditorState(node, nodes, connections, config);
    const references = canvasNodeGenerationReferences(node, nodes, connections);
    const metadata = node.metadata;
    const usesSnapshot = Boolean(metadata?.generationRecord || metadata?.draftImageReferences !== undefined || metadata?.generationType || metadata?.sourceTaskId);
    return {
        prompt: editor.prompt,
        config: usesSnapshot ? { ...config, model: editor.model, size: editor.size, quality: editor.quality, imageOptions: editor.imageOptions, count: String(editor.count) } : config,
        references,
        // Every submitted snapshot stays visible and keeps the same mention order.
        visibleReferences: references.map((reference, index) => ({ reference, index })),
        mentions: canvasImageReferenceMentions(references),
        usesSnapshot,
        incompleteReferences: metadata?.draftImageReferences === undefined && hasIncompleteCanvasGenerationReferences(node),
    };
}

/** A delayed commit must never adopt the id of a subsequently selected node. */
export function createCanvasNodePromptDraft(nodeId: string, prompt: string, onCommit: (nodeId: string, value: string) => void, scheduler?: CanvasTextDraftScheduler) {
    return createCanvasTextDraft(prompt, value => onCommit(nodeId, value), scheduler);
}
