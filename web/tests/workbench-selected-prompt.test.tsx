import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import * as antd from "antd";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";
import { createSceneForm } from "@/pages/creative/scene-form-model";
import type { SceneLog } from "@/pages/creative/use-scene-workspace";

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const image = { id: "reference", name: "current.png", type: "image/png", mimeType: "image/png", dataUrl: "blob:current", storageKey: "image:current", width: 100, height: 100, bytes: 10 };
const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", videoModel: "MiniMax-H3", size: "1024x1024", quality: "auto", count: "1" };
const sceneLog: SceneLog = {
    id: "scene-log", ownerId: "owner", sceneId: "style-to-sketch", createdAt: 100,
    prompt: "原任务完整提示词：保留领口结构。", form: { ...createSceneForm("style-to-sketch"), description: "旧任务描述" },
    referenceImages: { primary: { ...image, id: "old-reference", storageKey: "image:old-reference" } },
    config: { ...config, imageModel: "old-model" },
    images: [{ ...image, id: "generated", storageKey: "image:generated" }],
    results: [{ id: "slot", status: "success", image: { ...image, id: "generated", storageKey: "image:generated" } }],
    durationMs: 100, successCount: 1, failCount: 0,
};
const videoLog = {
    id: "video-log", createdAt: 100, title: "旧视频", prompt: "原视频提示词：镜头缓慢推进。", time: "", model: "old-model",
    config: { ...config, videoModel: "old-video-model", size: "16:9", vquality: "2K", videoSeconds: "9" },
    references: [{ ...image, id: "old-reference", storageKey: "image:old-reference" }], videoReferences: [], audioReferences: [],
    durationMs: 100, size: "16:9", resolution: "2K", seconds: "9", status: "成功",
    video: { id: "video-result", url: "blob:video", storageKey: "video:result", width: 1280, height: 720, bytes: 100, durationMs: 100, mimeType: "video/mp4" },
};

function harness(kind: "video" | "creative", resolveImage?: (key?: string, fallback?: string) => Promise<string>) {
    const path = new URL(kind === "video" ? "../src/pages/video/index.tsx" : "../src/pages/creative/use-scene-workspace.ts", import.meta.url);
    const requireModule = createRequire(path);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const states: unknown[] = [], refs: Array<{ current: unknown }> = [];
    const effects: Array<{ deps?: readonly unknown[]; cleanup?: (() => void) | void }> = [];
    const pendingEffects: Array<() => void> = [];
    let stateIndex = 0, refIndex = 0, effectIndex = 0, prompt = "当前草稿";
    let toolEnabled = true;
    const currentConfig = { ...config };
    const reads: string[] = [], writes: unknown[] = [], submissions: unknown[] = [];
    const draft = { form: { ...createSceneForm("style-to-sketch"), description: "当前草稿" }, images: { primary: image }, config: currentConfig };
    const useState = (initial: any) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    };
    const dependencies: Record<string, unknown> = {
        react: { ...React, useState, useRef: (initial: unknown) => refs[refIndex++] ||= { current: initial }, useMemo: (factory: () => unknown) => factory(),
            useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]) {
                const index = effectIndex++, prior = effects[index];
                if (prior && deps && prior.deps?.length === deps.length && deps.every((value, i) => Object.is(value, prior.deps![i]))) return;
                pendingEffects.push(() => { prior?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
            } },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => ({
            async getItem(key: string) { return key.startsWith("draft:") ? draft : [sceneLog]; },
            async setItem(_key: string, value: unknown) { writes.push(value); },
            async iterate(callback: (log: unknown) => void) { callback(videoLog); },
        }) },
        "@/hooks/use-workbench-field": { useWorkbenchField: () => [prompt, (next: string) => { prompt = next; }] },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/hooks/use-tool-config": {
            useToolConfig: (value: typeof currentConfig) => value,
            useToolEnabled: (key: string) => toolEnabled && ["video", "creative-style-to-sketch"].includes(key),
        },
        "@/stores/use-module-store": { useModuleEnabled: (key: string) => key === "creative-selection" },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => currentConfig, useConfigStore: (select: Function) => select({ config: currentConfig, updateConfig: (key: string, value: unknown) => { (currentConfig as any)[key] = value; } }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ status: "ready", models: [{ id: "gpt-image-2", modelId: "gpt-image-2", capabilities: ["generate", "edit"] }], estimate: () => ({ credits: 0, configured: true }) }) },
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ user: { id: "owner", status: "active", creditBalance: 100 } }) },
        "@/stores/use-asset-store": { useAssetStore: (select: Function) => select({ addAsset: () => undefined }) },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/lib/image-model-settings": { ...requireModule("@/lib/image-model-settings"), useImageModelProfile: () => requireModule("@/lib/image-model-settings").imageModelProfile("gpt-image-2") },
        "@/services/image-storage": { resolveImageUrl: async (key?: string, fallback?: string) => { reads.push(key || fallback || ""); return resolveImage ? resolveImage(key, fallback) : `blob:${key}`; } },
        "@/services/file-storage": { resolveMediaUrl: async (key: string) => { reads.push(key); return `blob:${key}`; } },
        "@/services/api/image": { requestGeneration: (...args: unknown[]) => { submissions.push(args); throw new Error("unexpected generation"); }, requestEdit: (...args: unknown[]) => { submissions.push(args); throw new Error("unexpected edit"); } },
        "@/services/api/video": { createVideoGenerationTask: (...args: unknown[]) => { submissions.push(args); throw new Error("unexpected video generation"); } },
        "react-router-dom": { useSearchParams: () => [new URLSearchParams()] },
        antd: { ...antd, App: { useApp: () => ({ message: { error() {}, warning() {}, success() {}, info() {} }, modal: {} }) } },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "window", code)((name: string) => dependencies[name] || requireModule(name), module, module.exports, {});
    const render = () => {
        stateIndex = refIndex = effectIndex = 0;
        const output = kind === "creative" ? module.exports.useSceneWorkspace("style-to-sketch") : module.exports.default();
        pendingEffects.splice(0).forEach(effect => effect());
        return output;
    };
    return { render, reads, writes, submissions, currentConfig, get prompt() { return prompt; }, setPrompt: (value: string) => { prompt = value; }, setToolEnabled: (value: boolean) => { toolEnabled = value; }, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

test("video record selection fills only its prompt and never replaces current model or reference inputs", async () => {
    const app = harness("video");
    app.render(); await settle();
    const before = { ...app.currentConfig };
    const history = elements(app.render()).find(element => (element.type as Function).name === "LogPanel")!;
    app.reads.length = 0;
    history.props.onPreviewLog(history.props.logs[0]); await settle();
    expect(app.prompt).toBe("原视频提示词：镜头缓慢推进。");
    expect(app.currentConfig).toEqual(before);
    expect(app.reads).toEqual(["video:result"]);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("clicking an already displayed video returns its own prompt without submitting a task", async () => {
    const app = harness("video");
    app.render(); await settle(); app.render(); await settle();
    app.setPrompt("改过的草稿");
    const card = elements(app.render()).find(element => (element.type as Function).name === "ResultVideoCard")!;
    const video = elements((card.type as Function)(card.props)).find(element => element.type === "video")!;
    expect(typeof video.props.onClick).toBe("function");
    video.props.onClick();
    expect(app.prompt).toBe("原视频提示词：镜头缓慢推进。");
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("video full input restoration remains available only through its explicit restore button", async () => {
    const app = harness("video");
    app.render(); await settle();
    const history = elements(app.render()).find(element => (element.type as Function).name === "LogPanel")!;
    history.props.onPreviewLog(history.props.logs[0]); await settle();
    const restore = elements(app.render()).find(element => element.props.children === "恢复为草稿继续改")!;
    expect(restore).toBeDefined();
    app.reads.length = 0;
    restore.props.onClick(); await settle();
    expect(app.currentConfig.videoModel).toBe("old-video-model");
    expect(app.reads.sort()).toEqual(["image:old-reference", "video:result"]);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("creative record preview exposes the exact archived prompt but preserves the current form, model and references", async () => {
    const app = harness("creative");
    app.render(); await settle();
    const before = app.render();
    expect(typeof before.previewLog).toBe("function");
    app.reads.length = 0;
    await before.previewLog(sceneLog);
    const selected = app.render();
    expect(selected.selectedPrompt).toBe("原任务完整提示词：保留领口结构。");
    expect(selected.form).toEqual(before.form);
    expect(selected.config).toEqual(before.config);
    expect(selected.images).toEqual(before.images);
    expect(selected.results[0].image.dataUrl).toBe("blob:image:generated");
    expect(app.reads).toEqual(["image:generated"]);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("creative previews cannot accept another account or scene and a late older preview cannot replace a newer selection", async () => {
    let slow = false, finish!: (url: string) => void;
    const app = harness("creative", async key => slow && key === "image:generated" ? new Promise<string>(resolve => { finish = resolve; }) : `blob:${key}`);
    app.render(); await settle();
    const workspace = app.render();
    await workspace.previewLog({ ...sceneLog, ownerId: "other-owner" });
    await workspace.previewLog({ ...sceneLog, sceneId: "other-scene" });
    expect(app.render().selectedPrompt).toBeNull();
    slow = true;
    const old = app.render().previewLog(sceneLog);
    const newer = { ...sceneLog, id: "newer-log", prompt: "新选中的原提示词", results: [{ ...sceneLog.results[0], id: "newer-slot", image: { ...image, id: "newer-image", storageKey: "image:newer" } }] };
    await app.render().previewLog(newer);
    finish("blob:older"); await old;
    expect(app.render().selectedPrompt).toBe("新选中的原提示词");
    expect(app.render().results[0].image.id).toBe("newer-image");
    expect(app.render().previewing).toBe(false);
    app.unmount();
});

test("editing creative parameters while a preview loads cancels the spinner and late result without altering the new inputs", async () => {
    let slow = false, finish!: (url: string) => void;
    const app = harness("creative", async key => slow && key === "image:generated" ? new Promise<string>(resolve => { finish = resolve; }) : `blob:${key}`);
    app.render(); await settle(); app.render();
    slow = true;
    const pending = app.render().previewLog(sceneLog);
    app.render().updateConfig("size", "1536x1024");
    expect(app.render().previewing).toBe(false);
    finish("blob:older"); await pending;
    expect(app.render().config.size).toBe("1536x1024");
    expect(app.render().config.count).toBe("1");
    expect(app.render().results).toEqual([]);
    app.unmount();
});

test("creative result selection only accepts an explicit result of this owner and scene", async () => {
    const app = harness("creative");
    app.render(); await settle();
    const workspace = app.render();
    expect(typeof workspace.selectResultPrompt).toBe("function");
    workspace.selectResultPrompt(sceneLog.results[0]);
    expect(app.render().selectedPrompt).toBe("原任务完整提示词：保留领口结构。");
    app.render().setForm({ ...workspace.form, description: "新草稿" });
    app.render().selectResultPrompt({ ...sceneLog.results[0], id: "unrelated", image: { ...image, id: "unrelated" } });
    expect(app.render().selectedPrompt).toBeNull();
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});

test("disabling a creative tool preserves archived preview and current draft but prevents generation", async () => {
    const app = harness("creative");
    app.render(); await settle();
    const before = app.render();
    app.setToolEnabled(false);
    expect(app.render().validation).toBe("当前创意场景已停用，原有草稿和结果仍保留");
    await app.render().generate();
    await app.render().previewLog(sceneLog);
    expect(app.render().form).toEqual(before.form);
    expect(app.render().selectedPrompt).toBe(sceneLog.prompt);
    expect(app.submissions).toHaveLength(0);
    app.unmount();
});
