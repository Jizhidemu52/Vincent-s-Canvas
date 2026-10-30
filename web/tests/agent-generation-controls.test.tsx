import { expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { canvasThemes } from "@/lib/canvas-theme";
import { imageModelProfile } from "@/lib/image-model-settings";
import { defaultConfig } from "@/stores/use-config-store";
import { canvasToolKey } from "@/hooks/use-tool-config";
import type { AgentGenerationSettings } from "@/lib/agent-direct-generation";
import { videoModelCapabilities, type SupportedVideoModelId } from "../../server/src/video-models";

const requireModule = createRequire(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url));
const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function controls(patch: Partial<AgentGenerationSettings> = {}) {
    const changes: Partial<AgentGenerationSettings>[] = [];
    const effects: Array<() => void> = [];
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        // External image drops are not part of these generation-parameter controls.
        "@/hooks/use-image-drop": { useImageDrop: () => ({ dropProps: {}, dragging: false, reading: false }) },
        react: { ...React, useEffect: (effect: () => void) => effects.push(effect) },
        "@/lib/image-model-settings": { imageModelProfile, useImageModelProfile: (model: string) => imageModelProfile(model, []) },
        "@/hooks/use-tool-config": { canvasToolKey, useToolConfig: (config: unknown) => config },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code + "\nexports.controls = AgentGenerationControls;")((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const settings: AgentGenerationSettings = { mode: "image", imageModel: "vcen-gpt2", videoModel: "wan2.7", size: "3:4", quality: "2k", imageCount: "7", videoSeconds: "5", videoQuality: "1080P", videoGenerateAudio: "true", afterImage: "images_only", ...patch };
    const elements = findElements(module.exports.controls({ settings, config: defaultConfig, imageCapabilities: [{ id: settings.imageModel, name: settings.imageModel, modelId: settings.imageModel, capabilities: ["generate", "edit"], publicName: "出图模型1" }], videoCapabilities: [{ id: settings.videoModel, modelId: settings.videoModel, name: settings.videoModel, capability: videoModelCapabilities[settings.videoModel as SupportedVideoModelId] }], theme: canvasThemes.light, onChange: (change: Partial<AgentGenerationSettings>) => changes.push(change), loading: false, error: null, onRetry: () => undefined }));
    const content = elements.find((element) => element.props.content)?.props.content;
    return { markup: renderToStaticMarkup(content), elements, changes, effects };
}

function findElements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(findElements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...findElements(element.props.children)];
}

test("Agent parameters reflect standard pixel sizes and quality instead of fabricated resolution", () => {
    const result = controls({ imageModel: "gpt-image-2" });
    expect(result.markup).toContain('aria-label="宽高比"');
    expect(result.markup).toContain('value="1536x1024"');
    expect(result.markup).toContain('aria-label="画质"');
    expect(result.markup).not.toContain('value="4k"');
    result.effects.forEach((effect) => effect());
    expect(result.changes).toContainEqual({ size: "1152x1536", quality: "auto", imageCount: "1" });
});

test("Agent preserves Gemini 0.5K resolution but fixes every adapter to one task", () => {
    expect(controls({ imageModel: "nano-banana-2" }).markup).toContain(">0.5K</button>");
    const result = controls();
    const markup = result.markup;
    expect(markup).not.toContain("1 个任务");
    expect(markup).not.toContain('aria-label="生成张数"');
    expect(markup).not.toContain('type="range"');
    expect(markup).toContain(">4K</button>");
    result.effects.forEach((effect) => effect());
    expect(result.changes).toContainEqual(expect.objectContaining({ imageCount: "1" }));
});

test("Midjourney shows speed and reference policy, not resolution or a useless output count selector", () => {
    const markup = controls({ imageModel: "midjourney-v7" }).markup;
    expect(markup).toContain('aria-label="生成速度"');
    expect(markup).toContain(">极速</button>");
    expect(markup).not.toContain('aria-label="数量"');
    expect(markup).not.toContain('aria-label="分辨率"');
    expect(markup).toContain("参考图引导");
    expect(controls({ imageModel: "midjourney-blend" }).markup).toContain("2–4 张参考图");
});

test("switching an Agent image model atomically normalizes its illegal old parameters", () => {
    const result = controls();
    result.elements.find((element) => element.props.toolKey === "canvas-image")!.props.onChange("midjourney-v7");
    expect(result.changes.at(-1)).toMatchObject({ imageModel: "midjourney-v7", imageCount: "1", quality: "relax", size: "3:4" });
});

test("Agent only shows supported video audio and includes Seedance intelligent duration", () => {
    expect(controls({ mode: "video", videoModel: "wan2.7" }).markup).not.toContain("音频");
    const seedance = controls({ mode: "video", videoModel: "doubao-seedance-2.5", videoSeconds: "-1" }).markup;
    expect(seedance).toContain("音频");
    expect(seedance).toContain('value="-1"');
    expect(seedance).toContain("智能");
    expect(seedance).toContain('value="30"');
    expect(seedance).not.toContain('value="1080P"');
});

test("image and video generation models occupy a full-width row without narrow or fixed-height overrides", () => {
    for (const mode of ["image", "video"] as const) {
        const result = controls({ mode, imageModel: "gpt-image-2.5-flare" });
        const row = result.elements.find(element => element.props["data-testid"] === "canvas-agent-generation-model");
        expect(row).toBeDefined();
        expect(row!.props.className).toContain("col-span-2");
        expect(row!.props.className).toContain("min-w-0");
        expect(row!.props.className).toContain("w-full");
        const picker = findElements(row).find(element => element.props.toolKey);
        expect(picker).toBeDefined();
        expect(picker!.props.variant).toBe("canvas");
        expect(picker!.props.fullWidth).toBe(true);
        expect(picker!.props.className).toContain("h-auto");
        expect(picker!.props.className).toContain("min-h-11");
        expect(picker!.props.className).toContain("text-base");
        expect(picker!.props.className).not.toMatch(/h-8|max-w-\[(115|165)px\]|text-xs/);
        expect(picker!.props.value).toBe(mode === "image" ? "gpt-image-2.5-flare" : "wan2.7");
        expect(findElements(row).some(element => element.props.role === "tablist" || element.props.content)).toBe(false);
    }
});

test("type and settings controls stay together on a separate row with 44-pixel targets and unchanged mode changes", () => {
    const result = controls({ imageModel: "gpt-image-2.5-flare" });
    const actions = result.elements.find(element => element.props["data-testid"] === "canvas-agent-generation-actions");
    expect(actions).toBeDefined();
    const actionElements = findElements(actions);
    expect(actionElements.some(element => element.props.toolKey)).toBe(false);
    const image = actionElements.find(element => element.props.role === "tab" && element.props["aria-label"] === "图像")!;
    const video = actionElements.find(element => element.props.role === "tab" && element.props["aria-label"] === "视频")!;
    const settings = actionElements.find(element => element.type === "button" && element.props["aria-label"] === "图像设置")!;
    for (const control of [image, video, settings]) expect(control.props.className).toContain("size-11");
    video.props.onClick();
    expect(result.changes.at(-1)).toMatchObject({ mode: "video", videoModel: "wan2.7" });
    image.props.onClick();
    expect(result.changes.at(-1)).toMatchObject({ mode: "image", imageModel: "gpt-image-2.5-flare", imageCount: "1" });
});
