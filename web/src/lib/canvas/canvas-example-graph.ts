import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function createCanvasExampleProject() {
    const { createProject, updateProject } = useCanvasStore.getState();
    const id = createProject("新手示例 · 参考图改色工作流");
    updateProject(id, { ...createCanvasExampleGraph(), viewport: { x: 72, y: 112, k: .65 } });
    return id;
}

/** A local editable teaching canvas. No task IDs, remote requests or generated results. */
export function createCanvasExampleGraph(makeId = nanoid) {
    const sourceId = makeId(), configId = makeId();
    const prompt = "保留服装版型、领口和图案位置，仅将主体改为海军蓝，白色背景。";
    const nodes: CanvasNodeData[] = [
        { id: sourceId, type: CanvasNodeType.Image, title: "示例参考图 · 可替换", position: { x: 0, y: 40 }, width: 320, height: 320, metadata: { content: "/design-workbench/assets/garment.png", naturalWidth: 1024, naturalHeight: 1024, mimeType: "image/png", status: "idle" } },
        { id: configId, type: CanvasNodeType.Config, title: "改色配置 · 点击生成才调用模型", position: { x: 420, y: 0 }, width: 400, height: 480, metadata: { status: "idle", generationMode: "image", generationType: "edit", configImageInputMode: "combined", count: 1, prompt, composerContent: `参考款：@[node:${sourceId}]\n${prompt}` } },
        { id: makeId(), type: CanvasNodeType.Text, title: "示例说明", position: { x: 0, y: 440 }, width: 320, height: 210, metadata: { status: "idle", content: "这是内置静态素材示例，未调用模型。\n1. 可上传自己的参考图替换左上图片。\n2. 编辑右侧配置提示词，确认后再点击生成。\n3. 结果出现后，选择原图与结果，用设计工具对比。" } },
        { id: makeId(), type: CanvasNodeType.Text, title: "多图执行与 @ 引用", position: { x: 920, y: 40 }, width: 340, height: 260, metadata: { status: "idle", content: "逐图执行：每张任务图分别执行同一要求，每次主图为图片1。\n合并参考：多张参考图共同参与一次生成。\n先将素材连到配置，再在提示词输入 @ 选择素材；明确哪张控制款式、哪张控制配色。\n连接不代表立即生成；请确认后再执行。" } },
    ];
    const connections: CanvasConnection[] = [{ id: makeId(), fromNodeId: sourceId, toNodeId: configId }];
    return { nodes, connections };
}
