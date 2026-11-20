import { availableModels } from "./task-model.mjs";

export const DESIGN_MODELS = [
    { publicName: "aplmart-nano2.1", label: "Nano 2.1" },
    { publicName: "aplmart-gpt2.6-flare", label: "GPT 2.6 Flare" },
    { publicName: "aplmart-gpt2.6-sunburst", label: "GPT 2.6 Sunburst" },
    { publicName: "aplmart-mai2.7-flash", label: "MAI 2.7 Flash" },
    { publicName: "豆包生图", label: "豆包生图" },
];

export function designModels(catalog, referenceCount) {
    const available = availableModels(catalog, referenceCount);
    return DESIGN_MODELS.flatMap(preset => {
        const model = available.find(item => (item.publicName || item.name) === preset.publicName);
        return model ? [{ ...model, label: preset.label }] : [];
    });
}

export function designVideoModels(catalog) {
    const tool = catalog?.tools?.find(item => item.toolKey === "canvas-video");
    if (!tool?.enabled) return [];
    return (catalog.models || []).filter(model => model.capabilities?.includes("video")
        && (!tool.modelConfigId || tool.modelConfigId === model.id)).map(model => ({ ...model, label: model.name }));
}

export const DESIGN_PRESETS = [
    { id: "brand", title: "品牌系列开发", description: "结合品牌客群与参考图，提出同调性但有差异的款式。", instructions: "先从用户资料与可见参考提炼共同的廓形、色彩、材质或工艺语言，再在允许变化的维度提出差异；不以同一图案复制粘贴代替系列设计。品牌未知或资料不足时按当前参考开发并说明依据，不猜造品牌定位。每个方案独立写全共同锁定项与本方案变化。" },
    { id: "refine", title: "沿原图深化", description: "保住明确不变的部分，重点探索图案、色彩或局部细节。", instructions: "以用户明确指定的主图和修改范围为边界；逐项说明修改部位、目标状态和必要的材质或光影联动，保持其余有效锁定项。各方案只探索被允许变化的部分，不默认颜色、版型、图案都可改，不为凑方案数擅自扩大范围。" },
    { id: "trend", title: "趋势方向探索", description: "结合有出处的季节资料，把趋势转为适合本次产品的设计。", instructions: "只把来源目录中有内容支撑且适用于本次季节、客群的资料转为具体颜色、肌理、结构或图案方向，说明产品适配与来源边界。没有合适资料时给一般设计方向并明确未核实趋势，不虚构当季流行、销量或已读网页，不把资料文字印进图片。" },
    { id: "pattern", title: "花型与配色变奏", description: "围绕上传图案探索构图、元素和色组，不擅自变成产品场景。", instructions: "保持用户指定的平面花型或产品载体，按允许范围调整元素、构图、密度与配色；区分保留密度和锁定原落位。每张参考只贡献用户指定维度，提取任务保留全部可见元素且不补造画外内容；未要求时不添加床品、模特、服装或室内场景。" },
];
