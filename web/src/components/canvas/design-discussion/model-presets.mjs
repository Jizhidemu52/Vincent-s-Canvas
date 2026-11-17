import { availableModels } from "./task-model.mjs";

export const DESIGN_MODELS = [
    { publicName: "aplmart-nano2.1", label: "Nano 2.1" },
    { publicName: "aplmart-gpt2.6-flare", label: "GPT 2.6 Flare" },
    { publicName: "aplmart-gpt2.6-sunburst", label: "GPT 2.6 Sunburst" },
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
    { id: "brand", title: "品牌系列开发", description: "结合品牌客群与参考图，提出同调性但有差异的款式。" },
    { id: "refine", title: "沿原图深化", description: "保住明确不变的部分，重点探索图案、色彩或局部细节。" },
    { id: "trend", title: "趋势方向探索", description: "结合有出处的季节资料，把趋势转为适合本次产品的设计。" },
    { id: "pattern", title: "花型与配色变奏", description: "围绕上传图案探索构图、元素和色组，不擅自变成产品场景。" },
];
