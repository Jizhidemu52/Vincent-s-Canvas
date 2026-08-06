import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { CanvasNodeType, type CanvasAgentMediaWorkflow, type CanvasNodeData } from "@/types/canvas";

export function buildAgentMediaWorkflowStageOps(workflow: CanvasAgentMediaWorkflow, stage: "image" | "video", nodes: CanvasNodeData[], selectedReferenceNodeId?: string) {
    const textId = `workflow-${stage}-prompt-${nanoid()}`;
    const configId = `workflow-${stage}-config-${nanoid()}`;
    const x = nodes.length ? Math.max(...nodes.map((node) => node.position.x + node.width)) + 80 : 0;
    const textSize = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
    const configSize = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
    const model = stage === "image" ? workflow.imageModel : workflow.videoModel;
    const referenceNodeIds =
        stage === "image"
            ? workflow.referenceNodeIds.filter((nodeId) => nodes.some((node) => node.id === nodeId && node.type === CanvasNodeType.Image && Boolean(node.metadata?.content)))
            : selectedReferenceNodeId
              ? [selectedReferenceNodeId]
              : [];
    const ops: CanvasAgentOp[] = [
        {
            type: "add_node",
            id: textId,
            nodeType: CanvasNodeType.Text,
            title: stage === "image" ? "工作流图片提示词" : "工作流视频提示词",
            position: { x, y: 0 },
            width: textSize.width,
            height: textSize.height,
            metadata: { content: workflow.prompt, prompt: workflow.prompt, status: "success", fontSize: 14 },
        },
        {
            type: "add_node",
            id: configId,
            nodeType: CanvasNodeType.Config,
            title: stage === "image" ? "工作流图片生成" : "工作流视频生成",
            position: { x: x + textSize.width + 80, y: 0 },
            width: configSize.width,
            height: configSize.height,
            metadata: {
                generationMode: stage,
                prompt: workflow.prompt,
                model,
                status: "idle",
                size: workflow.aspectRatio,
                ...(stage === "image" ? { count: workflow.imageCount } : { seconds: workflow.videoSeconds }),
            },
        },
        { type: "connect_nodes", fromNodeId: textId, toNodeId: configId },
        ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: configId })),
        { type: "select_nodes", ids: [configId] },
    ];
    return { textId, configId, ops };
}
