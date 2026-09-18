import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import type { restoreGenerationDraft } from "@/services/api/generation-history";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

export function createCanvasRestoredGenerationNode(draft: Awaited<ReturnType<typeof restoreGenerationDraft>>, position: Position): CanvasNodeData {
    // Config nodes have no mask channel. Never silently turn a masked edit into a full-image edit.
    if (draft.maskReferenceIndex !== undefined || draft.parameters.mask || draft.parameters.maskUrl || draft.parameters.maskDataUrl) throw new Error("此记录包含蒙版，画布生成配置不能完整还原蒙版；当前画布未改变");
    if (!["image_generation", "inpaint"].includes(draft.operationType) || (draft.tool && !["image-generation", "image-edit"].includes(draft.tool))) throw new Error("此记录使用专用工具，普通画布配置不能完整还原其操作；请在原工具中恢复，当前画布未改变");
    return { ...NODE_DEFAULT_SIZE[CanvasNodeType.Config], id: nanoid(), type: CanvasNodeType.Config, title: "已恢复的生成输入", position,
        metadata: { status: "idle", generationMode: "image", generationType: draft.references.length ? "edit" : "generation", model: draft.config.model, size: draft.config.size, quality: draft.config.quality, count: Number(draft.config.count) || 1, systemPrompt: draft.config.systemPrompt || "", prompt: draft.prompt, composerContent: draft.prompt,
            manualImageReferences: draft.references.map(reference => ({ id: reference.id, referenceKey: reference.id, name: reference.name, originalFileName: reference.originalFileName, imageName: reference.imageName, imageVersion: reference.imageVersion, type: reference.type, content: reference.dataUrl, origin: "upload" })), imageReferenceOrder: draft.references.map(reference => reference.id) } };
}
