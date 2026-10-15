import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { imageAdvancedParameters, imageOptionFields } from "@/lib/image-advanced-settings";
import { imageModelProfile } from "@/lib/image-model-settings";
import { defaultConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function settings(model: string, initialOptions: Record<string, string> = {}) {
    const url = new URL("../src/components/image-settings-panel.tsx", import.meta.url);
    const localRequire = createRequire(url);
    const profile = imageModelProfile(model, []);
    const states: unknown[] = [];
    const changes: Array<[string, string]> = [];
    let cursor = 0;
    let config = { ...defaultConfig, model, size: profile.sizes[0] || "1024x1024", imageOptions: JSON.stringify(initialOptions) };
    const dependencies: Record<string, unknown> = {
        react: { ...React, useEffect() {}, useId: () => "spacious-settings", useState: (initial: unknown) => {
            const index = cursor++;
            if (!(index in states)) states[index] = initial;
            return [states[index], (value: unknown) => { states[index] = value; }];
        } },
        "@/lib/image-model-settings": { ...localRequire("@/lib/image-model-settings"), useImageModelProfile: () => profile },
    };
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const module = { exports: {} as { ImageSettingsPanel: (props: any) => ReactElement<any> } };
    new Function("require", "module", "exports", code)((name: string) => name.endsWith(".css") ? {} : dependencies[name] || localRequire(name), module, module.exports);
    const render = (patch: Record<string, unknown> = {}) => {
        cursor = 0;
        return elements(module.exports.ImageSettingsPanel({ config, theme: canvasThemes.light, profile, compact: true, spacious: true, showTitle: false,
            onConfigChange: (key: keyof typeof config, value: string) => { changes.push([key, value]); config = { ...config, [key]: value }; }, ...patch }));
    };
    const choose = (field: string, value: string) => {
        const control = render().find(item => item.type === "input" && item.props.type === "radio" && item.props["data-image-option"] === field && item.props.value === value);
        expect(control).toBeDefined();
        control!.props.onChange({ target: { value, checked: true } });
    };
    return { render, choose, changes, profile, options: () => JSON.parse(config.imageOptions), config: () => config };
}

test("spacious mode groups exact pixels and supported advanced settings without changing the default layout", () => {
    const profile = imageModelProfile("gpt-image-2.5-sunburst", []);
    const props = { config: { ...defaultConfig, model: "gpt-image-2.5-sunburst" }, profile, theme: canvasThemes.light, onConfigChange() {}, compact: true, showTitle: false };
    const old = renderToStaticMarkup(<ImageSettingsPanel {...props} />);
    const wide = renderToStaticMarkup(<ImageSettingsPanel {...props} spacious />);
    expect(old).toContain("ip-details");
    expect(old).not.toContain("ip-spacious");
    expect(wide).toContain("ip-spacious");
    expect(wide).toContain("ip-size-grid");
    expect(wide).toContain("ip-options-grid");
    expect(wide).not.toContain("<details");
    expect(wide).toContain("自定义像素");
    expect(wide).toContain("全部高级参数");
    expect(wide).not.toContain('data-image-option="resolution"');
    for (const key of ["background", "output_format", "output_compression"]) expect(wide).toContain(`data-image-field="${key}"`);
});

test("boolean choices retain explicit false, channel default removal, and model-specific field limits", () => {
    const panel = settings("gemini-3.1-flash-image-preview");
    panel.choose("nsfw_check", "false");
    expect(panel.options()).toEqual({ nsfw_check: "false" });
    expect(imageAdvancedParameters(panel.config().imageOptions, panel.profile)).toEqual({ nsfw_check: false });
    panel.choose("google_image_search", "true");
    expect(imageAdvancedParameters(panel.config().imageOptions, panel.profile)).toEqual({ nsfw_check: false, google_image_search: true, google_search: true });
    panel.choose("nsfw_check", "");
    expect(panel.options()).toEqual({ google_image_search: "true" });
    expect(panel.render().filter(item => item.props["data-image-field"]).map(item => item.props["data-image-field"])).toEqual(imageOptionFields(panel.profile).map(field => field.key));
});

test("clickable background and format choices preserve JPEG transparency coupling and compression gating", () => {
    const panel = settings("gpt-image-2.5-flare", { output_format: "jpeg", output_compression: "0" });
    panel.choose("background", "transparent");
    expect(panel.options()).toEqual({ output_format: "png", output_compression: "0", background: "transparent" });
    const compression = () => panel.render().find(item => item.type === "input" && item.props["aria-label"] === "输出压缩质量")!;
    expect(compression().props.disabled).toBe(true);
    expect(compression().props.min).toBe(0);
    expect(compression().props.max).toBe(100);
    expect(compression().props.step).toBe(1);
    expect(compression().props.value).toBe("0");
    panel.choose("output_format", "jpeg");
    expect(panel.options().background).toBe("opaque");
    expect(compression().props.disabled).toBe(false);
    expect(imageAdvancedParameters(panel.config().imageOptions, panel.profile)).toEqual({ background: "opaque", output_format: "jpeg", output_compression: 0 });
});

test("numeric and JSON cards retain schema validation and serialize real values", () => {
    const panel = settings("midjourney");
    let tree = panel.render();
    const number = tree.find(item => item.type === "input" && item.props["aria-label"] === "图像权重 --iw")!;
    expect([number.props.min, number.props.max, number.props.step]).toEqual([0, 3, 0.1]);
    number.props.onChange({ target: { value: "1.5" } });
    tree = panel.render();
    const metadata = tree.find(item => item.type === "textarea" && item.props["aria-label"] === "任务附加信息 JSON")!;
    expect(metadata).toBeDefined();
    metadata.props.onChange({ target: { value: '{"job":"cloth"}' } });
    expect(imageAdvancedParameters(panel.config().imageOptions, panel.profile)).toEqual({ iw: 1.5, metadata: { job: "cloth" } });
    expect(tree.filter(item => item.props["data-image-field"]).map(item => item.props["data-image-field"])).toEqual(imageOptionFields(panel.profile).map(field => field.key));
    number.props.onChange({ target: { value: "4" } });
    expect(() => imageAdvancedParameters(panel.config().imageOptions, panel.profile)).toThrow("0–3");
});

test("large custom dimension controls preserve positive-number fallback and optional 16-pixel alignment", () => {
    const panel = settings("gpt-image-2.5-sunburst");
    const inputFor = (name: string) => panel.render().find(item => item.type === "input" && item.props["aria-label"] === name)!;
    const width = { value: "1001" };
    inputFor("自定义宽度").props.onBlur({ currentTarget: width });
    expect(panel.config().size).toBe("1001x1024");
    panel.render().find(item => item.type === "input" && item.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
    expect(inputFor("自定义宽度").props.step).toBe(16);
    const alignedWidth = { value: "1001" };
    inputFor("自定义宽度").props.onBlur({ currentTarget: alignedWidth });
    expect(alignedWidth.value).toBe("1008");
    expect(panel.config().size).toBe("1008x1024");
    inputFor("自定义高度").props.onBlur({ currentTarget: { value: "-1" } });
    expect(panel.config().size).toBe("1008x1024");
});

test("Blend excludes duplicate dimensions and unverified models never gain invented advanced controls", () => {
    const blend = settings("midjourney-blend");
    const keys = blend.render().filter(item => item.props["data-image-field"]).map(item => item.props["data-image-field"]);
    expect(keys).toEqual(["nsfw_check", "metadata"]);
    const unknown = settings("opaque-unknown-model");
    expect(unknown.render().some(item => item.props["data-image-field"])).toBe(false);
});
