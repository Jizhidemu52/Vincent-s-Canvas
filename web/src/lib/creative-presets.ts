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
    readonly engine?: "ai" | "vector" | "layers";
    readonly prompt?: string;
    readonly garment?: GarmentScenario;
};

/** Local starting points only: opening a preset never submits a generation task. */
const startingPresets: readonly CreativePreset[] = [
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

const addedPresets: readonly CreativePreset[] = [
    { id: "series-extension", title: "系列延伸", description: "提炼参考款的共同语言，生成一张多款方案板。", group: "new", tool: "image-edit", prompt: "保留参考款的系列元素，变化目标品类的廓形与细节，输出单张多款概念方案板；不是生产技术稿。" },
    { id: "bestseller-proposal", title: "爆款系列提案", description: "围绕核心款规划搭配，组织成系列提案板。", group: "new", tool: "image-edit", prompt: "围绕核心参考款延伸完整搭配，输出单张系列概念提案板，不预测销量，不是生产技术稿。" },
    { id: "detail-to-style", title: "细节生款", description: "把局部结构应用到新的完整服装款式。", group: "new", tool: "image-edit", prompt: "以局部参考的结构细节为锚点，在指定品类中设计完整服装概念；不是生产技术稿。" },
    { id: "fabric-to-style", title: "面料生款", description: "从面料颜色与肌理出发，探索适配款式。", group: "new", tool: "image-edit", prompt: "以面料参考的纹理和色彩设计适配款式概念，不推断实测物性，不是生产技术稿。" },
    { id: "reference-to-style", title: "参考款生款", description: "按品类、风格、部件或自定义要求改造基款。", group: "new", tool: "image-edit", prompt: "以参考款为基底，明确保留项和修改项，生成新的服装概念；不是生产技术稿。" },
    { id: "style-fusion", title: "款式融合", description: "分别指定两张参考的结构与细节职责。", group: "new", tool: "image-edit", prompt: "将图片1的基款结构与图片2的指定细节融合为一个服装概念，不叠加两件衣服；不是生产技术稿。" },
    { id: "outfit-design", title: "套装设计", description: "保留已有单品，为它设计协调的搭配服饰。", group: "new", tool: "image-edit", prompt: "保留参考单品并新增指定搭配品类，形成协调套装概念，不是生产技术稿。" },
    { id: "apply-pattern", title: "贴图案", description: "把指定图案放到服装的目标位置。", group: "restyle", tool: "image-edit", prompt: "图片1提供服装，图片2仅提供图案；在指定位置进行贴图概念设计，不是精确生产定位稿。" },
    { id: "pattern-fill", title: "花型铺设", description: "控制花型比例与方向，预览整片服装效果。", group: "restyle", tool: "image-edit", prompt: "将图片2的花型在图片1的指定衣片内重复铺设，保留服装结构，输出概念预览，不是生产技术稿。" },
    { id: "fabric-change", title: "更换面料", description: "按衣片分配最多三张面料，保留原款廓形。", group: "restyle", tool: "image-edit", prompt: "图片1提供服装结构，其余图片仅提供面料；按部位替换材质概念，不是物理仿真或生产技术稿。" },
    { id: "remove-decoration", title: "去除印绣花", description: "移除装饰并补齐面料，可保留原色或转白。", group: "restyle", tool: "image-edit", prompt: "去除指定印绣花并修复同材质底布，保留服装结构，输出概念效果，不是生产技术稿。" },
    { id: "sketch-to-style", title: "线稿成款", description: "依据线稿结构，补充面料与穿着效果。", group: "restyle", tool: "image-edit", prompt: "严格参考图片1的可见线稿结构，用指定面料生成服装概念，不是纸样或生产技术稿。" },
    { id: "sketch-vectorization", title: "线稿矢量化", description: "本地描摹黑白线稿，预览并导出真实 SVG 路径。", group: "restyle", tool: "image-edit", engine: "vector" },
    { id: "pattern-create", title: "AI 图案", description: "从文字或参考图创作独立图案与相似变体。", group: "pattern", tool: "image-generation", prompt: "依文字或参考创作独立图案概念，遵守元素与背景要求，不是矢量或可直接生产的技术稿。" },
    { id: "pattern-fusion", title: "图案融合", description: "为两到三张参考分配元素、构图和色彩职责。", group: "pattern", tool: "image-edit", prompt: "按输入图的角色融合图案元素与构图，输出完整图案概念，不是生产技术稿。" },
    { id: "seamless-pattern", title: "四方连续", description: "生成连续花型草案，再用循环工具检查接缝。", group: "pattern", tool: "image-edit", prompt: "按指定重复关系与边界范围生成连续花型概念草案，需实际平铺检查，不保证直接生产。" },
    { id: "pattern-layers", title: "图案分层", description: "将图案分为独立图层，调整层序并导出文件。", group: "pattern", tool: "image-edit", engine: "layers" },
    { id: "pattern-vectorization", title: "图案矢量化", description: "按目标色数本地描摹，导出可编辑彩色 SVG。", group: "pattern", tool: "image-edit", engine: "vector" },
];

const presetOrder = [
    "series-extension", "bestseller-proposal", "detail-to-style", "fabric-to-style", "text-to-style", "reference-to-style", "style-fusion", "back-design", "outfit-design",
    "local-restyle", "garment-colorway", "apply-pattern", "pattern-fill", "fabric-change", "remove-decoration", "sketch-to-style", "style-to-sketch", "sketch-vectorization",
    "pattern-create", "pattern-fusion", "seamless-pattern", "pattern-craft", "pattern-colorway", "pattern-extract", "accessory-design", "pattern-layers", "pattern-vectorization",
] as const;
const presetById = new Map([...startingPresets, ...addedPresets].map(preset => [preset.id, preset]));
export const creativePresets: readonly CreativePreset[] = presetOrder.map(id => {
    const preset = presetById.get(id)!;
    const group = presetOrder.indexOf(id) < 9 ? "new" : presetOrder.indexOf(id) < 18 ? "restyle" : "pattern";
    return { ...preset, group, engine: preset.engine ?? "ai" };
});

export function getCreativePreset(id: string | null): CreativePreset | undefined {
    return creativePresets.find((preset) => preset.id === id);
}

export function buildCreativePresetHref(preset: CreativePreset): string {
    return `/creative/${preset.id}`;
}
