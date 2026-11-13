import { expect, test } from "bun:test";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { i18nHarness } from "./helpers/i18n-harness";
import { displayHooksHarness } from "./helpers/display-hooks-harness";
import { defaultConfig } from "@/stores/use-config-store";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { Tooltip } from "antd";
import { imageModelProfile } from "@/lib/image-model-settings";
import { canvasThemes } from "@/lib/canvas-theme";
import type { PublicModel } from "@/services/api/business-config";

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

const model: PublicModel = {
    id: "7bf4a4e1-7202-49dd-bf16-363d01971346", modelId: "7bf4a4e1-7202-49dd-bf16-363d01971346",
    name: "aplmart-gpt2.6-flare", publicName: "aplmart-gpt2.6-flare", publicDescription: "速度优先，适合快速迭代",
    imageParameterProfile: "quality-resolution-v2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0,
};

function settingsPicker(bound = false, variant: "settings" | "default" = "settings") {
    const url = new URL("../src/components/model-picker.tsx", import.meta.url);
    const requireModule = createRequire(url);
    const state = { status: "ready", models: [model], refresh: async () => {}, tools: bound ? [{ toolKey: "image-generation", modelConfigId: model.id, enabled: true }] : [] };
    const selected: string[] = [];
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-display-text": { ...displayHooksHarness, DisplayText: ({ text }: { text: string }) => text },
        react: { ...React, useEffect() {}, useMemo: (factory: () => unknown) => factory(), useId: () => "settings-picker", useRef: (current: unknown) => ({ current }), useState: () => [false, () => {}] },
        "@/components/ui/select": { Select: "Select", SelectTrigger: "SelectTrigger", SelectContent: "SelectContent", SelectItem: "SelectItem" },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select(state) },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
    };
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} as { ModelPicker: (props: Record<string, unknown>) => ReactElement<any> } };
    new Function("require", "module", "exports", code)((name: string) => name.endsWith(".css") ? {} : dependencies[name] || requireModule(name), module, module.exports);
    const root = module.exports.ModelPicker({ config: defaultConfig, value: model.modelId, capability: variant === "settings" ? "image" : undefined, modelsSource: variant === "settings" ? "server" : "local", toolKey: "image-generation", variant, onChange: (value: string) => selected.push(value) });
    return { root, tree: elements(root), selected };
}

test("settings model picker separates public name, use and selected state without changing opaque request identifiers", () => {
    const { root, tree, selected } = settingsPicker();
    const trigger = tree.find(item => item.type === "SelectTrigger")!;
    expect(trigger.props["aria-label"]).toBe("生成图片模型");
    const label = renderToStaticMarkup(trigger.props.children);
    expect(label).toContain("GPT Image 2.6 Flare");
    expect(label).toContain("速度优先，适合快速迭代");
    expect(label).toContain("当前使用");
    expect(label).not.toContain(model.id);
    const option = tree.find(item => item.type === "SelectItem")!;
    expect(option.props.value).toBe(model.modelId);
    expect(option.props["data-usage-value"]).toBe(model.id);
    expect(renderToStaticMarkup(option.props.children)).toContain("已选");
    root.props.onValueChange(model.modelId);
    root.props.onValueChange("GPT Image 2.6 Flare");
    expect(selected).toEqual([model.modelId]);
});

test("both non-canvas model triggers use a wrapper Tooltip without replacing trigger event handlers", () => {
    for (const variant of ["settings", "default"] as const) {
        const { tree } = settingsPicker(false, variant);
        const trigger = tree.find(item => item.type === "SelectTrigger")!;
        const tooltip = tree.find(item => item.type === Tooltip)!;
        expect(trigger.props.title).toBeUndefined();
        expect(tooltip.props.title).toBeTruthy();
        // Restoring focus from the model menu must not open another Escape-handling portal.
        expect(tooltip.props.trigger).toBeUndefined();
        expect(tooltip.props.children.type).toBe("span");
        expect(tooltip.props.children.props.children).toBe(trigger);
        let stopped = 0;
        trigger.props.onMouseDown({ stopPropagation: () => stopped++ });
        trigger.props.onPointerDown({ stopPropagation: () => stopped++ });
        expect(stopped).toBe(2);
    }
});

test("settings model picker preserves backend binding restrictions", () => {
    const { root, tree, selected } = settingsPicker(true);
    expect(root.props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree.find(item => item.type === "SelectTrigger")!.props.children)).toContain("后台指定");
    root.props.onValueChange(model.modelId);
    expect(selected).toEqual([]);
});

test("settings dropdown consumes Escape propagation without preventing its own dismissal", () => {
    const menu = settingsPicker().tree.find(item => item.type === "SelectContent")!;
    let stopped = 0, prevented = 0;
    menu.props.onEscapeKeyDown({ stopPropagation: () => stopped++, preventDefault: () => prevented++ });
    expect(stopped).toBe(1);
    expect(prevented).toBe(0);
});

test("dialog parameters keep the three common controls together and advanced controls closed by default", () => {
    const profile = imageModelProfile("gpt-image-2.6-flare", []);
    const html = renderToStaticMarkup(<ImageSettingsPanel {...({ config: { ...defaultConfig, model: "gpt-image-2.6-flare", size: "1:1", quality: "auto", imageOptions: "{}" }, profile, theme: canvasThemes.light, onConfigChange() {}, showTitle: false, dialog: true } as any)} />);
    expect(html).toContain('class="ip-basics-grid"');
    for (const name of ["宽高比", "清晰度 / 分辨率", "图片质量"]) expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain("高级参数");
    expect(html).toContain("自定义像素");
    expect(html).not.toMatch(/<details[^>]+open/);
    expect(html).toContain('aria-label="输出格式"');
});
