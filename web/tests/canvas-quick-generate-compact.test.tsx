import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CanvasQuickGeneratePanel } from "@/components/canvas/canvas-quick-generate-panel";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";

type Props = ComponentProps<typeof CanvasQuickGeneratePanel>;
const noop = () => undefined;
const models = ["gpt-image-2", "vcen-gpt2", "nano-banana-2", "midjourney-v7", "gemini-3.1-flash-image"].map(modelId => ({
    id: modelId, name: modelId, modelId, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0,
}));
const initialProps: Props = {
    embedded: true, open: true, prompt: "将花瓶改成绿色", model: "gpt-image-2", size: "1536x1024", quality: "high", count: 3,
    references: [{ id: "ref-1", name: "花瓶", type: "image/png", dataUrl: "data:image/png;base64,example" }],
    running: false, config: defaultConfig, estimateCredits: 0, estimateRmb: 0,
    onClose: noop, onPromptChange: noop, onModelChange: noop, onSizeChange: noop, onQualityChange: noop, onCountChange: noop,
    onPickReferences: noop, onRemoveReference: noop, onClearReferences: noop, onMoveReference: noop, onMissingConfig: noop, onGenerate: noop,
};

function markup(patch: Partial<Props> = {}) {
    const initialState = useBusinessConfigStore.getInitialState();
    const saved = { ...initialState };
    Object.assign(initialState, { models, status: "ready" });
    try { return renderToStaticMarkup(<CanvasQuickGeneratePanel {...initialProps} {...patch} />); }
    finally { Object.assign(initialState, saved); }
}

function settingsToggle(html: string) {
    const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(item => item.includes("生成设置"));
    if (!button) throw new Error("Missing generation settings toggle");
    return button;
}

test("generation settings start collapsed with a connected accessible toggle while core actions stay available", () => {
    const html = markup();
    const toggle = settingsToggle(html);
    expect(toggle).toContain('aria-expanded="false"');
    const controlledId = toggle.match(/aria-controls="([^"]+)"/)![1];
    const fieldset = html.match(/<fieldset\b[^>]*>[\s\S]*?<\/fieldset>/)![0];
    expect(fieldset).toContain(`id="${controlledId}"`);
    expect(fieldset).toContain('hidden=""');
    expect(fieldset).toContain('aria-label="宽高比"');
    expect(fieldset).not.toContain('aria-label="描述图像"');
    expect(fieldset).not.toContain("cw-generate-button");
    expect(html).toContain('aria-label="描述图像"');
    expect(html).toContain('aria-label="已选参考图"');
    expect(html).toContain('aria-label="添加参考图"');
    expect(html).toMatch(/class="cw-generate-button"(?! disabled)/);
    expect(html).toContain("gpt-image-2");
});

test("collapsed summary reflects normalized pixels, adapter quality labels and actual task count", () => {
    const cases: { patch: Partial<Props>; summary: string }[] = [
        { patch: {}, summary: "1536 × 1024 · 画质高 · 3 张" },
        { patch: { size: "auto", quality: "auto", count: 1 }, summary: "自适应 · 画质自动 · 1 张" },
        { patch: { model: "vcen-gpt2", size: "728x90", quality: "2k", count: 5 }, summary: "728 × 90 · 分辨率2K · 5 张" },
        { patch: { model: "nano-banana-2", size: "16:9", quality: "0.5k", count: 10 }, summary: "16:9 · 分辨率0.5K · 10 张" },
        { patch: { model: "midjourney-v7", size: "3:2", quality: "turbo", count: 9 }, summary: "3:2 · 生成速度极速 · 1 个任务" },
        { patch: { model: "gemini-3.1-flash-image", size: "16:9", quality: "4k" }, summary: "渠道默认参数 · 3 张" },
    ];
    for (const { patch, summary } of cases) {
        const html = markup(patch);
        const toggle = settingsToggle(html);
        expect(toggle).toContain(summary);
    }
});

test("reference retention explanation remains available through a native keyboard and touch disclosure", () => {
    const details = markup().match(/<details\b[^>]*>[\s\S]*?<\/details>/)![0];
    expect(details).not.toMatch(/^<details[^>]*\bopen(?:=|\s|>)/);
    expect(details).toContain("<summary");
    expect(details).toContain("参考图说明");
    expect(details).toContain("原图保留。取消选中不会清空参考图");
    expect(markup({ references: [] })).toContain("点击或框选画布图片添加参考图");
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

function controls(patch: Partial<Props> = {}) {
    const state: unknown[] = [];
    let cursor = 0;
    const effects: (() => void)[] = [];
    const dependencies: Record<string, unknown> = {
        react: { ...React, memo: (component: unknown) => component, useId: () => "settings-test", useEffect: (effect: () => void) => effects.push(effect),
            useState: (initial: unknown) => {
                const index = cursor++;
                if (!(index in state)) state[index] = initial;
                return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
            } },
        "@/stores/use-theme-store": { useThemeStore: (select: (state: object) => unknown) => select({ theme: "light" }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: (state: object) => unknown) => select({ models, status: "ready" }) },
    };
    const module = { exports: {} as { CanvasQuickGeneratePanel: (props: Props) => ReactElement } };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    return (next: Partial<Props> = {}) => {
        cursor = 0; effects.length = 0;
        const tree = elements(module.exports.CanvasQuickGeneratePanel({ ...initialProps, ...patch, ...next }));
        effects.forEach(effect => effect());
        return { tree, toggle: tree.find(element => element.type === "button" && "aria-expanded" in element.props)!, fieldset: tree.find(element => element.type === "fieldset")!, settings: tree.find(element => element.type === ImageSettingsPanel)! };
    };
}

test("opening, editing and reclosing settings retains latest values without clearing inputs or invoking generation", () => {
    const changes: unknown[] = [];
    const render = controls({
        onSizeChange: value => changes.push(["size", value]), onQualityChange: value => changes.push(["quality", value]), onCountChange: value => changes.push(["count", value]),
        onPromptChange: value => changes.push(["prompt", value]), onClearReferences: () => changes.push("clear"), onGenerate: () => changes.push("generate"),
    });
    const closed = render();
    expect(closed.fieldset.props.hidden).toBe(true);
    closed.toggle.props.onClick();
    const opened = render();
    expect(opened.toggle.props["aria-expanded"]).toBe(true);
    expect(opened.fieldset.props.hidden).toBe(false);
    expect(opened.settings.props.config).toMatchObject({ size: "1536x1024", quality: "high", count: "3" });
    expect(changes).toEqual([]);
    opened.settings.props.onConfigChange("quality", "medium");
    expect(changes).toEqual([["quality", "medium"]]);
    opened.toggle.props.onClick();
    const reclosed = render({ quality: "medium" });
    expect(reclosed.fieldset.props.hidden).toBe(true);
    expect(reclosed.settings.props.config).toMatchObject({ size: "1536x1024", quality: "medium", count: "3" });
    expect(renderToStaticMarkup(reclosed.toggle)).toContain("1536 × 1024 · 画质中 · 3 张");
    expect(reclosed.tree.find(element => element.type === "textarea")!.props.value).toBe(initialProps.prompt);
    expect(reclosed.tree.find(element => element.props.references)?.props.references).toBe(initialProps.references);
    expect(changes).toEqual([["quality", "medium"]]);
    reclosed.tree.find(element => element.props.className === "cw-generate-button")!.props.onClick();
    expect(changes).toEqual([["quality", "medium"], "generate"]);
});

test("generation in progress keeps parameter and submit locks when settings are opened", () => {
    const render = controls({ running: true });
    render().toggle.props.onClick();
    const opened = render();
    expect(opened.fieldset.props.hidden).toBe(false);
    expect(opened.fieldset.props.disabled).toBe(true);
    expect(opened.tree.find(element => element.props.className === "cw-generate-button")!.props.disabled).toBe(true);
});
