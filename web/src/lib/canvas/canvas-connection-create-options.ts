import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData, type ConnectionHandle } from "@/types/canvas";

export type ConnectionCreateNodeType = CanvasNodeType.Text | CanvasNodeType.Image | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Config;
export type CanvasConnectionCreateOption = { type: ConnectionCreateNodeType; title: string; relationship: string; configMode?: CanvasGenerationMode };
const types = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio] as const;
const names = { text: "文本", image: "图片", video: "视频", audio: "音频" };

/** Mirrors supported generation inputs, not the graph's more permissive visual edges. */
function accepts(mode: CanvasGenerationMode, input: CanvasNodeType) {
    return mode === "video" || ((mode === "image" || mode === "text") && (input === CanvasNodeType.Text || input === CanvasNodeType.Image))
        || (mode === "audio" && input === CanvasNodeType.Text);
}

export function canvasConnectionCreateOptions(node: Pick<CanvasNodeData, "type" | "metadata"> | undefined, handleType: ConnectionHandle["handleType"]): CanvasConnectionCreateOption[] {
    if (!node || ![...types, CanvasNodeType.Config].includes(node.type as ConnectionCreateNodeType)) return [];
    const mode = node.type === CanvasNodeType.Config ? node.metadata?.generationMode || "image" : node.type as CanvasGenerationMode;
    if (handleType === "target") {
        const inputs: CanvasConnectionCreateOption[] = types.filter(type => accepts(mode, type)).map(type => ({ type, title: `添加${names[type]}输入`, relationship: `${names[type]}素材 → 当前${node.type === CanvasNodeType.Config ? "配置" : names[mode]}节点` }));
        if (node.type === CanvasNodeType.Config) {
            if (mode !== "audio") inputs.push({ type: CanvasNodeType.Config, title: "上游生图步骤", relationship: "上游生成结果 → 当前工作流步骤", configMode: "image" });
            return inputs;
        }
        return [...inputs, { type: CanvasNodeType.Config, title: "共享生成配置", relationship: `新配置 → 当前${names[mode]}任务`, configMode: mode }];
    }
    if (node.type === CanvasNodeType.Config) {
        const options: CanvasConnectionCreateOption[] = types.filter(type => type === mode || accepts(mode, type)).map(type => ({ type, title: `${names[type]}任务`, relationship: `使用当前${names[mode]}配置，不自动生成` }));
        if (mode === "image") options.push({ type: CanvasNodeType.Config, title: "下一步生成配置", relationship: "当前生成结果 → 下一步工作流", configMode: "image" });
        return options;
    }
    const options: CanvasConnectionCreateOption[] = types.filter(type => accepts(type, node.type)).map(type => ({
        type, title: `${names[type]}生成`,
        relationship: node.type === CanvasNodeType.Text ? (type === CanvasNodeType.Audio ? "当前文字 → 朗读内容" : "当前文字 → 提示词输入")
            : node.type === CanvasNodeType.Image ? (type === CanvasNodeType.Text ? "当前图片 → 看图描述" : type === CanvasNodeType.Video ? "当前图片 → 首帧或参考图" : "当前图片 → 参考图或编辑输入")
                : `当前${names[node.type as keyof typeof names]} → 视频参考素材`,
    }));
    const configMode = node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio ? "video" : "image";
    options.push({ type: CanvasNodeType.Config, title: configMode === "video" ? "视频生成配置" : "生成配置", relationship: `当前${names[node.type as keyof typeof names]} → 配置的${node.type === CanvasNodeType.Text ? "提示词输入" : "参考素材"}`, configMode });
    return options;
}

export function canvasConnectionMenuPosition(anchor: { x: number; y: number }, height: number, viewport: { width: number; height: number }) {
    const margin = 8, width = Math.min(300, Math.max(0, viewport.width - margin * 2));
    const maxHeight = Math.max(0, viewport.height - margin * 2), fittedHeight = Math.min(height, maxHeight);
    return { left: Math.max(margin, Math.min(anchor.x, viewport.width - width - margin)), top: Math.max(margin, Math.min(anchor.y, viewport.height - fittedHeight - margin)), width, maxHeight };
}
