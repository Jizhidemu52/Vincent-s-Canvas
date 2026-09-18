import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup, type Position } from "@/types/canvas";

export const canvasDesignTemplates = [
    { id: "development", title: "整套款式开发", output: "参考款 → 技术线稿 / 改色方案 / 上身效果图", steps: [
        ["技术线稿", "基于参考服装绘制正面与背面技术平面线稿，白底黑线，保留廓形、分割线、口袋、领型与缝线，不添加尺寸或文字，不改变结构。"],
        ["改色方案", "保留参考服装的版型、结构、材质和所有细节，仅将主体改为海军蓝，辅料保持协调颜色，输出清晰白底服装正面效果图。"],
        ["上身效果图", "基于参考服装制作真实成人模特上身效果图，完整展现服装版型与细节，正面全身，柔和摄影棚灯光和简洁背景。"],
    ] },
    { id: "print", title: "花型与工艺开发", output: "参考款 → 印花定位稿 / 绣花效果 / 成衣展示", steps: [
        ["印花定位稿", "保持参考服装版型，在胸前设计简洁原创植物印花，输出清晰正面平铺定位效果图，准确展现图案位置及相对大小。"],
        ["绣花效果", "保持参考服装版型和底色，在胸前设计小型原创植物绣花，展示真实针迹、绣线光泽和织物质感，不模拟印刷平面效果。"],
        ["成衣展示", "以参考服装为基础，设计胸前简洁原创植物装饰的成衣展示图，保留服装结构，展示真实面料与辅料细节，纯净背景。"],
    ] },
    { id: "range", title: "系列配色提案", output: "参考款 → 奶油白 / 海军蓝 / 鼠尾草绿 3 色效果图", steps: [
        ["奶油白配色", "仅将参考服装主体改为奶油白，保留版型、缝线、面料质感和原有图案，正面平铺，白底产品摄影。"],
        ["海军蓝配色", "仅将参考服装主体改为海军蓝，保留版型、缝线、面料质感和原有图案，正面平铺，白底产品摄影。"],
        ["鼠尾草绿配色", "仅将参考服装主体改为鼠尾草绿，保留版型、缝线、面料质感和原有图案，正面平铺，白底产品摄影。"],
    ] },
] as const;
export type CanvasDesignTemplateId = typeof canvasDesignTemplates[number]["id"];

/** Creates idle, executable config branches; never changes the reference or schedules generation. */
export function createCanvasDesignTemplate(templateId: CanvasDesignTemplateId, source: CanvasNodeData | undefined, position: Position, model?: string, makeId = nanoid) {
    const template = canvasDesignTemplates.find(item => item.id === templateId)!;
    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    const reference = source || { ...NODE_DEFAULT_SIZE[CanvasNodeType.Image], id: makeId(), type: CanvasNodeType.Image, title: "参考款 · 请上传图片", position, metadata: { status: "idle" as const } };
    if (!source) nodes.push(reference);
    const startX = position.x + (source ? 0 : reference.width + 96);
    template.steps.forEach(([title, prompt], index) => {
        const id = makeId();
        nodes.push({ ...NODE_DEFAULT_SIZE[CanvasNodeType.Config], id, type: CanvasNodeType.Config, title, position: { x: startX, y: position.y + index * (NODE_DEFAULT_SIZE[CanvasNodeType.Config].height + 80) }, metadata: { status: "idle", generationMode: "image", generationType: "edit", model, count: 1, prompt, composerContent: `参考款：@[node:${reference.id}]\n${prompt}` } });
        connections.push({ id: makeId(), fromNodeId: reference.id, toNodeId: id });
    });
    const group: CanvasNodeGroup = { id: `group-${makeId()}`, title: template.title, nodeIds: nodes.map(node => node.id), collapsed: false };
    return { nodes, connections, group };
}
