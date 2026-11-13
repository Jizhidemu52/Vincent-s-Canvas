import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import ts from "typescript";
import * as antd from "antd";
import { defaultConfig } from "@/stores/use-config-store";
import { i18nHarness } from "./helpers/i18n-harness";
import { createVideoPlaybackResolver } from "../src/hooks/use-video-playback";

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
afterEach(() => { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const original = { id: "video-1", url: "blob:original", storageKey: "video:original", width: 0, height: 0, bytes: 100, durationMs: 100000, mimeType: "video/mp4", serverAssetId: "7075c394-1184-44cc-9077-068d78e8b36d" };
const logs = [
    { id: "log-1", status: "成功", createdAt: 100, title: "原视频", prompt: "原提示词", config: defaultConfig, video: original, references: [], videoReferences: [], audioReferences: [] },
    { id: "log-2", status: "成功", createdAt: 99, title: "本地视频", prompt: "第二条", config: defaultConfig, video: { ...original, id: "video-2", serverAssetId: undefined }, references: [], videoReferences: [], audioReferences: [] },
];

function elements(node: unknown): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

function harness(playback: (id: string, options: { signal: AbortSignal }) => Promise<{ blob: Blob; width?: number; height?: number }>) {
    const path = new URL("../src/pages/video/index.tsx", import.meta.url);
    const requireModule = createRequire(path);
    const states: any[] = [], refs: any[] = [], effects: Array<{ deps?: readonly unknown[]; cleanup?: (() => void) | void }> = [], pending: Array<() => void> = [];
    let stateIndex = 0, refIndex = 0, effectIndex = 0;
    let urlInputKey: string | null = null;
    const location = { pathname: "/video", search: "", hash: "", state: null, key: "video-playback" };
    const unexpectedNavigation = () => { throw new Error("Playback preview must not navigate or consume a prompt URL"); };
    const writes: unknown[] = [];
    const useState = (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; };
    const workspace: Record<string, any> = { logs: [], running: false, startedAt: 0, activeTaskId: null, previewLoading: false, logsOpen: false, settingsOpen: false, promptDialogOpen: false, assetPickerOpen: false, selectedLogIds: [], previewLog: null, deleteConfirmOpen: false, deletingLogs: false };
    for (const key of Object.keys(workspace)) workspace[`set${key[0]!.toUpperCase()}${key.slice(1)}`] = (value: any) => { workspace[key] = typeof value === "function" ? value(workspace[key]) : value; };
    const deps: Record<string, any> = {
        react: { ...React, useState, useRef: (initial: any) => refs[refIndex++] ||= { current: initial }, useCallback: (callback: any) => callback, useEffect: (effect: () => any, values?: readonly unknown[]) => {
            const index = effectIndex++, previous = effects[index];
            if (previous && values && previous.deps?.length === values.length && values.every((value, i) => Object.is(value, previous.deps![i]))) return;
            pending.push(() => { previous?.cleanup?.(); effects[index] = { deps: values, cleanup: effect() }; });
        } },
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-display-text": { useDisplayText: () => (text: string) => text, DisplayText: ({ text }: { text: string }) => text, DisplayTranslationPreview: () => null },
        // Playback lifecycle runs in the default visible task; task-tab transitions have separate DOM coverage.
        "@/components/workbench-tasks": { WorkbenchTasks: ({ children, urlInputKey: nextKey }: any) => { urlInputKey = nextKey ?? null; return children.type(children.props); }, useWorkbenchTask: () => ({ id: "default", active: true, urlInputKey, draftScope: (scope: string) => scope }), useWorkbenchTaskStatus() {} },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => ({ iterate: async (visit: (value: unknown) => void) => logs.forEach(visit), setItem: async (...args: unknown[]) => writes.push(args) }) },
        "@/hooks/use-generation-draft": { useGenerationDraft: (_key: string, initial: unknown) => [initial, () => {}, true] },
        "@/hooks/use-generation-workspace": { useGenerationWorkspace: () => workspace },
        "@/hooks/use-image-drop": { useImageDrop: () => ({ dropProps: {}, dragging: false, reading: false }) },
        "@/hooks/use-unsaved-guard": { useUnsavedGuard: () => ({}) },
        "@/hooks/use-result-canvas": { useResultCanvas: () => ({ enabled: false, busy: false }) },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/hooks/use-tool-config": { useToolConfig: (config: unknown) => config },
        "@/hooks/use-video-playback": { ...requireModule("@/hooks/use-video-playback"), acquireVideoPlayback: createVideoPlaybackResolver({ owner: () => "owner:designer", subscribe: () => () => {}, fetch: (id, signal) => playback(id, { signal }), createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url) }) },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => defaultConfig, useConfigStore: (select: any) => select({ openConfigDialog() {} }) },
        "@/stores/use-user-store": { useUserStore: Object.assign((select: any) => select({ user: { id: "owner", status: "active", creditBalance: 100 } }), { getState: () => ({ user: { id: "owner", status: "active", creditBalance: 100 } }) }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: any) => select({ models: [], tools: [], status: "ready", estimate: () => ({ credits: 0, configured: true }) }) },
        "@/stores/use-asset-store": { useAssetStore: (select: any) => select({ addAsset: () => { throw new Error("preview must not create an asset"); } }) },
        "@/stores/use-theme-store": { useThemeStore: (select: any) => select({ theme: "light" }) },
        "@/services/file-storage": { resolveMediaUrl: async (_key: string, fallback: string) => fallback },
        "@/services/api/server-assets": { ...requireModule("@/services/api/server-assets"), fetchServerAssetPlayback: playback },
        "@/services/api/video": { createVideoGenerationTask: () => { throw new Error("preview must not regenerate"); } },
        "react-router-dom": { useSearchParams: () => [new URLSearchParams(location.search)], useLocation: () => location, useNavigate: () => unexpectedNavigation },
        antd: { ...antd, App: { useApp: () => ({ message: { error() {}, warning() {}, success() {}, info() {} }, modal: { confirm() {} } }) } },
    };
    // The real hook participates in lifecycle cleanup; this suite has no URL input.
    const handoffModule = { exports: {} };
    const handoffCode = ts.transpileModule(readFileSync(new URL("../src/hooks/use-prompt-url-handoff.ts", import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
    }).outputText;
    new Function("require", "module", "exports", handoffCode)((name: string) => deps[name] || requireModule(name), handoffModule, handoffModule.exports);
    deps["@/hooks/use-prompt-url-handoff"] = handoffModule.exports;
    const module = { exports: {} as any };
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    new Function("require", "module", "exports", "window", code)((name: string) => name.endsWith(".css") ? {} : deps[name] || requireModule(name), module, module.exports, {});
    const render = () => { stateIndex = refIndex = effectIndex = 0; const page = module.exports.default(); const tree = page.type(page.props); pending.splice(0).forEach(effect => effect()); return tree; };
    return { render, writes, unmount: () => effects.forEach(effect => effect.cleanup?.()), card: () => elements(render()).find(element => (element.type as Function).name === "ResultVideoCard")!, history: () => elements(render()).find(element => (element.type as Function).name === "LogPanel")! };
}

test("leaving the result cancels the pending playback without touching successful logs", async () => {
    let signal: AbortSignal | undefined;
    const app = harness(async (_id, options) => { signal = options.signal; return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })); });
    app.render(); await settle(); app.render(); await settle(); app.render(); await settle();
    expect(app.card().props.playback.status).toBe("preparing");
    app.history().props.onPreviewLog(logs[1]); app.render(); await settle();
    expect(signal?.aborted).toBe(true);
    expect(app.card().props.video.id).toBe("video-2");
    expect(app.writes).toEqual([]);
    app.unmount();
});

test("preview blobs are revoked on unmount and browser decoding errors remain view-only", async () => {
    const revoked: string[] = [];
    URL.createObjectURL = () => "blob:compatibility";
    URL.revokeObjectURL = url => revoked.push(url);
    const app = harness(async () => ({ blob: new Blob(["synthetic"], { type: "video/mp4" }), width: 1248, height: 1664 }));
    app.render(); await settle(); app.render(); await settle(); app.render(); await settle();
    const result = app.card();
    expect(result.props.playback).toMatchObject({ status: "ready", playbackUrl: "blob:compatibility", width: 1248, height: 1664 });
    result.props.onPlaybackError();
    expect(app.card().props.playback.status).toBe("error");
    expect(app.card().props.video.url).toBe("blob:original");
    expect(app.writes).toEqual([]);
    expect(logs[0]!.status).toBe("成功");
    app.unmount();
    expect(revoked).toEqual(["blob:compatibility"]);
});
