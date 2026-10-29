import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setUiLocale, uiText } from "@/lib/i18n";
import { SceneFields } from "@/pages/creative/scene-form";
import { createSceneForm, scenePromptInput } from "@/pages/creative/scene-form-model";
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
    expect(markup).toContain('value="针织衫" selected=""');
    expect(markup).toMatch(/<input(?=[^>]*value="宽松")(?=[^>]*checked="")[^>]*>/);
    expect(markup).toContain("保存 / 我的中文针织设计");
    expect(markup).toContain("Knitwear");
    expect(form).toEqual(before);
    expect(scenePromptInput("text-to-style", form)).toEqual(payload);
});
