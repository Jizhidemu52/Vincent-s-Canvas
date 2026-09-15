import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SceneFields, SceneUploads } from "@/pages/creative/scene-form";
import { buildScenePrompt, createSceneForm, getSceneSlots, sceneSummaries, validateSceneForm, type SceneForm } from "@/pages/creative/scene-form-model";
import type { ReferenceImage } from "@/types/image";

const primary: ReferenceImage = { id: "main", name: "主体.png", type: "image/png", dataUrl: "data:image/png;base64,cHJpbWFyeQ==" };
const secondary: ReferenceImage = { id: "reference", name: "参考.png", type: "image/png", dataUrl: "data:image/png;base64,c2Vjb25kYXJ5" };
const images = { primary, secondary };
const sceneIds = ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "pattern-craft", "accessory-design"];

function formFor(sceneId: string, patch: Partial<SceneForm> = {}): SceneForm {
    return { ...createSceneForm(sceneId), ...patch };
}

function fields(sceneId: string, patch: Partial<SceneForm> = {}, disabled = false): string {
    return renderToStaticMarkup(createElement(SceneFields, { sceneId, form: formFor(sceneId, patch), disabled, onChange: () => { throw new Error("Rendering must not mutate the form"); } }));
}

describe("creative scene input roles", () => {
    test("offers nine scene summaries and independent editable defaults", () => {
        expect(Object.keys(sceneSummaries)).toEqual(sceneIds);
        const original = createSceneForm("garment-colorway");
        original.colors.push("#FFFFFF");
        expect(createSceneForm("garment-colorway").colors).toHaveLength(3);
        for (const summary of Object.values(sceneSummaries)) {
            expect(summary.input.length).toBeLessThanOrEqual(10);
            expect(summary.output.length).toBeLessThanOrEqual(10);
            expect(summary.example.trim().length).toBeGreaterThan(10);
            expect(summary.limit.trim().length).toBeGreaterThan(10);
        }
    });

    test("text-to-style needs a description but no image", () => {
        const form = formFor("text-to-style");
        expect(getSceneSlots("text-to-style", form)).toEqual([]);
        expect(validateSceneForm("text-to-style", form, {})).toContain("款式");
        expect(validateSceneForm("text-to-style", { ...form, description: "  " }, {})).toContain("款式");
        expect(validateSceneForm("text-to-style", { ...form, description: "微宽松衬衫" }, {})).toBeNull();
    });

    test.each(sceneIds.filter((id) => id !== "text-to-style"))("%s requires its primary role even if a secondary image exists", (sceneId) => {
        const form = formFor(sceneId, { change: "改为荷叶领" });
        const slots = getSceneSlots(sceneId, form);
        expect(slots[0]!.id).toBe("primary");
        expect(validateSceneForm(sceneId, form, { secondary })).toBe(`请上传${slots[0]!.label}。`);
    });

    test("the accessory scene always requires two distinct fixed roles", () => {
        const form = formFor("accessory-design");
        expect(getSceneSlots("accessory-design", form).map(({ id, label, required }) => ({ id, label, required }))).toEqual([
            { id: "primary", label: "辅料图", required: true },
            { id: "secondary", label: "图案图", required: true },
        ]);
        expect(validateSceneForm("accessory-design", form, { primary })).toBe("请上传图案图。");
        expect(validateSceneForm("accessory-design", form, images)).toBeNull();
        const prompt = buildScenePrompt("accessory-design", form);
        expect(prompt).toContain("图片1是辅料主图");
        expect(prompt).toContain("图片2是图案参考图");
        expect(prompt).toContain("不把图片2当作辅料替换图片1");
        expect(prompt).toContain("孔位或连接方式");
    });

    test.each(["garment-colorway", "pattern-colorway"])("%s requests a second image only in reference mode", (sceneId) => {
        const reference = formFor(sceneId, { colorMode: "reference" });
        expect(getSceneSlots(sceneId, reference).map((slot) => slot.id)).toEqual(["primary", "secondary"]);
        expect(validateSceneForm(sceneId, reference, { primary })).toBe("请上传配色参考图。");
        expect(validateSceneForm(sceneId, reference, images)).toBeNull();
        expect(buildScenePrompt(sceneId, reference)).toContain("图片2是配色参考图");
        expect(buildScenePrompt(sceneId, reference)).toContain("不复制图片2的图案、款式、材质、人物或背景");
        for (const colorMode of ["smart", "specific"] as const) {
            const form = { ...reference, colorMode };
            expect(getSceneSlots(sceneId, form).map((slot) => slot.id)).toEqual(["primary"]);
            expect(validateSceneForm(sceneId, form, { primary })).toBeNull();
            expect(buildScenePrompt(sceneId, form)).not.toContain("图片2");
        }
    });

    test("changing the scene cannot silently create a generic prompt task", () => {
        for (const sceneId of ["unknown", "constructor", "__proto__"]) {
            const form = createSceneForm(sceneId);
            expect(validateSceneForm(sceneId, form, images)).toContain("暂不支持");
            expect(getSceneSlots(sceneId, form)).toEqual([]);
            expect(buildScenePrompt(sceneId, form)).toBe("");
        }
    });
});

describe("specialized creative prompt controls", () => {
    test("text-to-style binds all dedicated garment controls", () => {
        const form = formFor("text-to-style", { description: "奶油色衬衫", category: "上衣", silhouette: "微宽松", fabric: "轻薄棉麻", presentation: "模特展示" });
        const prompt = buildScenePrompt("text-to-style", form);
        for (const value of ["奶油色衬衫", "上衣", "微宽松", "轻薄棉麻", "模特展示"]) expect(prompt).toContain(value);
        expect(prompt).not.toContain("无人物");
        expect(prompt).not.toContain("图片1");
    });

    test("sketch controls alter line style and visible detail without promising SVG", () => {
        const simple = buildScenePrompt("style-to-sketch", formFor("style-to-sketch", { sketchStyle: "minimal", sketchDetail: "outline" }));
        const technical = buildScenePrompt("style-to-sketch", formFor("style-to-sketch", { sketchStyle: "technical", sketchDetail: "detailed" }));
        expect(simple).toContain("极简线稿");
        expect(simple).toContain("仅主要轮廓");
        expect(technical).toContain("技术感线稿");
        expect(technical).toContain("分割线、口袋、褶裥");
        for (const prompt of [simple, technical]) {
            expect(prompt).toContain("栅格图片，不是可编辑 SVG");
            expect(prompt).toContain("不增加看不见的结构");
            expect(prompt).toContain("不标注推测的尺寸");
        }
    });

    test("local restyling requires a real change and binds scope and preservation", () => {
        const form = formFor("local-restyle", { restyleArea: "袖子", change: " 改为轻微喇叭袖 ", preserve: "胸口花朵保持原样" });
        expect(validateSceneForm("local-restyle", { ...form, change: " " }, images)).toContain("改成什么");
        expect(validateSceneForm("local-restyle", form, images)).toBeNull();
        const prompt = buildScenePrompt("local-restyle", form);
        for (const value of ["修改部位：袖子", "改为轻微喇叭袖", "胸口花朵保持原样", "面料组织", "原有配色", "不是像素蒙版"]) expect(prompt).toContain(value);
    });

    test.each(["garment-colorway", "pattern-colorway"])("%s validates the editable HEX palette and ignores hidden obsolete values", (sceneId) => {
        const form = formFor(sceneId, { colorMode: "specific", colors: ["#abc", "#11aaBB"], colorRegion: "指定色块", colorMood: "HIDDEN_MOOD" });
        expect(validateSceneForm(sceneId, form, images)).toBeNull();
        const prompt = buildScenePrompt(sceneId, form);
        expect(prompt).toContain("#ABC、#11AABB");
        expect(prompt).toContain("指定色块");
        expect(prompt).not.toContain("HIDDEN_MOOD");
        expect(prompt).toContain("不保证精确色值");
        for (const color of ["red", "123456", "#12", "#12345G", "#12345678", "", "var(--red)"]) {
            expect(validateSceneForm(sceneId, { ...form, colors: [color] }, images)).toContain("色值无效");
        }
        expect(validateSceneForm(sceneId, { ...form, colors: [] }, images)).toContain("至少添加");
        expect(validateSceneForm(sceneId, { ...form, colors: Array(7).fill("#FFFFFF") }, images)).toContain("最多使用 6");
        expect(validateSceneForm(sceneId, { ...form, colorMode: "smart", colors: ["not-a-color"] }, images)).toBeNull();
        const smart = buildScenePrompt(sceneId, { ...form, colorMode: "smart", colorMood: "强烈对比", colors: ["HIDDEN_COLOR"] });
        expect(smart).toContain("智能配色方向：强烈对比");
        expect(smart).not.toContain("HIDDEN_COLOR");
        expect(buildScenePrompt(sceneId, { ...form, colorMode: "reference" })).not.toContain("#ABC");
    });

    test("clothing colors preserve material while pattern colors preserve geometry", () => {
        const garment = buildScenePrompt("garment-colorway", formFor("garment-colorway"));
        const pattern = buildScenePrompt("pattern-colorway", formFor("pattern-colorway"));
        for (const term of ["面料纹理", "明暗层次", "光影与背景", "肩宽", "袖长"]) expect(garment).toContain(term);
        for (const term of ["元素形状", "线条粗细", "大小比例", "色块边界", "排列关系", "条纹宽窄", "重复节奏"]) expect(pattern).toContain(term);
    });

    test("back design binds structural and motif choices without claiming restoration", () => {
        const form = formFor("back-design", { backStructure: "育克", backMotif: "延续风格" });
        const prompt = buildScenePrompt("back-design", form);
        expect(prompt).toContain("后肩加入");
        expect(prompt).toContain("重新安排适合背面");
        expect(prompt).toContain("不宣称还原原款真实背面");
        expect(buildScenePrompt("back-design", { ...form, backStructure: "中缝", backMotif: "不延续" })).toContain("不延续正面图案或装饰");
        expect(validateSceneForm("back-design", { ...form, backStructure: "自由描述" }, images)).toContain("补充");
        expect(validateSceneForm("back-design", { ...form, backStructure: "自由描述", description: "后中添加褶裥" }, images)).toBeNull();
    });

    test("extraction binds range and background and does not invent missing artwork", () => {
        const form = formFor("pattern-extract", { extractMode: "完整可见花型", extractBackground: "保留底色" });
        const prompt = buildScenePrompt("pattern-extract", form);
        expect(prompt).toContain("提取范围：完整可见花型");
        expect(prompt).toContain("保留图案自身的原有底色");
        expect(prompt).toContain("不要把遮挡或缺失区域当作已知原稿");
        expect(prompt).toContain("不自行补成无缝循环");
        expect(buildScenePrompt("pattern-extract", formFor("pattern-extract"))).toContain("背景处理：白底");
    });

    test("each craft binds its real visual texture and substrate without promising production data", () => {
        for (const [craft, texture] of [["刺绣", "针迹方向"], ["毛巾绣", "立体毛圈"], ["提花", "纱线交织"], ["胶印", "柔韧胶质色层"]]) {
            const prompt = buildScenePrompt("pattern-craft", formFor("pattern-craft", { craft, craftFabric: "牛仔布" }));
            expect(prompt).toContain(`目标工艺：${craft}`);
            expect(prompt).toContain(texture);
            expect(prompt).toContain("承载面料：牛仔布");
            expect(prompt).toContain("不是绣花针迹文件");
            expect(prompt).toContain("不承诺真实工艺可行性");
        }
    });

    test("accessory surface-only mode locks shape rather than asking to redesign it", () => {
        const prompt = buildScenePrompt("accessory-design", formFor("accessory-design", { accessoryType: "织标", accessoryApply: "仅表面纹样" }));
        expect(prompt).toContain("辅料类型：织标");
        expect(prompt).toContain("应用方式：仅表面纹样");
        expect(prompt).toContain("保留图片1整体外形");
        expect(prompt).not.toContain("重新构思");
    });
});

describe("specialized form presentation", () => {
    test("every scene exposes its own labeled controls and not a generic prompt editor", () => {
        const labels = [
            ["text-to-style", "款式描述", "服装品类", "面料方向", "廓形", "展示方式"],
            ["style-to-sketch", "线条风格", "细节程度", "技术感线稿", "极简线稿"],
            ["local-restyle", "改动部位", "要改成什么样", "特别要保留的细节", "口袋"],
            ["garment-colorway", "配色方式", "配色方向", "改色区域"],
            ["back-design", "背面结构方向", "正面图案如何处理"],
            ["pattern-extract", "提取范围", "背景处理"],
            ["pattern-colorway", "配色方式", "配色方向", "改色区域"],
            ["pattern-craft", "目标工艺", "承载面料", "毛巾绣"],
            ["accessory-design", "辅料类型", "图案应用方式", "仅表面纹样"],
        ];
        for (const [sceneId, ...expected] of labels) {
            const markup = fields(sceneId!);
            for (const label of expected) expect(markup).toContain(label!);
            expect(markup).not.toContain("ant-select");
            expect(markup).not.toContain("完整提示词");
            if (sceneId !== "text-to-style") expect(markup).toContain("<details");
        }
    });

    test("palette mode provides editable HEX, remove and bounded add controls", () => {
        const markup = fields("pattern-colorway", { colorMode: "specific", colors: ["#123456", "invalid"] });
        expect(markup).toContain('type="color"');
        expect(markup).toContain('aria-label="颜色 1 HEX 色值"');
        expect(markup).toContain('aria-invalid="true"');
        expect(markup).toContain('aria-label="删除颜色 2"');
        expect(markup).toContain("添加颜色");
        expect(markup).not.toContain("配色方向</legend>");
        const sixColors = fields("pattern-colorway", { colorMode: "specific", colors: Array(6).fill("#123456") });
        expect(sixColors).toMatch(/class="cs-add-color" disabled=""/);
    });

    test("freeform back structure exposes its required field instead of a collapsed optional note", () => {
        const markup = fields("back-design", { backStructure: "自由描述" });
        expect(markup).toContain("背面结构要求");
        expect(markup).toMatch(/<textarea[^>]*required=""/);
        expect(markup).not.toContain("<details");
    });

    test("generation disables all mutable fields", () => {
        for (const sceneId of sceneIds) {
            const markup = fields(sceneId, { colorMode: "specific" }, true);
            const controls = markup.match(/<(?:input|textarea|select|button)\b[^>]*>/g) ?? [];
            expect(controls.length).toBeGreaterThan(0);
            expect(controls.every((control) => control.includes('disabled=""'))).toBe(true);
        }
    });

    test("two-role uploads have distinct accessible targets, previews and remove controls", () => {
        const slots = getSceneSlots("accessory-design", formFor("accessory-design"));
        const render = (disabled: boolean) => renderToStaticMarkup(createElement(SceneUploads, { slots, images, disabled, onImage: () => { throw new Error("Rendering must not upload"); } }));
        const markup = render(false);
        expect(markup.match(/type="file"/g)).toHaveLength(2);
        expect(markup).toContain('aria-label="上传辅料图"');
        expect(markup).toContain('aria-label="上传图案图"');
        expect(markup).toContain('src="data:image/png;base64,cHJpbWFyeQ=="');
        expect(markup).toContain('aria-label="移除图案图"');
        const controls = render(true).match(/<(?:input|button)\b[^>]*>/g) ?? [];
        expect(controls.every((control) => control.includes('disabled=""'))).toBe(true);
    });
});
