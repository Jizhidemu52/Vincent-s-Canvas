import type { GarmentScenario } from "@/lib/garment-recipe";

export const CREATIVE_REQUIREMENT_PLACEHOLDER = "【填写设计要求】";

export const creativePresetGroups = [
    { id: "new", title: "新款设计" },
    { id: "restyle", title: "改款设计" },
    { id: "pattern", title: "图案设计" },
] as const;

export type CreativePreset = {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly group: (typeof creativePresetGroups)[number]["id"];
    readonly tool: "image-generation" | "image-edit";
    readonly prompt?: string;
    readonly garment?: GarmentScenario;
};

/** Local starting points only: opening a preset never submits a generation task. */
export const creativePresets: readonly CreativePreset[] = [
    {
        id: "text-to-style",
        title: "以文生款",
        description: "写下款式想法，探索服装设计效果。",
        group: "new",
        tool: "image-generation",
        prompt: CREATIVE_REQUIREMENT_PLACEHOLDER,
    },
    {
        id: "style-to-sketch",
        title: "款生线稿",
        description: "参考服装图片，整理可见结构线条。",
        group: "new",
        tool: "image-edit",
        prompt: "技术感线稿",
    },
    {
        id: "local-restyle",
        title: "局部改款",
        description: "指定要改的部位，保留其余设计。",
        group: "restyle",
        tool: "image-edit",
        garment: "restyle",
    },
    {
        id: "garment-colorway",
        title: "服装配色",
        description: "保留服装结构，尝试新的配色。",
        group: "restyle",
        tool: "image-edit",
        garment: "colorway",
    },
    {
        id: "back-design",
        title: "背面设计",
        description: "依据正面风格，构思背面设计方案。",
        group: "restyle",
        tool: "image-edit",
        prompt: "简洁背面",
    },
    {
        id: "pattern-extract",
        title: "花型提取",
        description: "从参考图中整理可见的图案元素。",
        group: "pattern",
        tool: "image-edit",
        prompt: "单独图案，白底",
    },
    {
        id: "pattern-colorway",
        title: "图案配色",
        description: "保留图案形状，探索不同色彩组合。",
        group: "pattern",
        tool: "image-edit",
        prompt: CREATIVE_REQUIREMENT_PLACEHOLDER,
    },
    {
        id: "accessory-design",
        title: "辅料设计",
        description: "上传辅料与图案，定制纹样和外形。",
        group: "pattern",
        tool: "image-edit",
        prompt: "形状与纹样",
    },
    {
        id: "pattern-craft",
        title: "图案工艺",
        description: "模拟刺绣、提花等图案工艺质感。",
        group: "pattern",
        tool: "image-edit",
        prompt: CREATIVE_REQUIREMENT_PLACEHOLDER,
    },
];

export function getCreativePreset(id: string | null): CreativePreset | undefined {
    return creativePresets.find((preset) => preset.id === id);
}

export function buildCreativePresetHref(preset: CreativePreset): string {
    return `/creative/${preset.id}`;
}
