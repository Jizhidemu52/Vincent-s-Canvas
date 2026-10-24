import type { ReferenceImage } from "@/types/image";
import type { StandardColorSelection } from "@/lib/standard-colors";

export type SceneSlotId = "primary" | "secondary";
export type SceneSlot = { id: SceneSlotId; label: string; hint: string; required: boolean };

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
};

export function createSceneForm(_sceneId: string): SceneForm {
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
    };
}

export const sceneSummaries: Record<string, { input: string; output: string; example: string; limit: string }> = {
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
    for (const slot of getSceneSlots(sceneId, form)) {
        if (slot.required && !images[slot.id]) return `请上传${slot.label}。`;
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

/** Public form values only; the server owns all scene authoring rules. */
export function scenePromptInput(sceneId: string, form: SceneForm): import("../../../../shared/prompt-contracts").PromptInputData {
    if (!Object.hasOwn(sceneSummaries, sceneId)) throw new Error("暂不支持这个设计场景。");
    const keys: Record<string, Array<keyof SceneForm>> = {
        "text-to-style": ["category", "silhouette", "fabric", "presentation"],
        "style-to-sketch": ["sketchStyle", "sketchDetail"],
        "local-restyle": ["restyleArea", "change", "preserve"],
        "garment-colorway": ["colorMode", "colorRegion", ...(form.colorMode === "specific" ? ["colors", "colorSelections"] as const : form.colorMode === "smart" ? ["colorMood"] as const : [])],
        "pattern-colorway": ["colorMode", "colorRegion", ...(form.colorMode === "specific" ? ["colors", "colorSelections"] as const : form.colorMode === "smart" ? ["colorMood"] as const : [])],
        "back-design": ["backStructure", "backMotif"],
        "pattern-extract": ["extractMode", "extractBackground"],
        "pattern-craft": ["craft", "craftFabric"],
        "accessory-design": ["accessoryType", "accessoryApply"],
    };
    const frozen = cloneSceneForm(form);
    const fields = Object.fromEntries(["description", ...keys[sceneId]!].map(key => [key, frozen[key as keyof SceneForm]]));
    return { scene: sceneId as import("../../../../shared/prompt-contracts").PromptScene, fields,
        userText: [form.description.trim(), sceneId === "local-restyle" ? form.change.trim() : ""].filter(Boolean).join("\n"),
        referenceRoles: getSceneSlots(sceneId, form).map(slot => slot.label), mode: sceneId === "text-to-style" ? "generate" : "edit" };
}
