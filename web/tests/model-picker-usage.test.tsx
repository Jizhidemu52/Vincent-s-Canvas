import { expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { displayHooksHarness } from "./helpers/display-hooks-harness";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { modelLabelWithUsage } from "@/lib/model-picker-options";
import type { PublicModel } from "@/services/api/business-config";
import { defaultConfig } from "@/stores/use-config-store";

const componentUrl = new URL("../src/components/model-picker.tsx", import.meta.url);
const requireModule = createRequire(componentUrl);
const code = ts.transpileModule(readFileSync(componentUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function picker(models: PublicModel[], current: string, bound = false) {
    const state = { models, status: "ready", refresh: async () => undefined, tools: bound ? [{ toolKey: "canvas-image", modelConfigId: current, enabled: true }] : [] };
    const selected: string[] = [];
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-display-text": { ...displayHooksHarness, DisplayText: ({ text }: { text: string }) => text },
        react: { ...React, useEffect() {}, useRef: (current: unknown) => ({ current }), useMemo: (factory: () => unknown) => factory(), useId: () => "picker", useState: () => [false, () => undefined] },
        "@/components/ui/select": { Select: "Select", SelectContent: "SelectContent", SelectItem: "SelectItem", SelectTrigger: "SelectTrigger" },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select(state) },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
    };
    const module = { exports: {} as { ModelPicker: (props: Record<string, unknown>) => ReactElement<any> } };
    new Function("require", "module", "exports", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports);
    const root = module.exports.ModelPicker({ config: defaultConfig, value: current, capability: "image", toolKey: bound ? "canvas-image" : undefined, variant: "default", onChange: (value: string) => selected.push(value) });
    return { root, tree: elements(root), selected };
}

const model: PublicModel = { id: "nano2-uuid", modelId: "nano2-uuid", name: "aplmart-nano2", publicName: "aplmart-nano2", publicDescription: "快速出图与参考图改款", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };

test("usage labels are presentation-only and omit empty descriptions", () => {
    expect(modelLabelWithUsage("aplmart-gpt2", " 日常最通用模型 ")).toBe("aplmart-gpt2 · 日常最通用模型");
    expect(modelLabelWithUsage("Custom", "  ")).toBe("Custom");
    expect(modelLabelWithUsage("Custom")).toBe("Custom");
});

test("selected and dropdown names show the same usage while selection retains the UUID", () => {
    const before = { ...model };
    const { root, selected } = picker([model], model.modelId);
    const label = "Nano Banana 2";
    expect(root.props.value).toBe(model.modelId);
    expect(root.props.label).toBe(label);
    expect(root.props.options).toHaveLength(1);
    expect(root.props.options[0]).toMatchObject({ value: model.modelId, name: label, description: model.publicDescription, icon: "/icons/gemini.svg" });
    expect(root.props.options[0]).not.toHaveProperty("creditCost");
    root.props.onValueChange(model.modelId);
    root.props.onValueChange(label);
    expect(selected).toEqual([model.modelId]);
    expect(model).toEqual(before);
});

test("bound pickers retain both the usage and the backend binding indicator", () => {
    const { root } = picker([model], model.modelId, true);
    expect(root.props.disabled).toBe(true);
    expect(root.props.bound).toBe(true);
    expect(root.props.label).toBe("Nano Banana 2");
    expect(root.props.options[0].description).toBe(model.publicDescription);
});
