import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setUiLocale, uiText } from "@/lib/i18n";
import { SceneFields, SceneUploads } from "@/pages/creative/scene-form";
import { createSceneForm, getSceneSlots, scenePromptInput } from "@/pages/creative/scene-form-model";
import { setWorkbenchText, watchWorkbenchUi } from "@/pages/design-workbench/local/ui-text.js";

afterEach(async () => { await setUiLocale("zh-CN"); });

class Label {
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    textContent = "";
    value = "";
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

test("native workbench language subscriptions touch only explicit UI labels, not user content or inputs", async () => {
    const fixed = new Label(); fixed.dataset.uiText = "保存";
    const dynamic = new Label();
    const userProject = new Label(); userProject.textContent = "保存"; userProject.value = "original-project-id";
    const dimension = new Label(); dimension.value = "387.5";
    const blend = new Label(); blend.value = "multiply"; blend.setAttribute("data-ui-aria-label", "混合模式");
    const visibility = new Label(); visibility.dataset.uiLabelAction = "隐藏"; visibility.dataset.uiLabelName = "保存";
    const all = [fixed, dynamic, userProject, dimension, blend, visibility];
    const root = {
        querySelectorAll(selector: string) {
            if (selector === "[data-ui-text], [data-ui-bound]") return all.filter(label => label.dataset.uiText !== undefined || label.dataset.uiBound);
            if (selector === "[data-ui-label-action]") return all.filter(label => label.dataset.uiLabelAction);
            const attribute = selector.slice(1, -1);
            return all.filter(label => label.attributes.has(attribute));
        },
    };
    const controller = new AbortController();
    watchWorkbenchUi(root, controller.signal);
    setWorkbenchText(dynamic, () => uiText("正在编辑 · {value1}", { value1: "保存 {count}" }));
    try {
        expect(fixed.textContent).toBe("保存");
        await setUiLocale("en-US");
        expect(fixed.textContent).toBe("Save");
        expect(dynamic.textContent).toBe("Editing · 保存 {count}");
        expect(blend.getAttribute("aria-label")).toBe("Blend mode");
        expect(visibility.getAttribute("aria-label")).toBe("Hide 保存");
        expect(userProject.textContent).toBe("保存");
        expect(userProject.value).toBe("original-project-id");
        expect(dimension.value).toBe("387.5");
        expect(blend.value).toBe("multiply");
        await setUiLocale("zh-CN");
        expect(fixed.textContent).toBe("保存");
        expect(dynamic.textContent).toBe("正在编辑 · 保存 {count}");
        controller.abort();
        await setUiLocale("en-US");
        expect(fixed.textContent).toBe("保存");
    } finally { controller.abort(); }
});

test("English scene choices keep Chinese source values and the original model payload", async () => {
    const form = { ...createSceneForm("text-to-style"), description: "保存 / 我的中文针织设计", category: "针织衫", silhouette: "宽松" };
    const before = structuredClone(form);
    const payload = scenePromptInput("text-to-style", form);
    await setUiLocale("en-US");
    const markup = renderToStaticMarkup(createElement(SceneFields, { sceneId: "text-to-style", form, onChange() { throw new Error("Language render must not mutate a draft"); } }));
    expect(markup).toContain('title="Knitwear"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toMatch(/<input(?=[^>]*value="宽松")(?=[^>]*checked="")[^>]*>/);
    expect(markup).toContain("保存 / 我的中文针织设计");
    expect(markup).toContain("Knitwear");
    expect(form).toEqual(before);
    expect(scenePromptInput("text-to-style", form)).toEqual(payload);
});

test("asset input labels and feedback translate without changing original asset names", async () => {
    await setUiLocale("en-US");
    const markup = renderToStaticMarkup(createElement(SceneUploads, { slots: getSceneSlots("accessory-design", createSceneForm("accessory-design")), images: {}, onImage() {}, onAsset: async () => {} }));
    expect(markup).toContain("Choose from library");
    expect(markup).toContain("from library\"");
    expect(markup).not.toContain("从素材库选择");
    expect(uiText("已从素材库加入{name}；原素材保持不变。", { name: "我的原图 {label}.png" })).toBe("Added 我的原图 {label}.png from the library. The original asset is unchanged.");
    expect(uiText("素材读取失败：{value1}", { value1: uiText("请选择 PNG、JPG 或 WebP 图片素材") })).toBe("Could not read the asset: Choose a PNG, JPG or WebP image asset");
    expect(uiText("图片读取失败（{status}），请重新选择素材", { status: 500 })).toBe("Could not read the image (500). Select the asset again.");
    for (const source of ["请选择图片素材", "参考图位置或任务状态已变化，请重新打开素材库", "账号、任务或参考图位置已变化，请重新选择素材", "正在读取参考图，请稍候再选择素材", "参考图已更新，请重新选择素材", "请重新确认要处理的产品。", "正在处理当前任务，请稍候再选择素材", "请选择不超过 15 MB 的 PNG、JPG 或 WebP 图片素材"]) expect(uiText(source)).not.toBe(source);
});
