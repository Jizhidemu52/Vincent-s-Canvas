import type { ReferenceImage } from "@/types/image";
import type { StandardColorSelection } from "@/lib/standard-colors";

export const SCENE_SLOT_IDS = ["primary", "secondary", "tertiary", "quaternary"] as const;
export type SceneSlotId = (typeof SCENE_SLOT_IDS)[number];
export type SceneSlot = { id: SceneSlotId; label: string; hint: string; required: boolean };
export const CONCEPT_COUNTS = [1, 2, 3, 4, 6, 9] as const;
export const OUTFIT_CATEGORIES: Record<string, readonly string[]> = {
    "上装": ["外套", "衬衫", "针织衫", "背心"],
    "下装": ["半裙", "长裤", "短裤"],
    "连体装": ["连衣裙", "连体裤"],
    "配饰": ["包袋", "帽子", "围巾"],
};

export function supportsSceneSelection(sceneId: string): boolean {
    return ["local-restyle", "garment-colorway", "apply-pattern", "pattern-fill", "fabric-change", "remove-decoration", "pattern-colorway"].includes(sceneId);
}

export type SceneForm = {
    description: string;
    category: string;
    silhouette: string;
    fabric: string;
    presentation: string;
    sketchStyle: string;
    sketchDetail: string;
    restyleArea: string;
    change: string;
    preserve: string;
    colorMode: "smart" | "specific" | "reference";
    colors: string[];
    colorSelections?: Array<StandardColorSelection | null>;
    colorRegion: string;
    colorMood: string;
    backStructure: string;
    backMotif: string;
    extractMode: string;
    extractBackground: string;
    craft: string;
    craftFabric: string;
    accessoryType: string;
    accessoryApply: string;
    conceptCount: number;
    referenceCount: number;
    fabricCount: number;
    referenceMode: "category" | "style" | "detail" | "custom";
    targetStyle: string;
    referenceDetail: string;
    fusionRole1: string;
    fusionRole2: string;
    fusionWeight: number;
    outfitCategory: string;
    outfitSubcategory: string;
    placement: string;
    patternScale: number;
    patternDirection: string;
    fabricAssignment: string;
    removeMode: "original" | "white";
    useFabricReference: boolean;
    sketchColor: "reference" | "random";
    patternMode: "text" | "reference" | "variation";
    patternBackground: "white" | "original";
    similarity: number;
    craftSource: "description" | "reference";
    extractCraft: "preserve" | "remove";
    repeatArrangement: "straight" | "half-drop" | "half-brick";
    boundaryMode: "inward" | "outward";
    ratioX: number;
    ratioY: number;
};

export function createSceneForm(sceneId: string): SceneForm {
    return {
        description: "",
        category: "按描述判断",
        silhouette: "按描述判断",
        fabric: "",
        presentation: "白底平铺",
        sketchStyle: "technical",
        sketchDetail: "standard",
        restyleArea: "领口",
        change: "",
        preserve: "",
        colorMode: "smart",
        colors: ["#789282", "#E8DCC8", "#424A55"],
        colorRegion: "",
        colorMood: "自然柔和",
        backStructure: "简洁",
        backMotif: "不延续",
        extractMode: "单独图案",
        extractBackground: "白底",
        craft: "刺绣",
        craftFabric: "棉布",
        accessoryType: "拉链头",
        accessoryApply: "形状与纹样",
        conceptCount: ["series-extension", "bestseller-proposal", "detail-to-style", "fabric-to-style"].includes(sceneId) ? 4 : 1,
        referenceCount: sceneId === "pattern-fusion" ? 2 : 1,
        fabricCount: 1,
        referenceMode: "custom",
        targetStyle: "",
        referenceDetail: "",
        fusionRole1: sceneId === "pattern-fusion" ? "主要元素与线条" : "整体廓形与比例",
        fusionRole2: sceneId === "pattern-fusion" ? "构图与装饰语言" : "指定部件与面料",
        fusionWeight: 60,
        outfitCategory: "上装",
        outfitSubcategory: "外套",
        placement: "前身居中",
        patternScale: 1,
        patternDirection: "保持参考方向",
        fabricAssignment: "",
        removeMode: "original",
        useFabricReference: false,
        sketchColor: "reference",
        patternMode: "text",
        patternBackground: "white",
        similarity: 70,
        craftSource: "description",
        extractCraft: "preserve",
        repeatArrangement: "straight",
        boundaryMode: "inward",
        ratioX: 15,
        ratioY: 15,
    };
}

export const sceneSummaries: Record<string, { input: string; output: string; example: string; limit: string }> = {
    "series-extension": { input: "系列参考款", output: "多款方案板", example: "保留花朵贴饰与米白粗呢，变化半裙版型，在一张方案板里展示四款。", limit: "款数指一张方案板中的设计数量，不是独立文件数；每款的细节和展示方式仍需检查。" },
    "bestseller-proposal": { input: "核心参考款", output: "系列搭配提案", example: "围绕侧腰褶裥半裙，规划四套颜色协调、品类有变化的完整搭配。", limit: "生成单张系列提案板，不预测销量；图内文字与细节需要校对，不是可编辑排版或生产资料。" },
    "detail-to-style": { input: "局部细节图", output: "整衣设计板", example: "保留三角翻折袋口与枝条刺绣，把这个细节应用到四款简约衬衫。", limit: "每款都需检查指定细节是否保留；局部参考不能证明原服装全部结构。" },
    "fabric-to-style": { input: "面料纹理图", output: "适配款式板", example: "参考紫灰色抽象格纹，设计四款轻薄内搭，展示不同领型与褶皱。", limit: "面料是视觉参考，不推断实测物性、真实花距或生产工艺；输出为单张方案板。" },
    "reference-to-style": { input: "基款参考图", output: "新款概念", example: "去掉夹克两个胸袋，增加两个斜插袋，保留帽子、门襟和原面料。", limit: "参考款编辑不自动提供像素级保持；明确保留与改动要求并检查结构。" },
    "style-fusion": { input: "两款参考图", output: "融合新款", example: "采用图一的双层碎褶裙摆，结合图二的扭结与长垂布，生成一条短裙。", limit: "参考权重为提示侧重，不是确定性像素混合；两张图的指定元素均需验收。" },
    "outfit-design": { input: "已有单品", output: "协调套装", example: "保留黄棕格纹半裙，为它设计同系列短外套并展示成套效果。", limit: "搭配品类为父子分类；生成效果不等于原件逐像素保留或已完成打版。" },
    "apply-pattern": { input: "服装与图案", output: "定位图案效果", example: "把图二花朵放在图一前胸居中，保留原服装结构与花朵识别度。", limit: "AI 贴图可能改变文字与细节；需精确尺寸、图案像素或排版时使用图案定位工作台。" },
    "pattern-fill": { input: "服装与花型", output: "衣片铺花效果", example: "把图二连续花型铺在图一大身，保留领口和袖口素色，图案比例为一倍。", limit: "输出是穿着效果预览，不把不连续图片自动变成生产无缝花型；比例为视觉参考。" },
    "fabric-change": { input: "款式与面料", output: "换料效果", example: "大身采用图二的格纹面料，领口与袖口采用图三素色面料，保留原廓形。", limit: "最多三张面料；多面料需说明分配位置，结果不是物理仿真或精确纹理映射。" },
    "remove-decoration": { input: "印绣花服装", output: "干净底布", example: "去除胸前印花，用同色面料补齐，保留布纹、衣褶与衣服轮廓。", limit: "印绣花下方内容由模型修复；涂选后仅合入选区，边缘与布纹需检查。" },
    "sketch-to-style": { input: "线稿与面料", output: "服装效果图", example: "依照线稿的领口、袖型和口袋结构，用浅蓝棉麻生成白底单品效果。", limit: "必须对照线稿检查轮廓、接缝与辅料；生成效果不等于纸样或生产技术稿。" },
    "sketch-vectorization": { input: "黑白线稿", output: "SVG 轮廓路径", example: "调节阈值、噪点过滤与平滑程度，将清晰黑白线稿转为可编辑路径。", limit: "本地轮廓描摹，不嵌入位图；不是单线中心线、服装纸样或自动结构识别。" },
    "pattern-create": { input: "文字或参考图", output: "独立图案", example: "创作蓝灰色枝叶与小花组成的手绘图案，白底，保留清晰轮廓。", limit: "输出为栅格图案；相似度是提示侧重，白底不等于透明通道或矢量文件。" },
    "pattern-fusion": { input: "两到三张图", output: "融合图案", example: "以图一的鸟为主体，借用图二的花枝构图，图三只提供暖色配色。", limit: "每张参考有不同职责；融合可能重绘细节，需检查元素身份、重复残影和文字。" },
    "seamless-pattern": { input: "原始花型", output: "连续花型草案", example: "按半落排列修复花型边缘，在左右和上下各百分之十五范围内调整。", limit: "AI 仅生成连续花型草案；必须在花型循环工作台实际平铺检查接缝后再判断能否使用。" },
    "pattern-layers": { input: "完整图案", output: "独立图层", example: "将背景、花枝和鸟分别整理为独立图层，调整位置、层序并导出。", limit: "每层需要独立像素和坐标；遮挡处的补全部分属于推测，不是可见原稿。" },
    "pattern-vectorization": { input: "彩色图案", output: "多色 SVG", example: "按八种主色描摹图案，检查孔洞与边缘后导出可编辑颜色路径。", limit: "本地颜色量化与轮廓描摹会简化细节；需对照原图检查颜色数、孔洞与小字。" },
    "text-to-style": {
        input: "款式描述",
        output: "新款效果图",
        example: "设计一件奶油色长袖衬衫，微宽松廓形，小尖领，前中纽扣门襟，面料柔软有垂感。",
        limit: "用于设计探索，不是纸样或可直接生产的技术稿。",
    },
    "style-to-sketch": {
        input: "款式照片",
        output: "结构线稿",
        example: "将浅蓝色衬衫整理为白底线稿，保留领口、门襟、袖口和可见结构线。",
        limit: "AI 输出为栅格线稿，可再本地描摹为 SVG 轮廓路径；不推断不可见结构或尺寸，不是纸样。",
    },
    "local-restyle": {
        input: "原款衬衫",
        output: "领口改款",
        example: "将衬衫普通翻领改为柔和的荷叶领，保留原有衣身、袖型、面料与配色。",
        limit: "涂选后只合入选区，区域外保留原图；未涂选时仅靠文字约束。选区内结构、接缝与光影仍需核对。",
    },
    "garment-colorway": {
        input: "原款风衣",
        output: "蓝绿配色",
        example: "将米色风衣改为低饱和蓝绿色，保留原有版型、腰带、纽扣与面料纹理。",
        limit: "色值与参考色为近似视觉方向，不能作为生产色标或实物色差保证。",
    },
    "back-design": {
        input: "夹克正面",
        output: "背面设计",
        example: "为棕红色短款夹克设计简洁背面，延续面料、配色与长度比例，不增加图案。",
        limit: "背面是新设计推演，不代表原款真实背面或内部做法。",
    },
    "pattern-extract": {
        input: "碎花衬衫",
        output: "独立花纹",
        example: "从碎花衬衫中提取清楚可见的小花和叶片，整理在白底上，不保留服装轮廓。",
        limit: "不保证被遮挡内容还原、文字精确复刻、矢量化或无缝循环。",
    },
    "pattern-colorway": {
        input: "蓝灰枝叶",
        output: "暖棕配色",
        example: "将蓝灰色枝叶图案调整为暖棕配色，保留所有枝叶形状、线条和排列关系。",
        limit: "AI 配色为近似效果；本地精确换色按 RGB 替换并保留图案位置与透明度，不代表印染色差保证。",
    },
    "pattern-craft": {
        input: "平面花朵",
        output: "刺绣效果",
        example: "图案保持原有颜色和比例，突出边缘收口与面料纹理。",
        limit: "只模拟工艺观感，不生成绣花针迹文件、提花组织图或生产工艺单。",
    },
    "accessory-design": {
        input: "拉链头与花图",
        output: "花形金属拉链头",
        example: "将图片2的花朵轮廓应用到图片1的拉链头，设计为花形金属拉链头，保留连接孔位与金属质感。",
        limit: "设计效果不代表开模、尺寸、连接强度或真实生产可行性。",
    },
};

export function getSceneSlots(sceneId: string, form: SceneForm): SceneSlot[] {
    if (sceneId === "text-to-style" || !Object.hasOwn(sceneSummaries, sceneId)) return [];
    const slot = (id: SceneSlotId, label: string, hint: string, required = true): SceneSlot => ({ id, label, hint, required });
    if (sceneId === "pattern-create") return form.patternMode === "text" ? [] : [slot("primary", "图案参考图", "图片1 · 提供图案元素、构图或相似变体依据")];
    if (sceneId === "series-extension" || sceneId === "bestseller-proposal") return SCENE_SLOT_IDS.slice(0, Math.max(1, Math.min(4, form.referenceCount))).map((id, index) => slot(id, `系列参考图 ${index + 1}`, `图片${index + 1} · ${index ? "补充同系列的材料、细节与风格" : "核心款，确定系列设计语言"}`));
    if (sceneId === "style-fusion") return [slot("primary", "基款结构图", "图片1 · 提供主要廓形与整体比例"), slot("secondary", "细节融合图", "图片2 · 提供要融合的部件、面料或装饰")];
    if (sceneId === "pattern-fusion") return SCENE_SLOT_IDS.slice(0, form.referenceCount === 3 ? 3 : 2).map((id, index) => slot(id, ["主体元素图", "构图风格图", "配色参考图"][index]!, `图片${index + 1} · ${["提供主要图案元素", "提供构图或装饰语言", "只提供配色，不增加新主体"][index]}`));
    if (sceneId === "fabric-change") return [slot("primary", "服装原图", "图片1 · 只提供衣服结构、光影与展示方式"), ...SCENE_SLOT_IDS.slice(1, 1 + Math.max(1, Math.min(3, form.fabricCount))).map((id, index) => slot(id, `面料图 ${index + 1}`, `图片${index + 2} · 仅提供第${index + 1}种面料的纹理、颜色与光泽`))];
    if (sceneId === "apply-pattern" || sceneId === "pattern-fill") return [slot("primary", "服装原图", "图片1 · 保持款式、轮廓和展示角度"), slot("secondary", sceneId === "apply-pattern" ? "定位图案" : "连续花型", "图片2 · 仅提供图案，不提供服装、人物或背景")];
    if (sceneId === "sketch-to-style") return [slot("primary", "服装线稿", "图片1 · 决定廓形、接缝与可见部件"), ...(form.useFabricReference ? [slot("secondary", "面料参考图", "图片2 · 仅提供面料与色彩，不改变线稿结构")] : [])];
    if (sceneId === "pattern-craft" && form.craftSource === "reference") return [slot("primary", "图案原稿", "图片1 · 保留图案的轮廓、配色与构图"), slot("secondary", "工艺参考图", "图片2 · 只参考针迹、肌理、厚度和收边，不复制图案")];
    if (sceneId === "detail-to-style") return [slot("primary", "局部细节图", "图片1 · 继承该细节的结构、形状、位置关系，不虚构原衣全貌")];
    if (sceneId === "fabric-to-style") return [slot("primary", "面料纹理图", "图片1 · 提供材料纹理、颜色与光泽，不作为服装结构参考")];
    if (sceneId === "sketch-vectorization") return [slot("primary", "黑白线稿", "输入清晰黑白线稿，本地生成 SVG 轮廓路径")];
    if (sceneId === "pattern-vectorization" || sceneId === "pattern-layers" || sceneId === "seamless-pattern") return [slot("primary", "图案原稿", "保留原始图案，结果另存，不覆盖输入")];
    if (sceneId === "accessory-design") return [
        { id: "primary", label: "辅料图", hint: "图片1 · 提供辅料的结构、材质与连接方式", required: true },
        { id: "secondary", label: "图案图", hint: "图片2 · 只提供要应用的图案或造型元素", required: true },
    ];
    const pattern = sceneId.startsWith("pattern-");
    const slots: SceneSlot[] = [{
        id: "primary",
        label: sceneId === "back-design" ? "服装正面图" : pattern ? "图案参考图" : "服装参考图",
        hint: sceneId === "back-design"
            ? "图片1 · 清晰展示正面廓形、材质与设计细节"
            : pattern ? "图片1 · 提供需要处理的花型与元素" : "图片1 · 清晰展示完整服装与细节",
        required: true,
    }];
    if ((sceneId === "garment-colorway" || sceneId === "pattern-colorway") && form.colorMode === "reference") {
        slots.push({ id: "secondary", label: "配色参考图", hint: "图片2 · 只参考配色，不带入图案、款式或背景", required: true });
    }
    return slots;
}

export function isSceneHexColor(value: string): boolean {
    return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value.trim());
}

function normalizedSceneHex(value: string): string | null {
    if (!isSceneHexColor(value)) return null;
    const hex = value.trim().toUpperCase();
    return hex.length === 4 ? `#${hex.slice(1).split("").map(part => part + part).join("")}` : hex;
}

/** A manual HEX edit must not keep claiming the identity of a previously chosen standard. */
export function getSceneColorSelection(form: SceneForm, index: number): StandardColorSelection | null {
    const selection = form.colorSelections?.[index];
    const color = form.colors[index];
    if (!selection || typeof color !== "string" || typeof selection.hex !== "string") return null;
    const hex = normalizedSceneHex(color);
    if (!hex || normalizedSceneHex(selection.hex) !== hex) return null;
    if (![selection.id, selection.name, selection.library, selection.sourceUrl, selection.source, selection.datasetVersion].every(value => typeof value === "string")) return null;
    return selection.id.trim() && selection.name.trim() && selection.library.trim() ? selection : null;
}

export function setSceneColor(form: SceneForm, index: number, hex: string, selection?: StandardColorSelection): SceneForm {
    if (!Number.isInteger(index) || index < 0 || index >= form.colors.length) return form;
    const colors = form.colors.map((color, at) => at === index ? hex : color);
    const colorSelections = form.colors.map((_, at) => at === index ? selection ? { ...selection } : null : getSceneColorSelection(form, at));
    const next = { ...form, colors, colorSelections };
    colorSelections[index] = getSceneColorSelection(next, index);
    return next;
}

export function removeSceneColor(form: SceneForm, index: number): SceneForm {
    if (!Number.isInteger(index) || index < 0 || index >= form.colors.length) return form;
    return {
        ...form,
        colors: form.colors.filter((_, at) => at !== index),
        colorSelections: form.colors.map((_, at) => getSceneColorSelection(form, at)).filter((_, at) => at !== index),
    };
}

export function addSceneColor(form: SceneForm, hex = "#808080"): SceneForm {
    if (form.colors.length >= 6) return form;
    return { ...form, colors: [...form.colors, hex], colorSelections: [...form.colors.map((_, at) => getSceneColorSelection(form, at)), null] };
}

/** Capture the palette and source labels independently for queued writes and generation history. */
export function cloneSceneForm(form: SceneForm): SceneForm {
    return { ...form, colors: [...form.colors], ...(form.colorSelections ? {
        colorSelections: form.colors.map((_, index) => {
            const selection = getSceneColorSelection(form, index);
            return selection ? { ...selection } : null;
        }),
    } : {}) };
}

export function validateSceneForm(sceneId: string, form: SceneForm, images: Partial<Record<SceneSlotId, ReferenceImage>>): string | null {
    if (!Object.hasOwn(sceneSummaries, sceneId)) return "暂不支持这个设计场景。";
    if (["series-extension", "bestseller-proposal", "detail-to-style", "fabric-to-style"].includes(sceneId)
        && !CONCEPT_COUNTS.includes(form.conceptCount as (typeof CONCEPT_COUNTS)[number])) return "方案板内款数请选择 1、2、3、4、6 或 9。";
    if (["series-extension", "bestseller-proposal"].includes(sceneId) && (!Number.isInteger(form.referenceCount) || form.referenceCount < 1 || form.referenceCount > 4)) return "系列参考图数量应为 1–4 张。";
    if (sceneId === "pattern-fusion" && ![2, 3].includes(form.referenceCount)) return "图案融合需要 2 或 3 张参考图。";
    if (sceneId === "fabric-change" && (!Number.isInteger(form.fabricCount) || form.fabricCount < 1 || form.fabricCount > 3)) return "面料数量应为 1–3 张。";
    if (sceneId === "pattern-create" && !["text", "reference", "variation"].includes(form.patternMode)) return "请选择文字、参考图或相似变体模式。";
    for (const slot of getSceneSlots(sceneId, form)) {
        if (slot.required && !images[slot.id]) return `请上传${slot.label}。`;
    }
    if (["detail-to-style", "fabric-to-style"].includes(sceneId)) {
        if (!form.targetStyle.trim()) return "请填写品牌或风格方向。";
        if (!form.category.trim() || form.category === "按描述判断") return "请选择目标服装品类。";
    }
    if (sceneId === "reference-to-style") {
        if (!["category", "style", "detail", "custom"].includes(form.referenceMode)) return "请选择参考改款方式。";
        if (form.referenceMode === "category" && (!form.category.trim() || form.category === "按描述判断")) return "请选择要转成的服装品类。";
        if (form.referenceMode === "style" && !form.targetStyle.trim()) return "请填写目标风格。";
        if (form.referenceMode === "detail" && !form.referenceDetail.trim()) return "请说明要保留或调整的参考部件。";
        if (form.referenceMode === "custom" && !form.description.trim()) return "请填写自定义改款要求。";
    }
    if (["style-fusion", "pattern-fusion"].includes(sceneId)) {
        if (!form.fusionRole1.trim() || !form.fusionRole2.trim()) return "请分别说明两张参考图的职责。";
        if (!Number.isFinite(form.fusionWeight) || form.fusionWeight < 10 || form.fusionWeight > 90) return "图一参考侧重应为 10–90%。";
    }
    if (sceneId === "outfit-design" && (!Object.hasOwn(OUTFIT_CATEGORIES, form.outfitCategory) || !OUTFIT_CATEGORIES[form.outfitCategory]!.includes(form.outfitSubcategory))) return "请选择有效的搭配品类与子类。";
    if (["apply-pattern", "pattern-fill", "fabric-change"].includes(sceneId) && (!Number.isFinite(form.patternScale) || form.patternScale < .25 || form.patternScale > 4)) return "图案或纹理视觉比例应为 0.25–4 倍。";
    if (["apply-pattern", "pattern-fill"].includes(sceneId) && !form.placement.trim()) return "请填写图案位置或铺设衣片。";
    if (sceneId === "fabric-change" && form.fabricCount > 1 && !form.fabricAssignment.trim()) return "使用多张面料时，请说明每张面料应用到哪些衣片。";
    if (sceneId === "remove-decoration" && !["original", "white"].includes(form.removeMode)) return "请选择保留原色或变为白色。";
    if (sceneId === "sketch-to-style" && !["reference", "random"].includes(form.sketchColor)) return "请选择线稿参考色或协调新配色。";
    if (sceneId === "pattern-create") {
        if (form.patternMode === "text" && !form.description.trim()) return "请描述图案元素、风格与构图。";
        if (form.patternMode === "variation" && (!Number.isFinite(form.similarity) || form.similarity < 10 || form.similarity > 100)) return "参考相似度应为 10–100%。";
    }
    if (["pattern-create", "pattern-fusion"].includes(sceneId) && !["white", "original"].includes(form.patternBackground)) return "请选择白底或按设计保留底色。";
    if (sceneId === "pattern-craft" && !["description", "reference"].includes(form.craftSource)) return "请选择文字工艺或工艺参考图。";
    if (sceneId === "pattern-extract" && !["preserve", "remove"].includes(form.extractCraft)) return "请选择保留工艺或还原平面图案。";
    if (sceneId === "seamless-pattern") {
        if (!["straight", "half-drop", "half-brick"].includes(form.repeatArrangement) || !["inward", "outward"].includes(form.boundaryMode)) return "请选择有效的重复排列与边界处理方式。";
        if (![form.ratioX, form.ratioY].every(value => Number.isFinite(value) && value >= 0 && value <= 30)) return "边界调整范围应为 0–30%。";
    }
    if (sceneId === "text-to-style" && !form.description.trim()) return "请写下你想设计的款式。";
    if (sceneId === "local-restyle" && !form.change.trim()) return "请描述这个部位要改成什么样。";
    if (sceneId === "back-design" && form.backStructure === "自由描述" && !form.description.trim()) return "请补充你想要的背面结构。";
    if (sceneId === "garment-colorway" || sceneId === "pattern-colorway") {
        if (!["smart", "specific", "reference"].includes(form.colorMode)) return "请选择配色方式。";
        if (form.colorMode === "specific") {
            if (form.colors.length === 0) return "请至少添加一种目标颜色。";
            if (form.colors.length > 6) return "最多使用 6 种目标颜色。";
            const invalidIndex = form.colors.findIndex((color) => !isSceneHexColor(color));
            if (invalidIndex >= 0) return `第 ${invalidIndex + 1} 个色值无效，请使用 #RGB 或 #RRGGBB 格式。`;
        }
    }
    return null;
}

function colorDirection(form: SceneForm, garment = false): string {
    if (form.colorMode === "reference") {
        return "图片2是配色参考图，仅提取其中的主要色彩及搭配关系，应用到图片1；不复制图片2的图案、款式、材质、人物或背景。";
    }
    if (form.colorMode === "specific") {
        const palette = `目标色板：${form.colors.map((color) => color.trim().toUpperCase()).join("、")}。在指定改色区域内使用这 ${form.colors.length} 种目标颜色，结合明暗与材质自然分配，不把色板绘制到成图中。`;
        if (!garment) return palette;
        const targets = form.colors.map((color, index) => {
            const selection = getSceneColorSelection(form, index);
            const identity = selection ? `色库「${selection.library.replace(/\s+/g, " ").trim()}」，色号「${selection.name.replace(/\s+/g, " ").trim()}」，` : "";
            return `第${index + 1}目标色：${identity}HEX ${normalizedSceneHex(color) || color.trim().toUpperCase()}。`;
        });
        return [palette, ...targets].join("\n");
    }
    return `智能配色方向：${form.colorMood}。依据图片1的原有色块关系与主体特征，设计一套协调且有区别的配色。`;
}

const craftTextures: Record<string, string> = {
    "刺绣": "表现清晰针迹方向、独立绣线纤维、轻微凸起与整洁收边，不做成平面印花或贴纸。",
    "毛巾绣": "表现密集立体毛圈、柔软绒感、厚度起伏和清晰外轮廓，不做成光滑塑料或普通平绣。",
    "提花": "表现图案由经纬或针织纱线交织形成的组织关系、连续织纹与纱线颗粒，不表现为表面贴上的印花。",
    "胶印": "表现覆盖于面料表面的柔韧胶质色层、干净边缘与克制的光泽，保留底布质感，不画成刺绣线迹。",
};

function boardInstruction(form: SceneForm, unit: string): string {
    return `方案板要求：只输出一张图，图内清楚展示 ${form.conceptCount} ${unit}；每款完整、不相互遮挡、视图大小协调。${form.conceptCount === 1 ? "单款居中。" : "使用整齐的分区布局，让每款可单独辨认。"}这不是 ${form.conceptCount} 个独立文件，也不等于生成张数；不要擅自增加款数。`;
}

function presentationInstruction(form: SceneForm): string {
    if (form.presentation === "模特展示") return "展示方式：模特展示，完整呈现服装与关键结构，姿态自然、背景简洁，不用道具遮挡。";
    if (form.presentation === "参考图一致") return "展示方式：跟随核心参考图片1，平铺仍平铺、模特仍模特，不擅自切换展示形式。";
    if (form.presentation === "设计效果图") return "展示方式：服装设计效果图，简洁背景，完整表达轮廓、材质与细节。";
    return "展示方式：白底平铺，完整单品居中，无人物、衣架或无关道具，保留克制阴影。";
}

function patternBackgroundInstruction(form: SceneForm): string {
    return form.patternBackground === "original" ? "背景处理：保留参考图案本身的底色关系；文字模式按设计描述安排底色，移除无关摄影场景。" : "背景处理：干净白底，保留图案内部白色细节；白底不是透明通道，不绘制棋盘格假透明。";
}

export function buildScenePrompt(sceneId: string, form: SceneForm): string {
    if (!Object.hasOwn(sceneSummaries, sceneId)) return "";
    const description = form.description.trim();
    const extra = description ? `补充设计要求：${description}` : "";
    const concept = "输出为单张清晰的概念效果图片，不添加无关文字、品牌或水印；不是纸样或可直接生产的技术稿。";
    let lines: string[];
    switch (sceneId) {
        case "series-extension":
        case "bestseller-proposal": {
            const proposal = sceneId === "bestseller-proposal";
            lines = [
                proposal ? "任务：以参考核心款为起点，设计完整、相互协调的系列搭配提案，不进行销量预测。" : "任务：提炼参考款共同的色彩、面料、图形与结构语言，延伸出同系列的新款。",
                `输入共有${form.referenceCount}张系列参考：图片1是核心款，其余已提供图片只补充共同的设计语言；不照抄互相矛盾的款式，不加入未提供图片的内容。`,
                proposal ? "每套提案必须有完整的服饰搭配和清楚的主次关系；变化品类、搭配与长度，仍保留核心款的识别元素。" : `目标品类：${form.category}。每款至少变化一个廓形或部件，同时保留系列的关键材料、配色与装饰。`,
                form.preserve.trim() ? `全系列必须保留：${form.preserve.trim()}` : "优先保留核心款最具识别度的材质、配色与主图形。",
                boardInstruction(form, proposal ? "套搭配" : "款设计"), presentationInstruction(form), extra,
                "输出是单张概念方案板，不是独立款式文件、可编辑提案或生产技术稿。",
            ];
            break;
        }
        case "detail-to-style":
        case "fabric-to-style": {
            const detail = sceneId === "detail-to-style";
            lines = [
                detail ? "任务：图片1是局部设计细节，准确识别其结构、形状、比例与连接关系，将它应用到完整新款。不是复原未给出的原服装。" : "任务：图片1仅提供面料的颜色、纹理、图案与光泽观感，设计适配它的完整服装，不把面料照片当成款式轮廓。",
                `目标品类：${form.category}；品牌或风格方向：${form.targetStyle.trim()}。`,
                detail ? `每一款都要清楚呈现同一关键细节。${form.referenceDetail.trim() ? `指定细节：${form.referenceDetail.trim()}。` : "不得把特殊袋口、领型或连接结构简化成普通形状。"}` : "每款都继承参考面料的色彩与纹理身份，随衣片和褶皱自然变化；不推断克重、弹性等实测物性。",
                boardInstruction(form, "款设计"), presentationInstruction(form), extra,
                "仅输出单张服装概念方案板，不是独立款式文件、纸样或生产技术稿。",
            ];
            break;
        }
        case "reference-to-style": {
            const direction = form.referenceMode === "category" ? `改品类：转为${form.category}，保留参考的材料、配色和关键设计语言。`
                : form.referenceMode === "style" ? `改风格：目标风格为${form.targetStyle.trim()}，保留原品类与明确未指定改变的结构。`
                    : form.referenceMode === "detail" ? `改部件：${form.referenceDetail.trim()}。其他部件保持原有关系。`
                        : `自定义改款：${description}`;
            lines = ["任务：图片1是服装基款，只执行指定方向的参考改款。", direction,
                form.preserve.trim() ? `必须保留：${form.preserve.trim()}` : "保留未指定修改的面料、配色、展示角度和关键辅料；不要同时擅改全部设计。",
                form.referenceMode === "custom" ? "" : extra, "完整展示一款服装，不拼图；没有选区时不承诺区外逐像素相同。", concept];
            break;
        }
        case "style-fusion":
        case "pattern-fusion": {
            const pattern = sceneId === "pattern-fusion";
            lines = [pattern ? "任务：融合参考图案的不同设计要素，形成一个完整、协调的平面图案。" : `任务：将两款参考的不同要素融合为一款${form.category === "按描述判断" ? "服装" : form.category}，不是叠加两件成衣。`,
                `图片1负责：${form.fusionRole1.trim()}。图片2负责：${form.fusionRole2.trim()}。两个角色不能互换。`,
                `参考侧重：图一 ${form.fusionWeight}%，图二 ${100 - form.fusionWeight}%；这是设计偏好的提示侧重，不是像素混合或模型参数。仍须同时体现两图指定要素。`,
                pattern && form.referenceCount === 3 ? "图片3只提供配色关系，不复制它的主体、文字或构图。" : "",
                form.preserve.trim() ? `必须保留：${form.preserve.trim()}` : "保留被指定继承的元素身份，避免重复残影、不合理拼接或无关背景。",
                pattern ? patternBackgroundInstruction(form) : presentationInstruction(form), extra, concept];
            break;
        }
        case "outfit-design":
            lines = ["任务：图片1是已有服装单品，保留它并设计一件协调的搭配单品，展示完整套装。",
                `搭配目标为${form.outfitCategory} > ${form.outfitSubcategory}，这是父子品类关系，只新增对应子类单品，不把两个字段理解为两件衣服。`,
                "保留已有单品的廓形、图案、配色和面料身份；新增单品在色彩、材料与比例上协调，不用新单品替换原件。",
                presentationInstruction(form), extra, concept];
            break;
        case "apply-pattern":
        case "pattern-fill": {
            const fill = sceneId === "pattern-fill";
            lines = ["图片1是服装原图，决定全部服装结构、人物、光影与背景；图片2仅提供图案，不提供服装、模特或场景。",
                fill ? `任务：将图片2花型重复铺设在以下衣片：${form.placement.trim()}。重复尺度约为参考的一般视觉尺度的 ${form.patternScale} 倍，方向：${form.patternDirection}。` : `任务：将图片2作为一处完整定位图案，放在${form.placement.trim()}。视觉大小系数 ${form.patternScale} 倍，方向：${form.patternDirection}；不要擅自改为满幅铺花。`,
                "保留图案元素、文字、轮廓和相对比例，不美化重画；按服装的透视、褶皱与遮挡贴合。目标衣片之外保留原款，不把图案印到皮肤、背景或无关配件。",
                fill ? "输入花型应已具备适合重复的结构；本任务是服装上的铺设预览，不宣称自动修复无缝接缝。" : "若需要精确保留图案像素、位置或尺寸，应使用本地图案定位；本次是 AI 概念贴合。", extra, concept];
            break;
        }
        case "fabric-change":
            lines = ["任务：图片1是原服装，保持它的廓形、裁片、领袖、门襟、辅料、人物与展示角度，仅更换指定衣片的材料。",
                `其后的${form.fabricCount}张图片分别是面料1至面料${form.fabricCount}，只提供纹理、颜色、光泽和表面观感，不复制其中的服装或背景。`,
                form.fabricAssignment.trim() ? `面料分配：${form.fabricAssignment.trim()}` : "面料分配：图片2用于服装的主体面料区域，原辅料保持不变。",
                `纹理视觉比例：${form.patternScale} 倍；方向：${form.patternDirection}。面料随各衣片的光影、褶皱与遮挡自然贴合。`,
                "不要把不同面料平均混成一种纹理；每种材料只出现在对应衣片。纹理比例为视觉参考，不是物理尺寸或3D材料仿真。", extra, concept];
            break;
        case "remove-decoration":
            lines = ["任务：图片1是服装原图，去除指定印花、刺绣或表面装饰，并以周围同类面料修复底布。",
                form.removeMode === "white" ? "底色模式：变为白色。目标服装面料改为干净白色，保留衣褶、明暗、缝线和结构层次，不把整图涂白。" : "底色模式：保留原色。维持原服装底色、面料织纹与自然光影，只清除目标装饰。",
                "不删除口袋、纽扣、门襟、真实结构线或未指定移除的配件；修复区域与周围布纹连续。", extra, concept];
            break;
        case "sketch-to-style":
            lines = ["任务：图片1是服装线稿，严格使用其可见廓形、长短比例、领袖形状、分割线、口袋、门襟和辅料位置，生成真实材质的服装效果。",
                form.useFabricReference ? "图片2只提供面料纹理、配色与光泽，不借用它的服装结构；线稿始终决定版型。" : `面料方向：${form.fabric.trim() || "依据补充描述，保持清晰且合理的服装材质"}。`,
                form.sketchColor === "reference" ? "颜色方式：沿用线稿已给出的颜色；黑白线稿没有确定颜色时，按面料或补充描述配色，不把黑色线条当装饰。" : "颜色方式：在不改变线稿结构的前提下设计协调的新配色。",
                presentationInstruction(form), extra, "仅将线稿转为服装概念效果，不推断不可见结构、纸样尺寸或生产技术数据。"];
            break;
        case "pattern-create":
            lines = [form.patternMode === "text" ? `任务：按以下文字创作独立图案。图案要求：${description}`
                : form.patternMode === "variation" ? `任务：图片1为相似变体参考。保留约 ${form.similarity}% 的视觉语言与识别要素，在剩余部分变化局部元素或构图；百分比是设计方向，不是可计算相似度。`
                    : "任务：图片1提供图案参考，提取指定的元素、构图或风格，创作新的独立图案。",
                form.patternMode === "text" ? "" : extra, patternBackgroundInstruction(form),
                "图案本体完整、边界清晰，文字只有在明确要求时才出现；不擅自加品牌、说明标签、水印或多联拼图。输出为栅格概念图片，不是 SVG 或生产制版文件。"];
            break;
        case "seamless-pattern":
            lines = ["任务：图片1是原始花型，生成可供后续实际平铺检查的连续花型草案，不输出拼接预览大图。",
                `目标排列：${form.repeatArrangement === "straight" ? "直排，左右和上下同位相接" : form.repeatArrangement === "half-drop" ? "半落，左右相邻单元沿纵向错开半个周期" : "半砖，前后相邻行沿横向错开半个周期"}。`,
                `边界方式：${form.boundaryMode === "inward" ? "向内修复，在原有画幅边缘范围内调整，保留中央主体" : "向外扩展，延伸边缘背景和必要元素，保护原图主要内容"}。左右边界调整范围 ${form.ratioX}%，上下边界调整范围 ${form.ratioY}%。`,
                "保持图案元素、配色、大小节奏；处理跨边元素和四角衔接，不加边框、切割线或重复接缝带。", extra,
                "本次只输出单张栅格花型草案。是否无缝必须在花型循环工具中按真实排列检查，模型描述不能保证无缝或直接生产。"];
            break;
        case "sketch-vectorization":
        case "pattern-vectorization":
        case "pattern-layers":
            return "";
        case "text-to-style":
            lines = [
                "任务：根据以下要求，创作一款完整的服装设计。",
                `款式描述：${description}`,
                `服装品类：${form.category}；廓形：${form.silhouette}。选择“按描述判断”的项目以款式描述为依据，不擅自加入无关设计。`,
                form.fabric.trim() ? `面料方向：${form.fabric.trim()}。清晰表现相应的纹理、厚薄与垂感。` : "面料依款式描述选择，保持材质、结构与服装比例协调。",
                form.presentation === "白底平铺" ? "展示方式：白底平铺。单款正面居中、完整展示，保留自然但克制的阴影，无人物、衣架或道具。"
                    : form.presentation === "模特展示" ? "展示方式：模特展示。单款服装为主体，完整展示主要廓形，背景简洁，人物姿态自然，不添加遮挡服装的道具。"
                        : "展示方式：设计效果图。单款服装、简洁背景，突出廓形、面料与设计细节，不添加无关构图。",
                concept,
            ];
            break;
        case "style-to-sketch":
            lines = [
                "任务：图片1是服装参考图，将其中实际可见的服装整理为清晰的线稿图片。",
                form.sketchStyle === "minimal" ? "线条风格：极简线稿。用干净、克制的轮廓线表达服装，不保留摄影光影与面料色块。"
                    : "线条风格：技术感线稿。用清晰、均匀的线条表达服装轮廓和可见结构，主轮廓与结构线层次分明。",
                form.sketchDetail === "outline" ? "细节程度：仅主要轮廓与关键结构，不描绘细碎纹理或装饰。"
                    : form.sketchDetail === "detailed" ? "细节程度：保留实际可见的分割线、口袋、褶裥、门襟、纽扣和装饰细节，避免虚构细节。"
                        : "细节程度：保留领口、袖口、下摆、门襟与主要结构线，适度简化细小纹理。",
                "保留图片1原有视角、廓形和比例，移除摄影背景与光影；不增加看不见的结构，不标注推测的尺寸。",
                extra,
                "输出为白底线稿概念栅格图片，不是可编辑 SVG、矢量文件、纸样或生产技术稿。",
            ];
            break;
        case "local-restyle":
            lines = [
                "任务：图片1是服装主图，仅按下述要求进行局部改款。",
                `修改部位：${form.restyleArea === "其他" ? "以下改动要求明确涉及的部位" : form.restyleArea}。`,
                `具体改动：${form.change.trim()}`,
                "保留本次未指定修改区域的整体廓形、肩宽、衣长、袖长、面料组织、原有配色、图案布局、光影和拍摄角度。修改处与周围材质、结构自然衔接；涉及删除时用邻近同材质补齐。",
                form.preserve.trim() ? `额外保留要求：${form.preserve.trim()}` : "",
                extra,
                "上述部位与保留项是文字编辑约束，不是像素蒙版，不承诺未修改区域逐像素不变。",
                concept,
            ];
            break;
        case "garment-colorway":
        case "pattern-colorway": {
            const garment = sceneId === "garment-colorway";
            lines = [
                `任务：图片1是${garment ? "服装主图" : "图案主图"}，只调整颜色，输出一套配色效果。`,
                colorDirection(form, garment),
                `改色范围：${form.colorRegion.trim() || (garment ? "服装主体的现有色块区域" : "图案及其现有底色区域")}。范围之外的颜色保持原样。`,
                garment
                    ? "保留图片1服装的版型、肩宽、衣长、袖长、领口、门襟、口袋、下摆、图案形状及位置、针织或面料纹理、明暗层次、光影与背景。保持原有人像身份、肤色、头发、姿态、配饰、拍摄视角与构图不变。颜色自然融入织纹和褶皱，保留高光、阴影与材质质感，不变成平面色块。"
                    : "保留图片1图案的元素形状、线条粗细、大小比例、色块边界、排列关系、条纹宽窄和重复节奏；只改变指定颜色，不新增或删减图案，不扭曲文字和轮廓。",
                extra,
                garment ? "照片换色由 AI 根据目标颜色与原图光照生成近似视觉效果，同一面料的高光和阴影应有自然色阶；HEX 与标准色号用于描述目标方向，不要求每个像素等于该 HEX，不是物理染色模拟。" : "",
                "色名、HEX 色值与参考图只提供近似视觉方向，不保证精确色值、标准色号还原或实物色差。输出为单张概念配色图片，不绘制多联拼图或色卡，不是生产色稿。",
            ];
            break;
        }
        case "back-design":
            lines = [
                "任务：图片1是服装正面参考图，依据正面设计构思一款协调的背面。",
                `背面结构方向：${form.backStructure}。${form.backStructure === "自由描述" ? "具体结构以下方补充要求为准。" : form.backStructure === "育克" ? "在后肩加入与原款比例协调的育克分割。" : form.backStructure === "中缝" ? "用克制的后中结构线组织背面，不擅自添加拉链或开衩。" : "保持背面干净，以自然的面料与廓形为主。"}`,
                form.backMotif === "延续风格" ? "背面图案：延续图片1的主题、配色关系和工艺风格，重新安排适合背面的图案布局，不把正面图案一比一搬到背面。"
                    : "背面图案：不延续正面图案或装饰，背面保持素净。",
                "沿用图片1的服装品类、整体廓形、长度、肩袖比例、面料观感与配色，展示单款完整背面效果。",
                extra,
                "不可见的背面结构属于设计推演，不宣称还原原款真实背面，不推断内部工艺或纸样尺寸。",
                concept,
            ];
            break;
        case "pattern-extract":
            lines = [
                "任务：图片1是图案来源图，整理其中实际可见的花型元素。",
                form.extractMode === "完整可见花型" ? "提取范围：完整可见花型。保留画面内可见元素的相对位置、比例与排列关系，整理为平面花型图片，不自行补成无缝循环。"
                    : "提取范围：单独图案。选取画面中主要的完整图案元素，整理为独立居中的平面图案；如有补充指定，以指定元素为准。",
                form.extractBackground === "保留底色" ? "背景处理：保留图案自身的原有底色，但移除无关摄影场景、衣服轮廓和道具。"
                    : "背景处理：白底。将图案放在干净白色背景上，不要求透明通道，不改变图案内部白色细节。",
                "尽量保留实际可见元素的轮廓、配色、线条与相对关系，减弱服装褶皱、透视和摄影光影的干扰。不要把遮挡或缺失区域当作已知原稿。",
                form.extractCraft === "remove" ? "工艺处理：去除绣线、织纹或胶印厚度等表面工艺观感，还原为干净平面色块与线条，不改变图形。" : "工艺处理：保留可见的刺绣、织纹或印花工艺观感，不主动改成另一种工艺。",
                extra,
                "输出为平面图案概念栅格图片，不保证原稿完整还原、文字精确复刻、矢量化、无缝循环或直接印花生产，不添加无关元素。",
            ];
            break;
        case "pattern-craft":
            lines = [
                "任务：图片1是图案主图，将同一图案模拟为指定工艺的视觉效果。",
                `目标工艺：${form.craft}。${craftTextures[form.craft] ?? "表现该工艺对应的表面肌理与边缘收口。"}`,
                `承载面料：${form.craftFabric}。保持底布纹理与工艺之间自然贴合，合理表现凹凸、受光与材质差异。`,
                form.craftSource === "reference" ? "图片2仅提供工艺参考：借用其针迹、肌理、厚度、受光和收边，不复制图片2的图案、文字、配色或构图；图片1始终决定图案身份。" : "",
                "保留图片1图案的元素、轮廓、颜色关系、大小比例与构图，不擅自重画图案或增加装饰。仅改变工艺与承载面料的视觉质感。",
                extra,
                "输出为单张工艺概念效果图片；不是绣花针迹文件、提花组织图、生产工艺单或可直接生产的文件，不承诺真实工艺可行性。",
            ];
            break;
        case "accessory-design":
            lines = [
                "任务：图片1是辅料主图，提供辅料结构、材质与连接方式；图片2是图案参考图，仅提供要应用的图案或造型元素。",
                `辅料类型：${form.accessoryType}。围绕图片1的辅料进行设计，不把图片2当作辅料替换图片1。`,
                form.accessoryApply === "仅表面纹样" ? "应用方式：仅表面纹样。将图片2图案应用到图片1辅料表面，保留图片1整体外形、厚度、孔位、连接结构与材质。"
                    : "应用方式：形状与纹样。参考图片2的主要图形重新构思图片1辅料的外轮廓及表面纹样，保留必要的孔位或连接方式与原有材质观感，不照搬图片2背景。",
                "保持图片2主要图案的识别度、清晰轮廓与颜色关系，图案自然贴合辅料表面，不带入图片2的服装、人物、背景或无关物件。单个辅料完整居中，背景干净。",
                extra,
                "输出为辅料设计概念效果图片，不推断准确尺寸、内部结构或连接强度，不代表开模图或可直接生产的文件。",
            ];
            break;
        default:
            return "";
    }
    return lines.filter(Boolean).join("\n\n");
}
