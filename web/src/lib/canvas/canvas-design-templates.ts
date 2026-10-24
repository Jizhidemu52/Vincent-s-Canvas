import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup, type Position } from "@/types/canvas";

export const canvasDesignTemplates = [
    { id: "development", title: "整套款式开发", output: "参考款 → 技术线稿 / 改色方案 / 上身效果图", steps: [
        ["技术线稿", "正面与背面技术线稿"], ["改色方案", "服装主体海军蓝，白底正面"], ["上身效果图", "成人模特，正面全身，摄影棚"],
    ] },
    { id: "print", title: "花型与工艺开发", output: "参考款 → 印花定位稿 / 绣花效果 / 成衣展示", steps: [
        ["印花定位稿", "胸前简洁原创植物印花"], ["绣花效果", "胸前小型原创植物绣花"], ["成衣展示", "胸前简洁原创植物装饰，纯净背景"],
    ] },
    { id: "range", title: "系列配色提案", output: "参考款 → 奶油白 / 海军蓝 / 鼠尾草绿 3 色效果图", steps: [
        ["奶油白配色", "奶油白，正面平铺，白底"], ["海军蓝配色", "海军蓝，正面平铺，白底"], ["鼠尾草绿配色", "鼠尾草绿，正面平铺，白底"],
    ] },
] as const;
const templateScenes = {
    development: ["style-to-sketch", "garment-colorway", "garment-presentation"],
    print: ["print-placement", "pattern-craft", "garment-presentation"],
    range: ["garment-colorway", "garment-colorway", "garment-colorway"],
} as const;
export type CanvasDesignTemplateId = typeof canvasDesignTemplates[number]["id"];
export type CanvasDesignTemplateSteps = readonly (readonly [title: string, prompt: string])[];

/** Creates idle, executable config branches; never changes the reference or schedules generation. */
export function createCanvasDesignTemplate(templateId: CanvasDesignTemplateId, source: CanvasNodeData | undefined, position: Position, model?: string, makeId = nanoid, editedSteps?: CanvasDesignTemplateSteps, editedTitle?: string) {
    const template = canvasDesignTemplates.find(item => item.id === templateId)!;
    const steps = editedSteps ?? template.steps;
    if (steps.length !== template.steps.length || steps.some(([title, prompt]) => !title.trim() || !prompt.trim())) throw new Error("请填写全部 3 个步骤的名称和提示词");
    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    const reference = source || { ...NODE_DEFAULT_SIZE[CanvasNodeType.Image], id: makeId(), type: CanvasNodeType.Image, title: "参考款 · 请上传图片", position, metadata: { status: "idle" as const } };
    if (!source) nodes.push(reference);
    const startX = position.x + (source ? 0 : reference.width + 96);
    steps.forEach(([title, prompt], index) => {
        const id = makeId();
        nodes.push({ ...NODE_DEFAULT_SIZE[CanvasNodeType.Config], id, type: CanvasNodeType.Config, title, position: { x: startX, y: position.y + index * (NODE_DEFAULT_SIZE[CanvasNodeType.Config].height + 80) }, metadata: { status: "idle", generationMode: "image", generationType: "edit", model, count: 1, promptInput: { scene: templateScenes[templateId][index]!, fields: { templateId, branchIndex: index, title, instruction: prompt, ...(templateId === "development" && index === 0 ? { views: ["front", "back"] } : {}) }, userText: prompt, referenceRoles: ["参考款"], mode: "edit" }, prompt, composerContent: `参考款：@[node:${reference.id}]\n${prompt}` } });
        connections.push({ id: makeId(), fromNodeId: reference.id, toNodeId: id });
    });
    const group: CanvasNodeGroup = { id: `group-${makeId()}`, title: editedTitle?.trim() || template.title, nodeIds: nodes.map(node => node.id), collapsed: false };
    return { nodes, connections, group };
}
