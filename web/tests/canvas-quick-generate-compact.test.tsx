import { i18nHarness } from "./helpers/i18n-harness";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CanvasQuickGeneratePanel } from "@/components/canvas/canvas-quick-generate-panel";
import { CanvasQuickSettingsPopovers } from "@/components/canvas/canvas-quick-settings-popovers";
import { CanvasQuickReferenceTray } from "@/components/canvas/canvas-quick-reference-tray";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { canvasToolKey } from "@/hooks/use-tool-config";

type Props = ComponentProps<typeof CanvasQuickGeneratePanel>;
const noop = () => undefined;
const models = ["gpt-image-2", "vcen-gpt2", "nano-banana-2", "midjourney-v7", "gemini-3.1-flash-image"].map(modelId => ({
    id: modelId, name: modelId, modelId, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0,
}));
const initialProps: Props = {
    embedded: true, open: true, promptRef: { current: "将花瓶改成绿色" }, promptRevision: 0, model: "gpt-image-2", size: "1536x1024", quality: "high", count: 1,
    imageOptions: "", onImageOptionsChange: noop,
    references: [{ id: "ref-1", name: "花瓶", type: "image/png", dataUrl: "data:image/png;base64,example" }],
    running: false, config: defaultConfig, estimateCredits: 0, estimateRmb: 0,
    onClose: noop, onModelChange: noop, onSizeChange: noop, onQualityChange: noop, onCountChange: noop,
    onPickReferences: noop, onRemoveReference: noop, onClearReferences: noop, onMoveReference: noop, onMissingConfig: noop, onGenerate: noop,
};

function markup(patch: Partial<Props> = {}) {
    const initialState = useBusinessConfigStore.getInitialState();
    const saved = { ...initialState };
    const modules = useModuleStore.getInitialState(), savedFlags = modules.flags;
    Object.assign(initialState, { models, tools: [], status: "ready" });
    modules.flags = { ...savedFlags, canvas: true, "canvas-image": true, "canvas-edit": true };
    try { return renderToStaticMarkup(<CanvasQuickGeneratePanel {...initialProps} {...patch} />); }
    finally { Object.assign(initialState, saved); modules.flags = savedFlags; }
}

function parameterButton(html: string, label: string) {
    const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(item => item.includes(`aria-label="${label}"`));
    if (!button) throw new Error(`Missing parameter button: ${label}`);
    return button;
}

test("initial composer has three closed parameter popovers without an inline settings form", () => {
    const html = markup();
    for (const label of ["宽高比", "画质", "更多设置"]) expect(parameterButton(html, label)).toContain('aria-expanded="false"');
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain("生成设置");
    expect(html).not.toContain("自定义宽度");
    expect(html).toContain('aria-label="描述图像"');
    expect(html).toContain('aria-label="已选参考图"');
    expect(html).toContain('aria-label="添加参考图"');
    expect(html).toMatch(/class="cw-generate-button"(?! disabled)/);
    expect(html).toContain("出图模型");
    expect(html).not.toContain("gpt-image-2");
    expect(html.indexOf('class="cw-add-reference"')).toBeGreaterThan(html.indexOf("</textarea>"));
    expect(html).toContain('aria-label="每次生成 1 张">×1</span>');
});

test("parameter buttons reflect normalized sizes and model-specific quality while count stays fixed", () => {
    const cases: { patch: Partial<Props>; size: string; quality: string }[] = [
        { patch: {}, size: "3:2", quality: "高" },
        { patch: { size: "auto", quality: "auto", count: 1 }, size: "自动", quality: "自动" },
        { patch: { model: "vcen-gpt2", size: "728x90", quality: "2k", count: 5 }, size: "728x90", quality: "2K" },
        { patch: { model: "nano-banana-2", size: "16:9", quality: "0.5k", count: 10 }, size: "16:9", quality: "0.5K" },
        { patch: { model: "midjourney-v7", size: "3:2", quality: "turbo", count: 9 }, size: "3:2", quality: "极速" },
        { patch: { model: "gemini-3.1-flash-image", size: "16:9", quality: "4k" }, size: "自动", quality: "渠道默认" },
    ];
    for (const { patch, size, quality } of cases) {
        const html = markup(patch);
        expect(parameterButton(html, "宽高比")).toContain(size);
        expect(html).toContain(`>${quality}</span>`);
        expect(html).toContain('aria-label="每次生成 1 张">×1</span>');
    }
});

test("reference guidance occupies one accessible icon in the add-reference row and retains the complete floating explanation", () => {
    const html = markup();
    const hint = parameterButton(html, "参考图说明");
    expect(hint).toContain('aria-expanded="false"');
    expect(hint).toContain('aria-haspopup="dialog"');
    expect(hint).toContain('type="button"');
    expect(html).not.toContain("cw-selection-hint");
    expect(html).not.toContain("<details");
    const tree = controls()().tree;
    const row = tree.find(element => element.props.className === "cw-reference-row")!;
    const buttons = elements(row.props.children).filter(element => element.type === "button");
    expect(buttons.map(button => button.props["aria-label"])).toEqual(["添加参考图", "参考图说明"]);
    const popup = tree.find(element => element.props.className === "cw-reference-hint-popover")!;
    expect(popup.props).toMatchObject({ side: "bottom", align: "end", "aria-label": "参考图说明" });
    const explanation = renderToStaticMarkup(<>{popup.props.children}</>);
    expect(explanation).toContain("点击或框选画布图片添加参考图");
    expect(explanation).toContain("原图保留。取消选中不会清空参考图；请用移除或清空按钮调整。");
    expect(tree.findIndex(element => element.type === CanvasQuickReferenceTray)).toBeGreaterThan(tree.indexOf(row));
    const generate = tree.find(element => element.props.className === "cw-generate-button")!;
    expect(elements(generate.props.children).some(element => element.props.className === "cw-generate-count")).toBe(true);
    expect(generate.props.title).toBe("Enter 生成，Shift+Enter 换行");
    expect(html).not.toContain("cw-shortcut");
});

// Exercise the actual component's handlers without a browser or global module mocks.
// Stateful hooks and store reads are isolated; normalization and emitted child props remain real.
const requireModule = createRequire(new URL("../src/components/canvas/canvas-quick-generate-panel.tsx", import.meta.url));
const code = ts.transpileModule(readFileSync(new URL("../src/components/canvas/canvas-quick-generate-panel.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function controls(patch: Partial<Props> = {}, toolEnabled = true) {
    const state: unknown[] = [];
    let cursor = 0;
    const effects: (() => void)[] = [];
    const dependencies: Record<string, unknown> = {
        // External drag handling has its own tests; keep this renderer focused on composer controls.
        "@/hooks/use-image-drop": { useImageDrop: () => ({ dropProps: {}, dragging: false, reading: false }) },
        react: { ...React, memo: (component: unknown) => component, useId: () => "settings-test", useEffect: (effect: () => void) => effects.push(effect),
            useState: (initial: unknown) => {
                const index = cursor++;
                if (!(index in state)) state[index] = initial;
                return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
            } },
        "@/stores/use-theme-store": { useThemeStore: (select: (state: object) => unknown) => select({ theme: "light" }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: (state: object) => unknown) => select({ models, status: "ready" }) },
        "@/stores/use-user-store": { useUserStore: (select: (state: object) => unknown) => select({ user: { role: "designer" } }) },
        "@/hooks/use-tool-config": {
            canvasToolKey,
            // This harness has no administrator model binding; retain the supplied composer config.
            useToolConfig: (config: Props["config"]) => config,
            useToolEnabled: (key: string) => toolEnabled && ["canvas-image", "canvas-edit"].includes(key),
        },
    };
    const module = { exports: {} as { CanvasQuickGeneratePanel: (props: Props) => ReactElement } };
    new Function("require", "module", "exports", code)((id: string) => id === "@/lib/i18n" ? i18nHarness : ((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name))(id), module, module.exports);
    return (next: Partial<Props> = {}) => {
        cursor = 0; effects.length = 0;
        const tree = elements(module.exports.CanvasQuickGeneratePanel({ ...initialProps, ...patch, ...next }));
        effects.forEach(effect => effect());
        return { tree, settings: tree.find(element => element.type === CanvasQuickSettingsPopovers)! };
    };
}

test("editing popover settings retains latest values without clearing inputs or invoking generation", () => {
    const changes: unknown[] = [];
    const render = controls({
        onSizeChange: value => changes.push(["size", value]), onQualityChange: value => changes.push(["quality", value]), onCountChange: value => changes.push(["count", value]),
        onClearReferences: () => changes.push("clear"), onGenerate: () => changes.push("generate"),
    });
    const opened = render();
    expect(opened.settings.props.config).toMatchObject({ size: "1536x1024", quality: "high", count: "1" });
    expect(changes).toEqual([]);
    opened.settings.props.onConfigChange("quality", "medium");
    expect(changes).toEqual([["quality", "medium"]]);
    const reclosed = render({ quality: "medium" });
    expect(reclosed.settings.props.config).toMatchObject({ size: "1536x1024", quality: "medium", count: "1" });
    expect(reclosed.tree.find(element => element.type === "textarea")!.props.value).toBe(initialProps.promptRef.current);
    expect(reclosed.tree.find(element => element.props.references)?.props.references).toBe(initialProps.references);
    expect(changes).toEqual([["quality", "medium"]]);
    reclosed.tree.find(element => element.props.className === "cw-generate-button")!.props.onClick();
    expect(changes).toEqual([["quality", "medium"], "generate"]);
});

test("generation in progress locks all parameter popovers and submission", () => {
    const render = controls({ running: true });
    const opened = render();
    expect(opened.settings.props.disabled).toBe(true);
    expect(opened.tree.find(element => element.props.className === "cw-generate-button")!.props.disabled).toBe(true);
});

test("selected advanced settings override global defaults and editing only updates the local composer", () => {
    const globalBefore = useConfigStore.getState();
    const changes: string[] = [];
    const savedOptions = '{"output_format":"webp","output_compression":83}';
    const render = controls({ config: { ...defaultConfig, imageOptions: savedOptions }, imageOptions: "", onImageOptionsChange: value => changes.push(value) });
    expect(render().settings.props.config.imageOptions).toBe("");
    const selected = render({ imageOptions: savedOptions });
    expect(selected.settings.props.config.imageOptions).toBe(savedOptions);
    selected.settings.props.onConfigChange("imageOptions", "");
    expect(changes).toEqual([""]);
    expect(useConfigStore.getState()).toBe(globalBefore);
});

function pressPrompt(props: Partial<Props>, patch: Record<string, unknown> = {}, toolEnabled = true) {
    let submissions = 0;
    let prevented = false;
    const rendered = controls({ ...props, onGenerate: () => { submissions++; } }, toolEnabled)();
    const prompt = rendered.tree.find(element => element.type === "textarea")!;
    prompt.props.onKeyDown({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, keyCode: 13, nativeEvent: { isComposing: false },
        preventDefault: () => { prevented = true; }, ...patch });
    return { submissions, prevented, buttonDisabled: rendered.tree.find(element => element.props.className === "cw-generate-button")!.props.disabled };
}

test("Enter submits generation and modification while Ctrl/Cmd+Enter remain compatible", () => {
    for (const references of [[], initialProps.references]) {
        for (const modifier of [{}, { ctrlKey: true }, { metaKey: true }]) {
            expect(pressPrompt({ references }, modifier)).toEqual({ submissions: 1, prevented: true, buttonDisabled: false });
        }
    }
});

test("held Enter cannot resubmit after the generate button becomes available again", () => {
    for (const modifier of [{}, { ctrlKey: true }, { metaKey: true }]) {
        expect(pressPrompt({}, { ...modifier, repeat: true })).toEqual({ submissions: 0, prevented: true, buttonDisabled: false });
    }
});

test("Shift+Enter and composing Enter remain with the text editor", () => {
    for (const input of [{ shiftKey: true }, { shiftKey: true, ctrlKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { isComposing: true }, ctrlKey: true }, { keyCode: 229 }, { keyCode: 229, metaKey: true }]) {
        expect(pressPrompt({}, input)).toEqual({ submissions: 0, prevented: false, buttonDisabled: false });
    }
});

test("Enter never bypasses the generate button's running, empty-prompt or invalid-reference locks", () => {
    const tooMany = Array.from({ length: 30 }, (_, index) => ({ ...initialProps.references[0]!, id: `reference-${index}` }));
    for (const props of [{ running: true }, { promptRef: { current: " " } }, { references: tooMany }]) {
        const result = pressPrompt(props);
        expect(result.buttonDisabled).toBe(true);
        expect(result.submissions).toBe(0);
    }
});

test("prompt edits stay local, survive remount, and external resets refresh even the same saved text", () => {
    const promptRef = { current: "模板提示词" };
    const submitted: string[] = [];
    const props = { promptRef, onGenerate: () => submitted.push(promptRef.current) };
    const render = controls(props);
    let tree = render().tree;
    tree.find(element => element.type === "textarea")!.props.onChange({ target: { value: "本地正在编辑" } });
    expect(promptRef.current).toBe("本地正在编辑");
    tree = render({ quality: "medium" }).tree;
    expect(tree.find(element => element.type === "textarea")!.props.value).toBe("本地正在编辑");
    tree.find(element => element.props.className === "cw-generate-button")!.props.onClick();
    expect(submitted).toEqual(["本地正在编辑"]);
    expect(controls(props)().tree.find(element => element.type === "textarea")!.props.value).toBe("本地正在编辑");
    promptRef.current = "模板提示词";
    render({ promptRevision: 1 });
    expect(render({ promptRevision: 1 }).tree.find(element => element.type === "textarea")!.props.value).toBe("模板提示词");
});

test("Enter cannot submit a disabled canvas tool even when its prompt, model and references are valid", () => {
    for (const references of [[], initialProps.references]) {
        expect(pressPrompt({ references }, {}, false)).toEqual({ submissions: 0, prevented: true, buttonDisabled: true });
    }
});
