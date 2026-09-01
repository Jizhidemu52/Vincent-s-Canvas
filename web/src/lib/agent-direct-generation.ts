import { CanvasNodeType, type CanvasAssistantAttachment } from "@/types/canvas";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

export type AgentGenerationMode = "image" | "video";
export type AgentImageAfterAction = "images_only" | "select_then_video" | "auto_first_image_video";

export type AgentGenerationSettings = {
    mode: AgentGenerationMode;
    imageModel: string;
    videoModel: string;
    size: string;
    quality: string;
    imageCount: string;
    videoSeconds: string;
    videoQuality: string;
    afterImage: AgentImageAfterAction;
};

export type AgentVideoCapability = {
    seconds: readonly [number, number];
    resolutions: readonly string[];
    sizes: readonly string[];
};

export type AgentVideoConfirmation = {
    selectedImage: CanvasAssistantAttachment;
    prompt: string;
    settings: AgentGenerationSettings;
};

type ReferenceLike = { id: string };

export function createAgentVideoConfirmation(
    image: CanvasAssistantAttachment,
    settings: AgentGenerationSettings,
    originalPrompt: string,
): AgentVideoConfirmation {
    return {
        selectedImage: image,
        prompt: buildAgentVideoPrompt(originalPrompt, true),
        settings: { ...settings, mode: "video" },
    };
}

export function normalizeAgentVideoSettings(
    settings: AgentGenerationSettings,
    capability: AgentVideoCapability,
): AgentGenerationSettings {
    const sizes = capability.sizes.map((size) => size === "adaptive" ? "auto" : size);
    const requestedSeconds = Number(settings.videoSeconds);
    const seconds = Number.isFinite(requestedSeconds)
        ? Math.min(capability.seconds[1], Math.max(capability.seconds[0], Math.floor(requestedSeconds)))
        : capability.seconds[0];
    return {
        ...settings,
        videoSeconds: String(seconds),
        videoQuality: capability.resolutions.includes(settings.videoQuality)
            ? settings.videoQuality
            : capability.resolutions.at(-1) || "720P",
        size: sizes.includes(settings.size)
            ? settings.size
            : sizes[0] || "16:9",
    };
}

export function buildAgentGeneratedMediaOps(
    attachments: CanvasAssistantAttachment[],
    context: { prompt: string; model: string; x: number; y: number },
): CanvasAgentOp[] {
    const mediaOps = attachments.map((attachment, index): CanvasAgentOp => ({
        type: "add_node",
        id: attachment.id,
        nodeType: attachment.mediaType === "video" ? CanvasNodeType.Video : CanvasNodeType.Image,
        title: attachment.name,
        position: { x: context.x + index * 380, y: context.y },
        metadata: {
            content: attachment.url,
            prompt: context.prompt,
            model: context.model,
            status: "success",
            mimeType: mediaMimeType(attachment),
        },
    }));
    return mediaOps.length ? [...mediaOps, { type: "select_nodes", ids: attachments.map((attachment) => attachment.id) }] : [];
}

export function resolveAgentGeneratedMediaPosition(snapshot: CanvasAgentSnapshot) {
    const selectedNodes = snapshot.nodes.filter((node) => snapshot.selectedNodeIds.includes(node.id));
    const anchors = selectedNodes.length ? selectedNodes : snapshot.nodes;
    if (!anchors.length) return { x: -snapshot.viewport.x / snapshot.viewport.k + 80, y: -snapshot.viewport.y / snapshot.viewport.k + 80 };
    const anchor = anchors.reduce((rightmost, node) => (node.position.x + node.width > rightmost.position.x + rightmost.width ? node : rightmost));
    return { x: anchor.position.x + anchor.width + 80, y: anchor.position.y };
}

export async function buildAgentReferenceImageContent<T>(
    references: T[],
    toDataUrl: (reference: T) => Promise<string>,
) {
    return Promise.all(
        references.map(async (reference) => ({
            type: "image_url" as const,
            image_url: { url: await toDataUrl(reference) },
        })),
    );
}

export function selectAgentVideoReferences<T extends ReferenceLike>(model: string, references: T[]) {
    return model === "MiniMax-H3" ? references.slice(0, 1) : references;
}

export type AgentImageGenerationPlan = {
    kind: "image";
    model: string;
    size: string;
    quality: string;
    count: number;
    afterImage: AgentImageAfterAction;
};

export type AgentVideoGenerationPlan = {
    kind: "video";
    model: string;
    size: string;
    seconds: string;
    quality: string;
    requiresReference: boolean;
};

export function buildAgentGenerationPlan(settings: AgentGenerationSettings, prompt: string, references: ReferenceLike[]): AgentImageGenerationPlan | AgentVideoGenerationPlan {
    if (!prompt.trim()) throw new Error("请输入生成需求");
    if (settings.mode === "image") {
        return {
            kind: "image",
            model: settings.imageModel,
            size: settings.size,
            quality: settings.quality,
            count: clampImageCount(settings.imageCount),
            afterImage: settings.afterImage,
        };
    }
    return {
        kind: "video",
        model: settings.videoModel,
        size: settings.size,
        seconds: settings.videoSeconds,
        quality: settings.videoQuality,
        requiresReference: references.length > 0,
    };
}

export function buildAgentVideoPrompt(prompt: string, hasReference: boolean) {
    const request = prompt.trim();
    if (!hasReference) return request;
    return `以所选参考图为唯一主体与视觉依据，保持人物、服装、材质、花型、颜色和构图一致。${request}。镜头运动自然稳定，动作连贯真实，避免改变参考图中的服装设计、Logo、纹理和主体身份。`;
}

export function agentQuickstartPreset(kind: "video" | "lookbook" | "illustration" | "poster") {
    if (kind === "video") return { mode: "video" as const, prompt: "根据参考图生成自然连贯的短视频，保持主体和服装设计一致。" };
    if (kind === "lookbook") return { mode: "image" as const, prompt: "生成高级感服装实穿图，保持服装版型、材质和花型清晰真实。" };
    if (kind === "illustration") return { mode: "image" as const, prompt: "生成具有鲜明视觉风格的插画，主体突出，构图完整。" };
    return { mode: "image" as const, prompt: "生成商业海报主视觉，主题明确，构图有层次，保留充足文字排版空间。" };
}

export function buildAgentGenerationBrief(settings: AgentGenerationSettings, prompt: string, hasReference: boolean) {
    const preset = settings.mode === "image"
        ? `图片模型：${settings.imageModel}；数量：${clampImageCount(settings.imageCount)}；质量：${settings.quality}；尺寸：${settings.size}`
        : `视频模型：${settings.videoModel}；时长：${settings.videoSeconds} 秒；清晰度：${settings.videoQuality}；画幅：${settings.size}`;
    return `任务类型：${settings.mode === "image" ? "图片生成" : "视频生成"}\n${preset}\n已有参考图：${hasReference ? "是" : "否"}\n用户需求：${prompt.trim()}`;
}

function clampImageCount(value: string) {
    const count = Number.parseInt(value, 10);
    return Number.isFinite(count) ? Math.min(4, Math.max(1, count)) : 1;
}

function mediaMimeType(attachment: CanvasAssistantAttachment) {
    if (attachment.mediaType === "video") return "video/mp4";
    const match = /^data:([^;,]+)[;,]/i.exec(attachment.url);
    return match?.[1] || "image/png";
}
