import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { canvasThemes } from "@/lib/canvas-theme";
import { imageModelProfile } from "@/lib/image-model-settings";
import { defaultConfig } from "@/stores/use-config-store";
import type { AgentGenerationSettings } from "@/lib/agent-direct-generation";
import { videoModelCapabilities, type SupportedVideoModelId } from "../../server/src/video-models";

const requireModule = createRequire(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url));
const source = readFileSync(new URL("../src/components/canvas/canvas-assistant-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function controls(patch: Partial<AgentGenerationSettings> = {}) {
    const changes: Partial<AgentGenerationSettings>[] = [];
    const effects: Array<() => void> = [];
    const dependencies: Record<string, unknown> = {
        react: { ...React, useEffect: (effect: () => void) => effects.push(effect) },
        "@/lib/image-model-settings": { imageModelProfile, useImageModelProfile: (model: string) => imageModelProfile(model, []) },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code + "\nexports.controls = AgentGenerationControls;")((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const settings: AgentGenerationSettings = { mode: "image", imageModel: "vcen-gpt2", videoModel: "wan2.7", size: "3:4", quality: "2k", imageCount: "7", videoSeconds: "5", videoQuality: "1080P", videoGenerateAudio: "true", afterImage: "images_only", ...patch };
    const elements = findElements(module.exports.controls({ settings, config: defaultConfig, imageCapabilities: [{ id: settings.imageModel, name: settings.imageModel, modelId: settings.imageModel }], videoCapabilities: [{ id: settings.videoModel, modelId: settings.videoModel, name: settings.videoModel, capability: videoModelCapabilities[settings.videoModel as SupportedVideoModelId] }], theme: canvasThemes.light, onChange: (change: Partial<AgentGenerationSettings>) => changes.push(change), loading: false, error: null, onRetry: () => undefined }));
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
    expect(result.markup).toContain('aria-label="尺寸"');
    expect(result.markup).toContain('value="1536x1024"');
    expect(result.markup).toContain('aria-label="画质"');
    expect(result.markup).not.toContain('value="4k"');
    result.effects.forEach((effect) => effect());
    expect(result.changes).toContainEqual({ size: "1024x1024", quality: "auto", imageCount: "7" });
});

test("Agent exposes 0.5K for Gemini and ten images for supported adapters", () => {
    expect(controls({ imageModel: "nano-banana-2" }).markup).toContain('value="0.5k"');
    const markup = controls().markup;
    expect(markup).toContain('value="10"');
    expect(markup).toContain('value="4k"');
});

test("Midjourney shows speed and reference policy, not resolution or a useless output count selector", () => {
    const markup = controls({ imageModel: "midjourney-v7" }).markup;
    expect(markup).toContain('aria-label="生成速度"');
    expect(markup).toContain('value="turbo"');
    expect(markup).not.toContain('aria-label="数量"');
    expect(markup).not.toContain('aria-label="分辨率"');
    expect(markup).toContain("参考图引导");
    expect(controls({ imageModel: "midjourney-blend" }).markup).toContain("2–4 张参考图");
});

test("switching an Agent image model atomically normalizes its illegal old parameters", () => {
    const result = controls();
    result.elements.find((element) => typeof element.props.onValueChange === "function")!.props.onValueChange("midjourney-v7");
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
