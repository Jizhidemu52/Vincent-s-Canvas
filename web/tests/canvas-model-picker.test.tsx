import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { canvasImageModelDetails, canvasModelGroups, canvasModelPresentation, commonCanvasModels, type CanvasModelOption } from "@/lib/canvas/canvas-model-picker-options";
import { CanvasModelRow } from "@/components/canvas/canvas-model-picker";
import { imageModelProfile } from "@/lib/image-model-settings";
import { referencePolicyForModel } from "@/lib/image-reference-policy";
import { defaultConfig } from "@/stores/use-config-store";
import type { PublicModel } from "@/services/api/business-config";

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function loadComponent(path: string, dependencies: Record<string, unknown>) {
    const url = new URL(path, import.meta.url);
    const localRequire = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, (props: any) => ReactElement<any>> };
    new Function("require", "module", "exports", code)((name: string) => name.endsWith(".css") ? {} : dependencies[name] || localRequire(name), module, module.exports);
    return module.exports;
}

const imageModel = (id: string, name: string, profile: PublicModel["imageParameterProfile"] = "quality-resolution"): PublicModel => ({
    id, modelId: id, name, publicName: name, modelIdentityHidden: true, publicDescription: "快速出方案与常规改图",
    imageParameterProfile: profile, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0,
});

function picker(models: PublicModel[], props: Record<string, unknown> = {}, binding?: { modelConfigId: string | null; enabled: boolean }) {
    const selected: string[] = [], usage: unknown[][] = [];
    const state = { models, status: "ready", refresh: async () => undefined, tools: binding ? [{ toolKey: "canvas-image", ...binding }] : [] };
    const exports = loadComponent("../src/components/model-picker.tsx", {
        react: { ...React, useEffect() {}, useMemo: (factory: () => unknown) => factory(), useId: () => "picker", useState: () => [false, () => undefined] },
        "@/components/ui/select": { Select: "Select", SelectContent: "SelectContent", SelectItem: "SelectItem", SelectTrigger: "SelectTrigger" },
        "@/components/canvas/canvas-model-picker": { CanvasModelPicker: "CanvasModelPicker" },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select(state) },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/lib/usage-control-events": { emitModelUsage: (...args: unknown[]) => usage.push(args) },
    });
    const root = exports.ModelPicker!({ config: defaultConfig, value: models[0]?.modelId || "", capability: "image", toolKey: "canvas-image", onChange: (value: string) => selected.push(value), ...props });
    return { root, selected, usage };
}

describe("canvas model presentation", () => {
    test("published APIMart labels get a brand icon and separate channel without changing the identifier", () => {
        expect(canvasModelPresentation("aplmart-gpt2.5-flare")).toEqual({ name: "GPT Image 2.5 Flare", channel: "APIMart", family: "OpenAI", icon: "/icons/openai.svg" });
        expect(canvasModelPresentation("APIMart-nano2")).toEqual({ name: "Nano Banana 2", channel: "APIMart", family: "Google", icon: "/icons/gemini.svg" });
        expect(canvasModelPresentation("出图模型9")).toEqual({ name: "出图模型9", channel: undefined, family: "其他模型", icon: undefined });
        expect(canvasModelPresentation("My private image model").name).toBe("My private image model");
    });

    test("capability summaries come from the current image and reference policies", () => {
        const cases: Array<[PublicModel["imageParameterProfile"], string[]]> = [
            ["quality-resolution", ["1K / 2K / 4K", "最多 16 张参考图"]],
            ["resolution-1k", ["1K / 2K / 4K", "最多 16 张参考图（工作台上限）"]],
            ["resolution", ["0.5K / 1K / 2K / 4K", "最多 14 张参考图"]],
            ["grok-image", ["1K / 2K", "最多 3 张参考图"]],
            ["blend", ["2–4 张参考图", "无需提示词"]],
            ["unverified", ["渠道默认参数"]],
        ];
        for (const [kind, expected] of cases) {
            const model = imageModel("opaque-id", "出图模型", kind);
            const profile = imageModelProfile(model.modelId, [model]);
            expect(canvasImageModelDetails(profile, referencePolicyForModel(model.modelId, profile))).toEqual(expected);
        }
    });

    test("featured membership and order are server-owned, capped at five, and never inferred from names", () => {
        const options: CanvasModelOption[] = Array.from({ length: 12 }, (_, index) => ({ value: `uuid-${index}`, name: index === 11 ? "aplmart-gpt2" : `Visible ${index}`, family: index % 3 === 0 ? "Google" : "OpenAI", details: [], isFeatured: index < 7, displayOrder: 12 - index }));
        const common = commonCanvasModels(options);
        expect(common).toHaveLength(5);
        expect(common.map(option => option.value)).toEqual(["uuid-6", "uuid-5", "uuid-4", "uuid-3", "uuid-2"]);
        expect(new Set(common.map(option => option.value)).size).toBe(5);
        expect(canvasModelGroups(options).flatMap(group => group.models).map(option => option.value).sort()).toEqual(options.map(option => option.value).sort());
        expect(commonCanvasModels(options.map(option => ({ ...option, isFeatured: false })))).toEqual([]);
        expect(commonCanvasModels([{ value: "unknown", name: "APIMart GPT", family: "OpenAI", details: [] }])).toEqual([]);
        expect(commonCanvasModels([])).toEqual([]);
    });

    test("rows keep the full name, independent usage, channel, and real value", () => {
        const option: CanvasModelOption = { value: "uuid-opaque-2", ...canvasModelPresentation("aplmart-gpt2.5-sunburst"), description: "精细改图与细节表现", details: ["1K / 2K / 4K", "最多 16 张参考图"], usageModelId: "uuid-opaque-2" };
        const selected: string[] = [];
        const row = CanvasModelRow({ option, selected: true, onSelect: value => selected.push(value) });
        const html = renderToStaticMarkup(row);
        expect(html).toContain('role="option"');
        expect(html).toContain('aria-selected="true"');
        expect(html).toContain("GPT Image 2.5 Sunburst");
        expect(html).toContain("canvas-model-option-description");
        expect(html).toContain("精细改图与细节表现");
        expect(html).toContain("/icons/openai.svg");
        expect(html).toContain("APIMart");
        expect(html).not.toContain("Cpu");
        row.props.onClick();
        expect(selected).toEqual(["uuid-opaque-2"]);
    });
});

describe("canvas picker integration contracts", () => {
    test("canvas gets the new presentation and emits only existing opaque values", () => {
        const model = { ...imageModel("model-uuid", "aplmart-gpt2.5-flare"), isFeatured: true, displayOrder: 3 };
        const { root, selected, usage } = picker([model]);
        expect(root.type).toBe("CanvasModelPicker");
        expect(root.props.value).toBe(model.modelId);
        expect(root.props.label).toBe("GPT Image 2.5 Flare");
        expect(root.props.label).not.toContain(model.publicDescription!);
        expect(root.props.options[0].value).toBe("model-uuid");
        expect(root.props.options[0].description).toBe(model.publicDescription);
        expect(root.props.options[0].isFeatured).toBe(true);
        expect(root.props.options[0].displayOrder).toBe(3);
        root.props.onValueChange("GPT Image 2.5 Flare");
        root.props.onValueChange("removed-model");
        root.props.onValueChange("model-uuid");
        expect(selected).toEqual(["model-uuid"]);
        expect(usage).toEqual([["change", "model-uuid"]]);
    });

    test("Mark-looking names without the server flag are never automatically featured", () => {
        const model = imageModel("model-uuid", "aplmart-gpt2.5-flare");
        const root = picker([model]).root;
        expect(root.props.options[0].isFeatured).toBe(false);
        expect(commonCanvasModels(root.props.options)).toEqual([]);
    });

    test("default non-canvas selection remains the existing Select and an explicit canvas variant supports Blend", () => {
        const model = imageModel("model-uuid", "aplmart-gpt2");
        expect(picker([model], { toolKey: "image" }).root.type).toBe("Select");
        expect(picker([model], { variant: "default" }).root.type).toBe("Select");
        const blend = imageModel("blend-uuid", "aplmart-mj-blend", "blend");
        const root = picker([blend], { toolKey: "midjourney-blend", variant: "canvas" }).root;
        expect(root.type).toBe("CanvasModelPicker");
        expect(root.props.options.map((option: CanvasModelOption) => option.value)).toEqual(["blend-uuid"]);
    });

    test("tool binding, disabled state, and incompatible capabilities remain authoritative", () => {
        const first = imageModel("uuid-first", "aplmart-gpt2");
        const second = imageModel("uuid-second", "aplmart-nano2");
        const text = { ...imageModel("uuid-text", "GPT-6 Astra"), capabilities: ["chat"] };
        expect(picker([first, second, text]).root.props.options.map((option: CanvasModelOption) => option.value)).toEqual([first.modelId, second.modelId]);
        const bound = picker([first, second], {}, { modelConfigId: second.id, enabled: true });
        expect(bound.root.props.options.map((option: CanvasModelOption) => option.value)).toEqual([second.modelId]);
        expect(bound.root.props.disabled).toBe(true);
        expect(bound.root.props.bound).toBe(true);
        bound.root.props.onValueChange(second.modelId);
        expect(bound.selected).toEqual([]);
        const disabled = picker([first], {}, { modelConfigId: null, enabled: false });
        expect(disabled.root.props.label).toBe("此板块已停用");
        disabled.root.props.onValueChange(first.modelId);
        expect(disabled.selected).toEqual([]);
        const missing = picker([first], {}, { modelConfigId: "removed-uuid", enabled: true }).root;
        expect(missing.props.options).toEqual([]);
        expect(missing.props.label).toBe("绑定模型不可用");
        expect(picker([first], { disabled: true }).root.props.disabled).toBe(true);
    });

    test("hidden raw names never become visible names, icons, family names, or channel hints", () => {
        const hidden = { ...imageModel("secret-gpt-image-4", "secret-gpt-image-4"), publicName: "出图模型9", id: "opaque-uuid" };
        const root = picker([hidden]).root;
        const option = root.props.options[0] as CanvasModelOption;
        expect(option.name).toBe("出图模型9");
        expect(option.icon).toBeUndefined();
        expect(option.channel).toBeUndefined();
        expect(option.family).toBe("其他模型");
        const html = renderToStaticMarkup(CanvasModelRow({ option, selected: true, onSelect() {} }));
        expect(html).not.toContain("secret-gpt");
        expect(html).not.toContain("OpenAI");
    });
});

test("canvas menu has one scrollable list, expandable families, separate theme, and guarded selection", () => {
    const options: CanvasModelOption[] = Array.from({ length: 10 }, (_, index) => ({ value: `id-${index}`, name: `Model ${index}`, family: "Test family", details: [], description: "用途说明", isFeatured: index < 3, displayOrder: 3 - index }));
    let hookIndex = 0;
    const states: unknown[] = [];
    const selected: string[] = [], opened: boolean[] = [];
    const exports = loadComponent("../src/components/canvas/canvas-model-picker.tsx", {
        react: { ...React, useId: () => "menu-id", useRef: () => ({ current: null }), useState: (initial: unknown) => {
            const index = hookIndex++;
            if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
            return [states[index], (next: unknown) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
        } },
        "radix-ui": { Popover: { Root: "PopoverRoot", Trigger: "PopoverTrigger", Portal: "PopoverPortal", Content: "PopoverContent" } },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
    });
    const render = (disabled = false) => { hookIndex = 0; return exports.CanvasModelPicker!({ options, value: "id-0", label: "Model 0", emptyLabel: "暂无模型", open: true, disabled, bound: false, categoryLabel: "图像模型", onOpenChange: (open: boolean) => opened.push(open), onValueChange: (value: string) => selected.push(value) }); };
    let root = render();
    let tree = elements(root);
    const content = tree.find(item => item.type === "PopoverContent")!;
    expect(content.props.side).toBe("right");
    expect(content.props["data-theme"]).toBe("light");
    expect(content.props.style["--cmp-panel"]).toBe("#ffffff");
    expect(tree.some(item => item.props.role === "tablist")).toBe(false);
    expect(tree.filter(item => item.props.className === "canvas-model-menu-scroll")).toHaveLength(1);
    const backButton = tree.find(item => item.props["aria-label"] === "关闭模型选择")!;
    expect(backButton.props.type).toBe("button");
    const scrollArea = tree.find(item => item.props.className === "canvas-model-menu-scroll")!;
    expect(elements(scrollArea).some(item => item.props["aria-label"] === "关闭模型选择")).toBe(false);
    backButton.props.onClick();
    expect(opened).toEqual([false]);
    expect(selected).toEqual([]);
    opened.length = 0;
    const featuredList = tree.find(item => item.props["aria-label"] === "热门模型")!;
    expect(elements(featuredList).filter(item => typeof item.type === "function" && item.type.name === "CanvasModelRow").map(item => item.props.option.value)).toEqual(["id-2", "id-1", "id-0"]);
    expect(tree.filter(item => typeof item.type === "function" && item.type.name === "CanvasModelRow")).toHaveLength(3);
    const group = tree.find(item => item.props.className === "canvas-model-family-toggle")!;
    expect(group.props["aria-expanded"]).toBe(false);
    group.props.onClick();
    root = render(); tree = elements(root);
    expect(tree.find(item => item.props.className === "canvas-model-family-toggle")!.props["aria-expanded"]).toBe(true);
    const allGroup = tree.find(item => item.props["aria-label"] === "Test family 模型")!;
    expect(elements(allGroup).filter(item => typeof item.type === "function" && item.type.name === "CanvasModelRow")).toHaveLength(10);
    const row = tree.find(item => typeof item.type === "function" && item.type.name === "CanvasModelRow")!;
    row.props.onSelect("not-available");
    row.props.onSelect("id-7");
    expect(selected).toEqual(["id-7"]);
    expect(opened).toEqual([false]);
    const disabledRoot = render(true);
    expect(disabledRoot.props.open).toBe(false);
    elements(disabledRoot).find(item => typeof item.type === "function" && item.type.name === "CanvasModelRow")!.props.onSelect("id-8");
    expect(selected).toEqual(["id-7"]);
});
