import { generationInputForNode, type NodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { createImageReferenceItem } from "@/lib/image-reference-policy";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { ImageReferenceItem, ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { resolveCanvasImageReferences } from "./canvas-image-references";

type CanvasSnapshot = { nodes: CanvasNodeData[]; connections: CanvasConnection[] };
export type SharedGenerationPlan = {
    configNode: CanvasNodeData;
    targetNode: CanvasNodeData;
    mode: CanvasGenerationMode;
    prompt: string;
    context: NodeGenerationContext;
};

export { getSharedConfigForTarget, getSharedConfigTargets, normalizeCanvasConnection } from "./canvas-shared-connections";
import { getSharedConfigForTarget } from "./canvas-shared-connections";

/** Build one immutable task, never walking target siblings or recursively executing an upstream node. */
export function resolveSharedGenerationPlan(targetId: string, configId: string, { nodes, connections }: CanvasSnapshot): SharedGenerationPlan {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const configNode = byId.get(configId);
    const targetNode = byId.get(targetId);
    if (configNode?.type !== CanvasNodeType.Config) throw new Error("共享配置节点不存在。");
    if (!targetNode || targetNode.type === CanvasNodeType.Config) throw new Error("共享配置的任务目标不可用。");
    if (getSharedConfigForTarget(targetId, nodes, connections)?.id !== configId) throw new Error("任务目标没有连接到此共享配置。");
    const mode = configNode.metadata?.generationMode || "image";
    if (!["image", "text", "video", "audio"].includes(mode)) throw new Error("共享配置的生成模式不可用。");

    const targetInput = resourceInput(targetNode);
    if (targetInput || targetNode.type !== mode) validateInputType(mode, targetNode.type);
    const commonNodes = [...new Set(connections.filter(edge => edge.toNodeId === configId).map(edge => edge.fromNodeId))]
        .flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const commonInputs = commonNodes.flatMap(node => {
        if (node.type === CanvasNodeType.Config) throw new Error("共享配置不能使用另一个配置节点作为公共素材。");
        const input = resourceInput(node);
        return input ? [input] : [];
    });
    const inputs = [...(targetInput ? [targetInput] : []), ...commonInputs.filter(input => input.nodeId !== targetId)];
    inputs.filter(input => input.type !== "image").forEach(input => validateInputType(mode, input.type));

    const publicImages = resolveCanvasImageReferences(configNode, nodes, connections);
    if (publicImages.length) validateInputType(mode, "image");
    const targetImage = targetInput?.image ? { ...createImageReferenceItem(targetInput.image, "canvas"), referenceKey: `source:${targetId}` } : undefined;
    const referenceImages: ImageReferenceItem[] = [];
    for (const image of [...(targetImage ? [targetImage] : []), ...publicImages]) {
        if (!referenceImages.some(existing => sameImage(existing, image))) referenceImages.push(image);
    }
    const referenceVideos = inputs.flatMap(input => input.video ? [input.video] : []);
    const referenceAudios = inputs.flatMap(input => input.audio ? [input.audio] : []);
    const textInputs = inputs.filter(input => input.type === "text");
    const labels = new Map<string, string>();
    const addLabel = (id: string | undefined, label: string) => {
        if (!id) return;
        const previous = labels.get(id);
        if (previous && previous !== label) throw new Error(`素材引用 ${id} 存在歧义，请重新选择引用。`);
        labels.set(id, label);
    };
    const labelImage = (image: ReferenceImage, aliases: Array<string | undefined>) => {
        const index = referenceImages.findIndex(existing => sameImage(existing, image));
        if (index >= 0) aliases.forEach(alias => addLabel(alias, imageReferenceLabel(index)));
    };
    [...(targetImage ? [targetImage] : []), ...publicImages].forEach(image => labelImage(image, [image.id, image.referenceKey]));
    // Preserve aliases discarded by the existing reference-tray dedupe, including a manual copy of the target.
    (configNode.metadata?.manualImageReferences || []).forEach(image => labelImage({ id: image.id, name: image.name, type: image.type, dataUrl: image.content, storageKey: image.storageKey }, [image.id, image.referenceKey, image.sourceNodeId]));
    const excluded = new Set(configNode.metadata?.excludedConnectedImageReferenceKeys || []);
    commonInputs.forEach(input => {
        if (input.image && !excluded.has(`node:${input.nodeId}`)) labelImage(input.image, [input.nodeId, `node:${input.nodeId}`]);
    });
    referenceVideos.forEach((video, index) => addLabel(video.id, seedanceReferenceLabel("video", index)));
    referenceAudios.forEach((audio, index) => addLabel(audio.id, seedanceReferenceLabel("audio", index)));
    textInputs.forEach((input, index) => addLabel(input.nodeId, `【文本${index + 1}】`));
    const sourcePrompt = configNode.metadata?.composerContent || configNode.metadata?.prompt || "";
    let prompt = sourcePrompt.replace(/@\[node:([^\]]+)\]/g, (_token, id: string) => {
        const label = labels.get(id);
        if (!label) throw new Error(`提示词引用的素材 ${id} 不存在、为空或已被排除，请重新选择引用。`);
        return label;
    }).trim();
    const textBlocks = textInputs.map((input, index) => `【文本${index + 1}】\n${input.text || ""}`);
    if (textBlocks.length) prompt = [prompt, ...textBlocks].filter(Boolean).join("\n\n");
    const context: NodeGenerationContext = {
        prompt, referenceImages, referenceVideos, referenceAudios,
        textCount: textInputs.length, imageCount: referenceImages.length, videoCount: referenceVideos.length, audioCount: referenceAudios.length,
    };
    return freezeSnapshot(structuredClone({ configNode, targetNode, mode, prompt, context }));
}

function resourceInput(node: CanvasNodeData): NodeGenerationInput | null {
    // Empty media placeholders may carry a draft prompt, but are not text inputs.
    if (node.type !== CanvasNodeType.Text && !node.metadata?.content && !node.metadata?.storageKey) return null;
    const input = generationInputForNode(node);
    return input?.type === "text" && !input.text?.trim() ? null : input;
}

function validateInputType(mode: CanvasGenerationMode, type: string) {
    if (mode === "video" || ((mode === "image" || mode === "text") && (type === "text" || type === "image")) || (mode === "audio" && type === "text")) return;
    throw new Error(mode === "audio" ? "音频配置当前仅支持文字转语音，请使用文本任务和公共文本。" : "当前配置仅支持文本和图片素材，不能使用视频或音频。");
}

function sameImage(first: ReferenceImage, second: ReferenceImage) {
    return first.id === second.id || Boolean(first.storageKey && first.storageKey === second.storageKey)
        || Boolean(first.dataUrl && first.dataUrl === second.dataUrl) || Boolean(first.url && first.url === second.url);
}

function freezeSnapshot<T>(value: T): T {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freezeSnapshot);
        Object.freeze(value);
    }
    return value;
}
