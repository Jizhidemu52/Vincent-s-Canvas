import { i18nHarness } from "./helpers/i18n-harness";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog, Popover } from "radix-ui";
import ts from "typescript";
import { CanvasQuickSettingsPopovers } from "@/components/canvas/canvas-quick-settings-popovers";
import { ImageSettingsPanel, imageSizeLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageOptionFields } from "@/lib/image-advanced-settings";
import { imageTaskParameters } from "@/services/api/image";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

const { CanvasQuickQualityOptions, CanvasQuickRatioOptions } = (() => {
    const url = new URL("../src/components/canvas/canvas-quick-settings-popovers.tsx", import.meta.url);
    const localRequire = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} as typeof import("@/components/canvas/canvas-quick-settings-popovers") };
    new Function("require", "module", "exports", code)((id: string) => id === "@/lib/i18n" ? i18nHarness : id.endsWith(".css") ? {} : localRequire(id), module, module.exports);
    return module.exports;
})();

type Props = ComponentProps<typeof CanvasQuickSettingsPopovers>;
type Profile = Props["profile"];
const model = (id: string, kind: "quality-resolution" | "resolution-1k" | "grok-image") => ({ id, modelId: id, name: id, imageParameterProfile: kind, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 });
const models = [model("mark-flare", "quality-resolution"), model("mark-nano", "resolution-1k"), model("grok", "grok-image")];
const profile = (id: string) => imageModelProfile(id, models, "designer");
const config = (patch: Partial<AiConfig> = {}): AiConfig => ({ ...defaultConfig, model: "mark-flare", imageModel: "mark-flare", size: "1:1", quality: "high", count: "1", imageOptions: '{"resolution":"1k"}', ...patch });
const noop = () => undefined;

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function qualityControls(value: AiConfig, selectedProfile: Profile, referenceCount = 0) {
    const changes: Array<[string, string]> = [];
    const tree = elements(CanvasQuickQualityOptions({ config: value, profile: selectedProfile, referenceCount, onConfigChange: (key, next) => changes.push([key, next]) }));
    return { changes, tree, option: (control: string, next: string) => tree.find(item => item.type === "button" && item.props["data-usage-control"] === control && item.props["data-usage-value"] === next)! };
}

test("ratio grids expose only configured sizes with distinct horizontal and vertical outlines", () => {
    for (const id of ["mark-flare", "mark-nano", "grok", "gpt-image-2", "midjourney-v7"]) {
        const selected = profile(id);
        const chosen: string[] = [];
        const tree = elements(CanvasQuickRatioOptions({ profile: selected, value: "1:1", onChange: value => chosen.push(value) }));
        const buttons = tree.filter(item => item.type === "button" && item.props["data-usage-control"] === "size");
        expect(buttons.map(item => item.props["data-usage-value"])).toEqual(selected.sizes);
        buttons.forEach(button => button.props.onClick());
        expect(chosen).toEqual(selected.sizes);
        expect(chosen).not.toContain("10:14");
    }
    const html = renderToStaticMarkup(<CanvasQuickRatioOptions profile={profile("mark-flare")} value="3:2" onChange={noop} />);
    expect(html).toContain('aria-pressed="true" data-usage-control="size" data-usage-value="3:2"');
    expect(html).toContain('width:23px;height:15.333333333333334px');
    expect(html).toContain('width:15.333333333333332px;height:23px');
    expect(html).toContain('data-usage-value="auto"');
});

test("GPT quality and resolution controls emit independent values accepted by the real request serializer", () => {
    let value = config({ imageOptions: '{"resolution":"1k","output_format":"webp","output_compression":"88","background":"opaque"}' });
    const quality = qualityControls(value, profile("mark-flare"));
    quality.option("quality", "max").props.onClick();
    expect(quality.changes).toEqual([["quality", "max"]]);
    value = { ...value, quality: quality.changes[0]![1] };
    const resolution = qualityControls(value, profile("mark-flare"));
    resolution.option("resolution", "4k").props.onClick();
    expect(resolution.changes).toEqual([["imageOptions", '{"resolution":"4k","output_format":"webp","output_compression":"88","background":"opaque"}']]);
    value = { ...value, imageOptions: resolution.changes[0]![1] };
    expect(imageTaskParameters(value, profile("mark-flare"))).toEqual({ size: "1:1", quality: "max", resolution: "4k", output_format: "webp", output_compression: 88, background: "opaque" });
});

test("Nano exposes only 1K/2K/4K and cannot emit GPT quality or formatting fields", () => {
    const selected = profile("mark-nano");
    const value = config({ model: "mark-nano", quality: "max", imageOptions: '{"resolution":"4k","output_format":"webp","background":"transparent"}' });
    const controls = qualityControls(value, selected);
    expect(controls.tree.filter(item => item.type === "button").map(item => item.props["data-usage-value"])).toEqual(["1k", "2k", "4k"]);
    controls.option("resolution", "2k").props.onClick();
    expect(controls.changes).toEqual([["quality", "2k"]]);
    expect(imageTaskParameters({ ...value, quality: "2k" }, selected)).toEqual({ size: "1:1", resolution: "2k" });
});

test("exact pixels suspend resolution choices while quality remains independently editable", () => {
    const value = config({ size: "768x1024", quality: "high", imageOptions: '{"resolution":"4k"}' });
    const selected = profile("mark-flare");
    const controls = qualityControls(value, selected);
    for (const resolution of ["1k", "2k", "4k"]) expect(controls.option("resolution", resolution).props.disabled).toBe(true);
    expect(controls.option("quality", "max").props.disabled).toBeUndefined();
    expect(imageTaskParameters(value, selected)).toMatchObject({ size: "768x1024", resolution: "4k", quality: "high" });
    expect(renderToStaticMarkup(<CanvasQuickQualityOptions config={value} profile={selected} referenceCount={0} onConfigChange={noop} />)).toContain("精确像素 768 × 1024 优先");
    const ratio = qualityControls({ ...value, size: "3:4" }, selected);
    expect(ratio.option("resolution", "2k").props.disabled).toBe(false);
});

test("Grok reference mode retains the text-only quality preference but omits it from edits", () => {
    const value = config({ model: "grok", quality: "low", imageOptions: '{"resolution":"2k","nsfw_check":"false"}' });
    const selected = profile("grok");
    const withReference = qualityControls(value, selected, 1);
    expect(withReference.tree.filter(item => item.props["data-usage-control"] === "quality")).toHaveLength(0);
    expect(imageTaskParameters(value, selected, { referenceCount: 1 })).toEqual({ size: "1:1", resolution: "2k", nsfw_check: false });
    expect(qualityControls(value, selected).option("quality", "low").props["aria-pressed"]).toBe(true);
    expect(imageTaskParameters(value, selected)).toMatchObject({ quality: "low" });
});

test("compact advanced view retains every supported field and keeps the default panel unchanged", () => {
    for (const id of ["mark-flare", "mark-nano", "grok", "gpt-image-2", "vcen-gpt2", "nano-banana-2", "midjourney-v7", "midjourney-blend"]) {
        const selected = profile(id);
        const value = config({ model: id, ...normalizeImageModelSettings(defaultConfig, selected) });
        const compact = renderToStaticMarkup(<ImageSettingsPanel compact config={value} profile={selected} theme={canvasThemes.light} onConfigChange={noop} />);
        const standard = renderToStaticMarkup(<ImageSettingsPanel config={value} profile={selected} theme={canvasThemes.light} onConfigChange={noop} />);
        for (const field of imageOptionFields(selected).filter(field => field.key !== "resolution")) expect(compact).toContain(`aria-label="${field.label}"`);
        expect(compact).not.toContain('aria-label="宽高比"');
        expect(compact).not.toContain('class="ip-fixed-count"');
        expect(standard).toContain('aria-label="宽高比"');
        expect(standard).toContain('class="ip-fixed-count"');
        if (selected.customSize) {
            expect(compact).toContain('aria-label="自定义宽度"');
            expect(compact).toContain('aria-label="自定义高度"');
            expect(compact).toContain('<details class="ip-details" open="">');
        }
        if (selected.customAspect) expect(compact).toContain('aria-label="自定义宽高比"');
    }
});

// Execute the actual component and handlers with per-instance hook storage. No
// global React mocks, DOM, provider requests or production state are involved.
function componentModule(path: string) {
    const url = new URL(path, import.meta.url);
    const requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const slots: any[] = [];
    let cursor = 0;
    let effects: Array<() => void> = [];
    const react = { ...React,
        useId: () => "settings-test",
        useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
        useRef(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
        useEffect(effect: () => void, dependencies: any[]) { const index = cursor++; const previous = slots[index]; if (!previous || dependencies.some((value, i) => value !== previous[i])) effects.push(effect); slots[index] = dependencies; },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((id: string) => id === "@/lib/i18n" ? i18nHarness : ((name: string) => name === "react" ? react
        : name === "radix-ui" ? { Dialog, Popover }
            : name === "@/components/image-settings-panel" ? { ImageSettingsPanel, imageSizeLabel }
                : name === "@/lib/image-model-settings" ? { ...requireModule(name), useImageModelProfile: profile }
                    : requireModule(name))(id), module, module.exports);
    return { exports: module.exports, render<T>(render: (exports: any) => T) { cursor = 0; effects = []; const result = render(module.exports); effects.forEach(effect => effect()); return result; } };
}

test("menus open below their triggers without upward flipping and the spacious dialog is mutually exclusive", () => {
    const module = componentModule("../src/components/canvas/canvas-quick-settings-popovers.tsx");
    const changes: Array<[string, string]> = [];
    const props: Props = { config: config(), profile: profile("mark-flare"), theme: canvasThemes.dark, referenceCount: 0, disabled: false, onConfigChange: (key, value) => changes.push([key, value]) };
    const render = (patch: Partial<Props> = {}) => {
        const tree = module.render(exports => elements(exports.CanvasQuickSettingsPopovers({ ...props, ...patch })));
        return (id: string) => {
            const component = tree.find(item => item.props.id === id)!;
            return elements((component.type as (props: any) => ReactElement)(component.props));
        };
    };
    const root = (tree: ReactElement<any>[]) => tree.find(item => item.type === Popover.Root || item.type === Dialog.Root)!;
    const initial = render();
    for (const id of ["size", "quality", "advanced"]) expect(root(initial(id)).props.open).toBe(false);
    root(initial("size")).props.onOpenChange(true);
    const opened = render();
    expect(root(opened("size")).props.open).toBe(true);
    expect(root(opened("quality")).props.open).toBe(false);
    const portal = opened("size").find(item => item.type === Popover.Content)!;
    expect(portal.props).toMatchObject({ side: "bottom", align: "center", sideOffset: 10, collisionPadding: 12, avoidCollisions: false });
    expect(opened("size").find(item => item.type === Popover.Anchor)!.props.virtualRef).toBe(opened("quality").find(item => item.type === Popover.Anchor)!.props.virtualRef);
    expect(portal.props.style["--cw-parameter-panel"]).toBe(canvasThemes.dark.node.panel);
    const ratio = opened("size").find(item => item.type === module.exports.CanvasQuickRatioOptions)!;
    ratio.props.onChange("16:9");
    expect(changes).toEqual([["size", "16:9"]]);
    expect(root(render()("size")).props.open).toBe(false);
    root(render()("quality")).props.onOpenChange(true);
    expect(root(render()("quality")).props.open).toBe(true);
    root(render()("advanced")).props.onOpenChange(true);
    const advanced = render();
    expect(root(advanced("advanced")).props.open).toBe(true);
    expect(root(advanced("quality")).props.open).toBe(false);
    expect(advanced("advanced").find(item => item.type === ImageSettingsPanel)!.props.compact).toBe(true);
    expect(advanced("advanced").find(item => item.type === ImageSettingsPanel)!.props.spacious).toBe(true);
    expect(advanced("advanced").some(item => item.type === Dialog.Content)).toBe(true);
    expect(advanced("advanced").some(item => item.type === Popover.Content)).toBe(false);
    expect(root(render({ disabled: true })("advanced")).props.open).toBe(false);
    expect(root(render()("advanced")).props.open).toBe(false);
});

test("profile changes normalize resolution without opening the popover or overwriting unrelated advanced settings", () => {
    const module = componentModule("../src/components/canvas/canvas-quick-settings-popovers.tsx");
    const changes: Array<[string, string]> = [];
    const props: Props = { config: config({ imageOptions: '{"resolution":"0.5k","output_format":"webp"}' }), profile: profile("mark-flare"), theme: canvasThemes.light, referenceCount: 0, disabled: false, onConfigChange: (key, value) => changes.push([key, value]) };
    const tree = module.render(exports => elements(exports.CanvasQuickSettingsPopovers(props)));
    expect(changes).toEqual([["imageOptions", '{"resolution":"1k","output_format":"webp"}']]);
    expect(tree.filter(item => ["size", "quality", "advanced"].includes(item.props.id)).every(item => item.props.active === null)).toBe(true);
    changes.length = 0;
    module.render(exports => exports.CanvasQuickSettingsPopovers({ ...props, disabled: true }));
    expect(changes).toEqual([]);
});

test("every parameter popover has a persistent return action that only closes its current panel", () => {
    const module = componentModule("../src/components/canvas/canvas-quick-settings-popovers.tsx");
    const changes: Array<[string, string]> = [];
    const value = config({ imageOptions: '{"resolution":"2k","background":"transparent","output_format":"png"}' });
    const original = structuredClone(value);
    const props: Props = { config: value, profile: profile("mark-flare"), theme: canvasThemes.light, referenceCount: 3, disabled: false, onConfigChange: (key, next) => changes.push([key, next]) };
    const render = (id: string) => {
        const tree = module.render(exports => elements(exports.CanvasQuickSettingsPopovers(props)));
        const component = tree.find(item => item.props.id === id)!;
        return elements((component.type as (props: any) => ReactElement)(component.props));
    };
    const root = (tree: ReactElement<any>[]) => tree.find(item => item.type === Popover.Root)!;
    for (const id of ["size", "quality"]) {
        root(render(id)).props.onOpenChange(true);
        const opened = render(id);
        expect(root(opened).props.open).toBe(true);
        const content = opened.find(item => item.type === Popover.Content)!;
        const header = opened.find(item => item.type === "header")!;
        const body = opened.find(item => item.props.className === "cw-parameter-body")!;
        const close = elements(header.props.children).find(item => item.type === Popover.Close)!;
        expect(close.props.asChild).toBe(true);
        expect(close.props.children.type).toBe("button");
        expect(close.props.children.props).toMatchObject({ type: "button", "aria-label": "返回创建面板", children: "← 返回" });
        expect(close.props.children.props.onClick).toBeUndefined();
        expect(content.props.children).toEqual([header, body]);
        expect(elements(body.props.children).some(item => item.props.className === "cw-parameter-header")).toBe(false);
        // Radix Close calls the Root's controlled onOpenChange(false), and its
        // default close autofocus returns to this Root's trigger. Keep both
        // contracts intact rather than adding a config-mutating click handler.
        expect(content.props.onCloseAutoFocus).toBeUndefined();
        root(opened).props.onOpenChange(false);
        expect(root(render(id)).props.open).toBe(false);
        for (const other of ["size", "quality"]) expect(root(render(other)).props.open).toBe(false);
        expect(changes).toEqual([]);
        expect(value).toEqual(original);
        expect(props.referenceCount).toBe(3);
    }
    const css = readFileSync(new URL("../src/components/canvas/canvas-quick-settings-popovers.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.cw-parameter-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*flex:\s*0 0 auto;/);
    expect(css).toMatch(/\.cw-parameter-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
});

test("large advanced dialog keeps an accessible title, description and close actions without clearing settings", () => {
    const module = componentModule("../src/components/canvas/canvas-quick-settings-popovers.tsx");
    const changes: Array<[string, string]> = [];
    const value = config({ imageOptions: '{"resolution":"2k","background":"transparent","output_format":"png"}' });
    const before = structuredClone(value);
    const props: Props = { config: value, profile: profile("mark-flare"), theme: canvasThemes.dark, referenceCount: 2, disabled: false, onConfigChange: (key, next) => changes.push([key, next]) };
    const render = () => {
        const tree = module.render(exports => elements(exports.CanvasQuickSettingsPopovers(props)));
        const component = tree.find(item => item.props.id === "advanced")!;
        return elements((component.type as Function)(component.props));
    };
    render().find(item => item.type === Dialog.Root)!.props.onOpenChange(true);
    const opened = render();
    expect(opened.find(item => item.type === Dialog.Root)!.props.open).toBe(true);
    expect(opened.find(item => item.type === Dialog.Title)!.props.children).toBe("图像高级设置");
    expect(opened.some(item => item.type === Dialog.Description)).toBe(true);
    expect(opened.some(item => item.type === Dialog.Overlay)).toBe(true);
    const content = opened.find(item => item.type === Dialog.Content)!;
    expect(content.props.style["--cw-parameter-panel"]).toBe(canvasThemes.dark.node.panel);
    expect(content.props.onCloseAutoFocus).toBeUndefined();
    const closeButtons = opened.filter(item => item.type === Dialog.Close);
    expect(closeButtons).toHaveLength(2);
    expect(closeButtons[0]!.props.children.props["aria-label"]).toBe("返回创建面板");
    expect(closeButtons[1]!.props.children.props.children).toBe("完成设置");
    opened.find(item => item.type === Dialog.Root)!.props.onOpenChange(false);
    expect(render().find(item => item.type === Dialog.Root)!.props.open).toBe(false);
    expect(changes).toEqual([]);
    expect(value).toEqual(before);
});

test("compact advanced handlers keep transparency and JPEG mutually compatible in actual payloads", () => {
    const module = componentModule("../src/components/image-settings-panel.tsx");
    let value = config({ imageOptions: '{"resolution":"2k","background":"opaque","output_format":"jpeg","output_compression":"85"}' });
    const controls = () => module.render(exports => elements(exports.ImageSettingsPanel({ compact: true, config: value, profile: profile("mark-flare"), theme: canvasThemes.light, onConfigChange: (key: keyof AiConfig, next: string) => { value = { ...value, [key]: next }; } })));
    controls().find(item => item.props["aria-label"] === "背景")!.props.onChange({ target: { value: "transparent" } });
    expect(imageTaskParameters(value, profile("mark-flare"))).toEqual({ size: "1:1", quality: "high", resolution: "2k", background: "transparent", output_format: "png" });
    controls().find(item => item.props["aria-label"] === "输出格式")!.props.onChange({ target: { value: "jpeg" } });
    expect(imageTaskParameters(value, profile("mark-flare"))).toEqual({ size: "1:1", quality: "high", resolution: "2k", background: "opaque", output_format: "jpeg", output_compression: 85 });
});
