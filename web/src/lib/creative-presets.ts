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
        prompt: [
            "任务：根据以下设计要求，创作一张服装概念效果图。",
            `设计要求（请填写服装品类、廓形、面料、配色与关键细节）：${CREATIVE_REQUIREMENT_PLACEHOLDER}`,
            "以清晰的单款服装为主体，让面料、比例与设计细节相互协调；不擅自添加品牌、水印或无关文字。",
            "输出仅为设计概念，不是纸样、工艺单或可直接生产的技术稿。",
        ].join("\n\n"),
    },
    {
        id: "style-to-sketch",
        title: "款生线稿",
        description: "参考服装图片，整理可见结构线条。",
        group: "new",
        tool: "image-edit",
        prompt: [
            "任务：将图片1中可见的服装整理为清晰的服装设计线稿，保持原有视角、廓形与比例。",
            "用简洁线条表达实际可见的领口、袖口、下摆、分割线与装饰，去除摄影背景和光影干扰。不增加看不见的结构，不标注推测的尺寸。",
            "输出为线稿概念图，不是矢量文件、纸样、工艺单或可直接生产的技术稿。",
        ].join("\n\n"),
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
        prompt: [
            "任务：以图片1中服装的正面设计为参考，提出一个风格协调的背面设计方案。",
            "沿用参考服装的品类、整体廓形、长度、面料观感与配色；正面图案或装饰不直接复制到背面，未给出要求时保持背面简洁。展示单款背面效果，不额外输出多联拼图。",
            "不可见的背面结构属于设计推演，不宣称还原原款真实背面，不推断内部工艺或纸样尺寸。输出仅为概念效果，不是生产技术稿。",
        ].join("\n\n"),
    },
    {
        id: "pattern-extract",
        title: "花型提取",
        description: "从参考图中整理可见的图案元素。",
        group: "pattern",
        tool: "image-edit",
        prompt: [
            "任务：观察图片1，提取其中实际可见的主要花型或图案元素，整理为独立、清晰的平面图案概念图。",
            "尽量保留可见元素的轮廓、配色与相对关系，减弱服装褶皱、透视及摄影背景的影响。不要把遮挡或缺失区域当作已知原稿，不增加品牌、文字或无关元素。",
            "结果仅为概念整理，不保证完整还原原稿、文字精确复刻、矢量化、无缝循环或直接印花生产。",
        ].join("\n\n"),
    },
    {
        id: "pattern-colorway",
        title: "图案配色",
        description: "保留图案形状，探索不同色彩组合。",
        group: "pattern",
        tool: "image-edit",
        prompt: [
            "任务：对图片1中的图案进行概念配色调整。",
            `目标配色（填写要调整的颜色或区域）：${CREATIVE_REQUIREMENT_PLACEHOLDER}`,
            "保留原图案的元素形状、线条、大小、边界和排列关系，只调整要求明确指定的颜色或区域，其余部分保持不变。不要新增文字、元素或多联拼图。",
            "色名、色值或色号只作为近似视觉方向；结果为概念配色，不保证精确色值、标准色号还原或实物色差，不是生产色稿。",
        ].join("\n\n"),
    },
    {
        id: "accessory-design",
        title: "辅料设计",
        description: "上传辅料与图案，定制纹样和外形。",
        group: "pattern",
        tool: "image-edit",
        prompt: "以图片1的辅料为基础，参考图片2的图案创作辅料外观概念。保留辅料的连接结构和材质特征，结果不是模具、CAD 或生产文件。",
    },
    {
        id: "pattern-craft",
        title: "图案工艺",
        description: "模拟刺绣、提花等图案工艺质感。",
        group: "pattern",
        tool: "image-edit",
        prompt: [
            "任务：以图片1的图案为基础，模拟指定工艺的视觉质感。",
            `工艺与效果要求（如刺绣、毛巾绣或提花）：${CREATIVE_REQUIREMENT_PLACEHOLDER}`,
            "保留原图案的元素、轮廓、配色和构图；仅在要求的范围内表现材质与工艺质感，不擅自重画图案或添加装饰。",
            "结果仅为概念效果，不是绣花针迹文件、提花组织图或生产工艺单，不承诺真实工艺可行性。",
        ].join("\n\n"),
    },
];

export function getCreativePreset(id: string | null): CreativePreset | undefined {
    return creativePresets.find((preset) => preset.id === id);
}

export function buildCreativePresetHref(preset: CreativePreset): string {
    return `/creative/${preset.id}`;
}
