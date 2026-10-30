import { resolveCanvasNodeImageReferences } from "./canvas-image-references";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasGenerationRecord, CanvasNodeData, CanvasNodeMetadata, CanvasStoredImageReference } from "@/types/canvas";
import type { ImageReferenceItem, ReferenceImage } from "@/types/image";

export function createCanvasGenerationRecord(input: {
    id: string; sourceNodeId: string; configNodeId?: string; prompt: string; inputPrompt?: string;
    references: Array<ReferenceImage & Partial<Pick<ImageReferenceItem, "origin" | "referenceKey">> & { canvasNodeId?: string; sourceNodeId?: string }>; nodes: CanvasNodeData[]; config: AiConfig;
    generationType: CanvasGenerationRecord["parameters"]["generationType"];
    promptInput?: CanvasGenerationRecord["promptInput"]; createdAt?: string;
}): CanvasGenerationRecord {
    const { config } = input;
    return {
        version: 1, id: input.id, sourceNodeId: input.sourceNodeId, configNodeId: input.configNodeId,
        createdAt: input.createdAt || new Date().toISOString(), prompt: input.prompt, inputPrompt: input.inputPrompt ?? input.prompt,
        references: input.references.map((reference, order) => {
            const item = reference as Partial<ImageReferenceItem> & ReferenceImage & { canvasNodeId?: string; sourceNodeId?: string };
            const source = input.nodes.find(node => node.id === (item.canvasNodeId || item.sourceNodeId || reference.id));
            const sourceNodeId = item.canvasNodeId || item.sourceNodeId || (source && (!item.origin || item.origin === "canvas" || item.origin === "connection") ? source.id : undefined);
            return { id: reference.id, referenceKey: item.referenceKey || (sourceNodeId ? `node:${sourceNodeId}` : `reference:${reference.id}`),
                name: reference.name, originalFileName: reference.originalFileName, imageName: reference.imageName, imageVersion: reference.imageVersion,
                type: reference.type, content: reference.storageKey && source?.metadata?.storageKey === reference.storageKey ? source.metadata.content || "" : reference.dataUrl,
                storageKey: reference.storageKey, sourceNodeId, origin: item.origin === "asset" ? "asset" : sourceNodeId || item.origin === "canvas" ? "canvas" : "upload", order };
        }),
        parameters: { model: config.model, size: config.size, quality: config.quality, imageOptions: config.imageOptions || "", systemPrompt: config.systemPrompt || "", count: 1, generationType: input.generationType },
        ...(input.promptInput ? { promptInput: structuredClone(input.promptInput) } : {}),
    };
}

function referenceItem(reference: CanvasStoredImageReference): ImageReferenceItem & { sourceNodeId?: string } {
    return { id: reference.id, referenceKey: reference.referenceKey, name: reference.name, originalFileName: reference.originalFileName,
        imageName: reference.imageName, imageVersion: reference.imageVersion, type: reference.type, dataUrl: reference.content,
        storageKey: reference.storageKey, sourceNodeId: reference.sourceNodeId, origin: reference.origin, originLabel: "原生成参考" };
}

export function canvasGenerationRecordReferences(record: CanvasGenerationRecord): ImageReferenceItem[] {
    return record.references.map(referenceItem);
}

/** Visibility follows the live graph; the immutable archive keeps deleted inputs for replay. */
export function visibleCanvasGenerationReferences(record: CanvasGenerationRecord, nodes: CanvasNodeData[]) {
    const present = new Set(nodes.map(node => node.id));
    return record.references.filter(reference => !reference.sourceNodeId || present.has(reference.sourceNodeId));
}

function legacyCanvasGenerationReferences(node: CanvasNodeData): { references: ImageReferenceItem[]; incomplete: boolean } {
    const metadata = node.metadata;
    if (!metadata?.generationType && !metadata?.sourceTaskId) return { references: [], incomplete: false };
    const saved = metadata.references;
    const comparisons = metadata.compareSources;
    // Only the archived values are trustworthy. Live connections, node ids and file
    // timestamps cannot establish which source was used by an older generation.
    const values = Array.isArray(saved) && (saved.length || !comparisons?.length) ? saved : Array.isArray(comparisons) ? comparisons.map(source => source.storageKey || source.content) : undefined;
    if (!values || (metadata.generationType === "edit" && !values.length)) return { references: [], incomplete: true };
    const references = values.map((value, index): ImageReferenceItem | undefined => {
        if (typeof value !== "string") return;
        const matched = comparisons?.find(source => value && (source.storageKey === value || source.content === value));
        const compared = matched
            || (comparisons?.length === values.length ? comparisons[index] : undefined);
        // An unrelated compare thumbnail must never replace an authoritative URL.
        const storageKey = value.startsWith("image:") ? value : !value || matched ? compared?.storageKey : undefined;
        const content = value && !value.startsWith("image:") ? value : compared?.content || "";
        if (!storageKey && !content) return;
        const id = `legacy:${node.id}:${index}`;
        return { id, referenceKey: id, name: compared?.label || `原生成参考 ${index + 1}`, type: "image/png", dataUrl: content,
            storageKey, origin: "upload", originLabel: "旧版生成参考" };
    });
    if (references.some(reference => !reference)) return { references: [], incomplete: true };
    return { references: references as ImageReferenceItem[], incomplete: false };
}

/** An explicit empty reference list is a complete text-to-image record, not lost data. */
export function hasIncompleteCanvasGenerationReferences(node: CanvasNodeData): boolean {
    return !node.metadata?.generationRecord && legacyCanvasGenerationReferences(node).incomplete;
}

export function canvasNodeGenerationReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], options: { visibleOnly?: boolean } = {}): ImageReferenceItem[] {
    const record = node.metadata?.generationRecord;
    if (!record && node.metadata?.draftImageReferences === undefined) {
        if (node.metadata?.generationType || node.metadata?.sourceTaskId) return legacyCanvasGenerationReferences(node).references;
        return resolveCanvasNodeImageReferences(node, nodes, connections);
    }
    const references = node.metadata?.draftImageReferences ?? record!.references;
    const present = options.visibleOnly ? new Set(nodes.map(item => item.id)) : undefined;
    return references.filter(reference => !present || !reference.sourceNodeId || present.has(reference.sourceNodeId)).map(referenceItem);
}

export function canvasGenerationRecordConfig(record: CanvasGenerationRecord, config: AiConfig): AiConfig {
    const { generationType: _type, count: _count, ...parameters } = record.parameters;
    return { ...config, ...parameters, imageModel: parameters.model, count: "1", canvasImageCount: "1" };
}

export function canvasGenerationPrompt(node: CanvasNodeData) { return node.metadata?.generationRecord?.prompt ?? node.metadata?.prompt ?? ""; }
export function canvasGenerationDraft(node: CanvasNodeData) { return node.metadata?.draftPrompt ?? node.metadata?.generationRecord?.inputPrompt ?? node.metadata?.prompt ?? ""; }
export function canvasGenerationDraftResetPatch(node: CanvasNodeData): Partial<CanvasNodeMetadata> {
    const record = node.metadata?.generationRecord;
    return { draftPrompt: record?.inputPrompt ?? node.metadata?.prompt ?? "", draftImageReferences: undefined,
        ...(record ? { model: record.parameters.model, size: record.parameters.size, quality: record.parameters.quality, imageOptions: record.parameters.imageOptions, systemPrompt: record.parameters.systemPrompt } : {}) };
}

/** Server compilation is part of this run, not a later edit to the saved draft. */
export function compiledCanvasGenerationRecord(record: CanvasGenerationRecord | undefined, prompt: string | undefined) {
    return record && prompt !== undefined && record.prompt !== prompt ? { ...record, prompt } : record;
}
