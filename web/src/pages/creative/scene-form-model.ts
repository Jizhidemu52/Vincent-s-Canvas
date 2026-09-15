import type { ReferenceImage } from "@/types/image";

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
        limit: "输出为栅格图片，不是可编辑 SVG；不推断不可见结构或尺寸。",
    },
    "local-restyle": {
        input: "原款衬衫",
        output: "领口改款",
        example: "将衬衫普通翻领改为柔和的荷叶领，保留原有衣身、袖型、面料与配色。",
        limit: "部位与保留要求通过文字约束，不是蒙版编辑，无法保证其余像素完全不变。",
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
        limit: "配色为近似效果，图案仍需人工核对，不能直接作为生产色稿。",
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

function colorDirection(form: SceneForm): string {
    if (form.colorMode === "reference") {
        return "图片2是配色参考图，仅提取其中的主要色彩及搭配关系，应用到图片1；不复制图片2的图案、款式、材质、人物或背景。";
    }
    if (form.colorMode === "specific") {
        return `目标色板：${form.colors.map((color) => color.trim().toUpperCase()).join("、")}。在指定改色区域内使用这 ${form.colors.length} 种目标颜色，结合明暗与材质自然分配，不把色板绘制到成图中。`;
    }
    return `智能配色方向：${form.colorMood}。依据图片1的原有色块关系与主体特征，设计一套协调且有区别的配色。`;
}

const craftTextures: Record<string, string> = {
    "刺绣": "表现清晰针迹方向、独立绣线纤维、轻微凸起与整洁收边，不做成平面印花或贴纸。",
    "毛巾绣": "表现密集立体毛圈、柔软绒感、厚度起伏和清晰外轮廓，不做成光滑塑料或普通平绣。",
    "提花": "表现图案由经纬或针织纱线交织形成的组织关系、连续织纹与纱线颗粒，不表现为表面贴上的印花。",
    "胶印": "表现覆盖于面料表面的柔韧胶质色层、干净边缘与克制的光泽，保留底布质感，不画成刺绣线迹。",
};

export function buildScenePrompt(sceneId: string, form: SceneForm): string {
    if (!Object.hasOwn(sceneSummaries, sceneId)) return "";
    const description = form.description.trim();
    const extra = description ? `补充设计要求：${description}` : "";
    const concept = "输出为单张清晰的概念效果图片，不添加无关文字、品牌或水印；不是纸样或可直接生产的技术稿。";
    let lines: string[];
    switch (sceneId) {
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
                colorDirection(form),
                `改色范围：${form.colorRegion.trim() || (garment ? "服装主体的现有色块区域" : "图案及其现有底色区域")}。范围之外的颜色保持原样。`,
                garment
                    ? "保留图片1服装的版型、肩宽、衣长、袖长、领口、门襟、口袋、下摆、图案形状及位置、针织或面料纹理、明暗层次、光影与背景。颜色自然融入织纹和褶皱，不变成平面色块。"
                    : "保留图片1图案的元素形状、线条粗细、大小比例、色块边界、排列关系、条纹宽窄和重复节奏；只改变指定颜色，不新增或删减图案，不扭曲文字和轮廓。",
                extra,
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
                extra,
                "输出为平面图案概念栅格图片，不保证原稿完整还原、文字精确复刻、矢量化、无缝循环或直接印花生产，不添加无关元素。",
            ];
            break;
        case "pattern-craft":
            lines = [
                "任务：图片1是图案主图，将同一图案模拟为指定工艺的视觉效果。",
                `目标工艺：${form.craft}。${craftTextures[form.craft] ?? "表现该工艺对应的表面肌理与边缘收口。"}`,
                `承载面料：${form.craftFabric}。保持底布纹理与工艺之间自然贴合，合理表现凹凸、受光与材质差异。`,
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
