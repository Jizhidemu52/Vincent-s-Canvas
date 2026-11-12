import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import * as antd from "antd";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";
import { defaultVideoMotionSettings } from "../../shared/video-motion-options";
import { i18nHarness } from "./helpers/i18n-harness";

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
const image = { id: "old-image", name: "old.png", type: "image/png", mimeType: "image/png", dataUrl: "blob:old-image", storageKey: "image:old", width: 1024, height: 1024, bytes: 10 };
const config = { ...defaultConfig, model: "doubao-seedance-2.5", videoModel: "doubao-seedance-2.5", videoMode: "reference", size: "16:9", vquality: "720p", videoSeconds: "5" };
const media = (kind: "video" | "audio", suffix: string) => ({ id: `${kind}-${suffix}`, name: `${suffix}.${kind === "video" ? "mp4" : "wav"}`, type: kind === "video" ? "video/mp4" : "audio/wav", url: `blob:${kind}-${suffix}`, storageKey: `${kind}:${suffix}`, bytes: 10, durationMs: 4000, width: 1280, height: 720, fps: 24 });
const log = {
    id: "history", title: "历史视频", prompt: "历史提示词", model: config.videoModel, config,
    createdAt: 100, durationMs: 100, status: "成功", references: [image],
    videoReferences: [media("video", "old")], audioReferences: [media("audio", "old")],
    video: { id: "result", url: "blob:result", storageKey: "video:result", mimeType: "video/mp4", width: 1280, height: 720, bytes: 100, durationMs: 100 },
};

function elements(node: unknown): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

/** Execute the real page and preview loader; delay only the historical image read. */
function harness() {
    const path = new URL("../src/pages/video/index.tsx", import.meta.url);
    const requireModule = createRequire(path);
    const states: any[] = [], refs: any[] = [];
    const effects: Array<{ deps?: readonly unknown[]; cleanup?: (() => void) | void }> = [];
    const pending: Array<() => void> = [];
    const drafts = new Map<string, any>();
    const confirmations: Array<{ onOk: () => unknown }> = [];
    const submissions: unknown[] = [], errors: string[] = [];
    let stateIndex = 0, refIndex = 0, effectIndex = 0;
    let completeRead!: (value: string) => void;
    let rejectRead!: (error: Error) => void;
    const delayedRead = new Promise<string>((resolve, reject) => { completeRead = resolve; rejectRead = reject; });
    const useState = (initial: any) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    };
    const userState = { user: { id: "owner", status: "active", creditBalance: 100 }, status: "authenticated" };
    const dependencies: Record<string, any> = {
        react: { ...React, useState, useRef: (initial: any) => refs[refIndex++] ||= { current: initial }, useCallback: (callback: any) => callback, useMemo: (factory: () => any) => factory(),
            useEffect: (effect: () => any, deps?: readonly unknown[]) => {
                const index = effectIndex++, previous = effects[index];
                if (previous && deps && previous.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
                pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
            } },
        antd: { ...antd, App: { useApp: () => ({ message: { error: (text: string) => errors.push(text), warning() {}, success() {}, info() {} }, modal: { confirm: (value: any) => confirmations.push(value) } }) } },
        "@/lib/i18n": i18nHarness,
        "@/components/workbench-tasks": { WorkbenchTasks: ({ children }: any) => children.type(children.props), useWorkbenchTask: () => ({ id: "default", active: true, ready: true, creating: false, draftScope: (key: string) => key }), useWorkbenchTaskStatus() {} },
        "@/hooks/use-generation-draft": { useGenerationDraft: (key: string, initial: any) => {
            if (!drafts.has(key)) drafts.set(key, key.endsWith(":settings") ? { ...config } : initial);
            return [drafts.get(key), (next: any) => drafts.set(key, typeof next === "function" ? next(drafts.get(key)) : next), true];
        } },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => ({ iterate: async (visit: any) => visit(log), setItem: async () => undefined }) },
        "@/hooks/use-prompt-url-handoff": { isOrdinaryPromptUrl: () => false, usePromptUrlHandoff() {} },
        "@/hooks/use-image-drop": { useImageDrop: () => ({ dropProps: {}, dragging: false, reading: false }) },
        "@/hooks/use-unsaved-guard": { useUnsavedGuard() {} },
        "@/hooks/use-result-canvas": { useResultCanvas: () => ({ enabled: false, busy: false }) },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/hooks/use-tool-config": { useToolConfig: (value: any) => value },
        "@/stores/use-user-store": { useUserStore: Object.assign((select: any) => select(userState), { getState: () => userState }) },
        "@/stores/use-asset-store": { useAssetStore: (select: any) => select({ addAsset() {} }) },
        "@/stores/use-theme-store": { useThemeStore: (select: any) => select({ theme: "light" }) },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config, useConfigStore: (select: any) => select({ openConfigDialog() {} }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: any) => select({ status: "ready", models: [{ id: "video-model", modelId: config.videoModel, capabilities: ["video"] }], tools: [{ toolKey: "video", allowRawPrompt: true }], estimate: () => ({ credits: 0, configured: true }) }) },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "@/services/image-storage": { resolveImageUrl: async (key: string) => key === "image:old" ? delayedRead : `blob:${key}`, uploadImage: async () => ({ ...image, id: "new-image", url: "blob:new-image", storageKey: "image:new" }) },
        "@/services/file-storage": { resolveMediaUrl: async (key: string) => `blob:${key}`, uploadMediaFile: async (_file: File, kind: "video" | "audio") => media(kind, "new") },
        "@/lib/video-reference-files": { readReferenceMediaFile: async (file: File) => ({ ...media(file.type.startsWith("video") ? "video" : "audio", "new"), name: file.name }) },
        "@/services/api/video": { createVideoGenerationTask: (...args: unknown[]) => { submissions.push(args); throw new Error("No generation allowed in restore tests"); } },
        "react-router-dom": { useSearchParams: () => [new URLSearchParams()], useLocation: () => ({ key: "restore-test" }) },
    };
    const compile = (file: URL) => ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const workspace = { exports: {} };
    new Function("require", "module", "exports", compile(new URL("../src/hooks/use-generation-workspace.ts", import.meta.url)))((name: string) => dependencies[name], workspace, workspace.exports);
    dependencies["@/hooks/use-generation-workspace"] = workspace.exports;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "window", compile(path))((name: string) => name.endsWith(".css") ? {} : dependencies[name] || requireModule(name), module, module.exports, {});
    const render = () => {
        stateIndex = refIndex = effectIndex = 0;
        const page = module.exports.default();
        const tree = page.type(page.props);
        pending.splice(0).forEach(effect => effect());
        return tree;
    };
    const find = (name: string) => elements(render()).find(element => element.type?.name === name)!;
    const unmount = () => effects.forEach(effect => effect.cleanup?.());
    cleanups.push(unmount);
    return { render, find, drafts, submissions, errors, completeRead, rejectRead, userState, unmount,
        async restore() {
            render(); await settle(); render(); await settle();
            const history = find("LogPanel");
            history.props.onPreviewLog(history.props.logs[0]); await settle();
            elements(render()).find(element => element.props.children === "恢复为草稿继续改")!.props.onClick();
            await confirmations.at(-1)!.onOk(); await settle(); render();
        },
        async upload(kind: "image" | "video" | "audio") {
            const input = elements(render()).find(element => element.type === "input" && String(element.props.accept).startsWith(`${kind}/`))!;
            input.props.onChange({ target: { files: [new File(["fixture"], kind === "image" ? "new.png" : kind === "video" ? "new.mp4" : "new.wav", { type: `${kind}/${kind === "image" ? "png" : kind === "video" ? "mp4" : "wav"}` })], value: "" } });
            await settle(); render();
        },
    };
}

for (const kind of ["image", "video", "audio"] as const) test(`late historical media cannot replace a newer ${kind} reference upload`, async () => {
    const app = harness(); await app.restore(); await app.upload(kind);
    const field = kind === "image" ? "video:references" : kind === "video" ? "video:videos" : "video:audios";
    const before = structuredClone(app.drafts.get(field));
    expect(before).toHaveLength(1); expect(before[0].storageKey).toBe(`${kind}:new`);
    app.completeRead("blob:old-restored"); await settle(); app.render();
    expect(app.drafts.get(field)).toEqual(before);
    for (const other of ["video:references", "video:videos", "video:audios"]) if (other !== field) expect(app.drafts.get(other)).toEqual([]);
    expect(app.submissions).toHaveLength(0);
});

for (const field of ["prompt", "config", "motion", "raw"] as const) test(`an explicit ${field} change makes a pending historical draft restoration obsolete`, async () => {
    const app = harness(); await app.restore();
    if (field === "prompt") elements(app.render()).find(element => element.props["aria-label"] === "视频提示词")!.props.onChange({ target: { value: "新的提示词" } });
    if (field === "config") {
        elements(app.render()).find(element => element.props.children === "调整")!.props.onClick();
        app.find("GenerationSettings").props.updateConfig("videoSeconds", "12");
    }
    if (field === "motion") {
        // Restore selected an archived raw request; switch to the editable motion form first.
        elements(app.render()).find(element => element.props.children === "不经 AI 整理，直接发送")!.props.onChange({ target: { checked: false } });
        app.find("VideoMotionPanel").props.onChange({ ...defaultVideoMotionSettings, subject_action: ["turn"] });
    }
    if (field === "raw") elements(app.render()).find(element => element.props.children === "不经 AI 整理，直接发送")!.props.onChange({ target: { checked: false } });
    const before = structuredClone([...app.drafts]);
    app.completeRead("blob:old-restored"); await settle(); app.render();
    expect([...app.drafts]).toEqual(before);
    expect(app.submissions).toHaveLength(0);
});

test("an unchanged explicit restoration still resolves every archived media kind", async () => {
    const app = harness(); await app.restore(); app.completeRead("blob:old-restored"); await settle(); app.render();
    expect(app.drafts.get("video:references")).toMatchObject([{ storageKey: "image:old", dataUrl: "blob:old-restored" }]);
    expect(app.drafts.get("video:videos")).toMatchObject([{ storageKey: "video:old" }]);
    expect(app.drafts.get("video:audios")).toMatchObject([{ storageKey: "audio:old" }]);
    expect(app.submissions).toHaveLength(0);
});

test("a failed historical media read preserves the user's newer references and exposes its error", async () => {
    const app = harness(); await app.restore(); await app.upload("image");
    app.rejectRead(new Error("FIXTURE_OLD_MEDIA_MISSING")); await settle();
    expect(app.drafts.get("video:references")).toMatchObject([{ storageKey: "image:new" }]);
    expect(elements(app.render()).some(element => element.props.children === "FIXTURE_OLD_MEDIA_MISSING")).toBe(true);
    expect(app.submissions).toHaveLength(0);
});
