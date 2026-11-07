import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getCreativePreset } from "@/lib/creative-presets";
import { designExampleForScene } from "@/lib/design-examples";
import { setUiLocale } from "@/lib/i18n";
import { createSceneForm, cloneSceneForm, getSceneSlots, scenePromptInput, supportsSceneProductTarget, validateSceneForm } from "@/pages/creative/scene-form-model";
import { SceneFields, SceneUploads } from "@/pages/creative/scene-form";
import type { ReferenceImage } from "@/types/image";

const primary: ReferenceImage = { id: "primary", name: "product.png", type: "image/png", dataUrl: "data:image/png;base64,cHJpbWFyeQ==" };
const secondary: ReferenceImage = { id: "secondary", name: "model.png", type: "image/png", dataUrl: "data:image/png;base64,c2Vjb25kYXJ5" };
afterEach(async () => { await setUiLocale("zh-CN"); });

test("product extraction has one managed entry and is not duplicated as a creative form", () => {
    expect(getCreativePreset("item-extract")).toBeUndefined();
    expect(validateSceneForm("item-extract", createSceneForm("item-extract"), { primary })).toContain("暂不支持");
    expect(getSceneSlots("item-extract", createSceneForm("item-extract"))).toEqual([]);
});

test("try-on requires a product plus either an optional model image or explicit adult-model requirements", () => {
    const form = createSceneForm("virtual-try-on");
    expect(validateSceneForm("virtual-try-on", form, {})).toBe("请上传产品图。");
    expect(validateSceneForm("virtual-try-on", form, { secondary })).toBe("请上传产品图。");
    expect(validateSceneForm("virtual-try-on", form, { primary })).toContain("成人模特");
    expect(validateSceneForm("virtual-try-on", { ...form, description: "短发成年女性，全身站姿" }, { primary })).toBeNull();
    expect(validateSceneForm("virtual-try-on", form, { primary, secondary })).toBeNull();
    expect(supportsSceneProductTarget("virtual-try-on")).toBe(false);
});

test.each(["virtual-try-on", "sketch-to-photo"])("%s keeps optional reference roles in upload order, excluding absent images", sceneId => {
    const form = createSceneForm(sceneId);
    const labels = sceneId === "virtual-try-on" ? ["产品图", "模特图"] : ["线稿图", "材质与配色参考图"];
    expect(getSceneSlots(sceneId, form).map(({ id, label, required }) => ({ id, label, required }))).toEqual([
        { id: "primary", label: labels[0], required: true },
        { id: "secondary", label: labels[1], required: false },
    ]);
    expect(scenePromptInput(sceneId, form, { primary }).referenceRoles).toEqual([labels[0]]);
    expect(scenePromptInput(sceneId, form, { secondary, primary }).referenceRoles).toEqual(labels);
    expect(scenePromptInput(sceneId, form).referenceRoles).toEqual([labels[0]]);
    const markup = renderToStaticMarkup(createElement(SceneUploads, { slots: getSceneSlots(sceneId, form), images: { primary, secondary }, onImage() { throw new Error("Rendering must not upload or submit"); } }));
    expect(markup).toContain(`aria-label="上传${labels[0]}"`);
    expect(markup).toContain(`aria-label="上传${labels[1]}"`);
    expect(markup).toContain("可选");
});

test("sketch rendering requires explicit fabric and color instead of inventing unknown original colors", () => {
    const form = createSceneForm("sketch-to-photo");
    expect(form.colorDescription).toBe(""); expect(form.fabric).toBe("");
    expect(validateSceneForm("sketch-to-photo", form, { secondary })).toBe("请上传线稿图。");
    expect(validateSceneForm("sketch-to-photo", form, { primary, secondary })).toContain("材质方向");
    const material = { ...form, fabric: "羊毛绞花针织" };
    expect(validateSceneForm("sketch-to-photo", material, { primary, secondary })).toContain("颜色方向");
    const selected = { ...material, colorDescription: "淡粉色", keepDetails: "保留六列绞花", presentation: "白底悬浮" };
    expect(validateSceneForm("sketch-to-photo", selected, { primary })).toBeNull();
    const input = scenePromptInput("sketch-to-photo", selected, { primary });
    const snapshot = cloneSceneForm(selected);
    selected.fabric = "later fabric"; selected.colorDescription = "later color"; selected.keepDetails = "later details";
    expect(input).toMatchObject({ mode: "edit", fields: { description: "", fabric: "羊毛绞花针织", colorDescription: "淡粉色", keepDetails: "保留六列绞花", presentation: "白底悬浮" }, referenceRoles: ["线稿图"] });
    expect(snapshot.colorDescription).toBe("淡粉色");
    expect(input.fields).not.toHaveProperty("targetProduct");
    expect(input).not.toHaveProperty("systemPrompt");
});

test("required try-on description follows the optional model reference and cannot hide a missing primary", () => {
    const props = { sceneId: "virtual-try-on", form: createSceneForm("virtual-try-on"), onChange() { throw new Error("Rendering must not change a draft"); } };
    const withoutModel = renderToStaticMarkup(createElement(SceneFields, props));
    const withModel = renderToStaticMarkup(createElement(SceneFields, { ...props, hasSecondaryImage: true }));
    expect(withoutModel).toMatch(/<textarea[^>]*required=""/);
    expect(withModel).not.toMatch(/<textarea[^>]*required=""/);
    expect(withoutModel).toContain("一件产品");
    expect(withoutModel).toContain("不保证真实身份");
});

test("English labels do not mutate Chinese scene values or reference-role contracts", async () => {
    const form = { ...createSceneForm("sketch-to-photo"), fabric: "羊毛", colorDescription: "粉色", keepDetails: "保留我的中文说明" };
    const input = scenePromptInput("sketch-to-photo", form, { primary, secondary });
    await setUiLocale("en-US");
    const markup = renderToStaticMarkup(createElement(SceneFields, { sceneId: "sketch-to-photo", form, onChange() { throw new Error("Language must not mutate inputs"); } }));
    expect(markup).toContain("Fabric direction"); expect(markup).toContain("Color direction");
    expect(markup).toContain("保留我的中文说明");
    expect(scenePromptInput("sketch-to-photo", form, { primary, secondary })).toEqual(input);
});

test.each(["virtual-try-on", "sketch-to-photo"])("%s tutorial is explicitly an input example, not a fabricated production result", sceneId => {
    const example = designExampleForScene(sceneId)!;
    expect(example.media.every(media => !media.label.startsWith("结果"))).toBe(true);
    expect(example.steps.some(step => step.detail.includes("仅为输入示意而非实测结果"))).toBe(true);
});
