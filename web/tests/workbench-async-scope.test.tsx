import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import * as antd from "antd";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";
import { workbenchTaskScope } from "@/lib/workbench-task-state";
import { i18nHarness } from "./helpers/i18n-harness";
import { displayHooksHarness } from "./helpers/display-hooks-harness";

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); globalThis.fetch = originalFetch; });
const image = { id: "old-reference", name: "old.png", dataUrl: "blob:old", storageKey: "image:old", type: "image/png", mimeType: "image/png", width: 1024, height: 1024, bytes: 100 };
const config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", videoModel: "doubao-seedance-2.5", videoMode: "auto", size: "16:9" };
const videoLog = { id: "old-task-log", createdAt: 100, title: "旧任务", prompt: "旧提示词", model: "doubao-seedance-2.5", config,
    references: [image], videoReferences: [], audioReferences: [], durationMs: 100, status: "生成中", task: { id: "old-task", requestId: "old-request", model: "doubao-seedance-2.5", provider: "server" } };

function elements(node: unknown): React.ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

// Execute the actual page closures, replacing only browser/storage/API boundaries.
function harness(kind: "image" | "video", options: { logs?: any[]; readLogs?: () => Promise<void>; upload?: () => Promise<any>; wait?: () => Promise<any>; media?: () => Promise<any>; query?: string; template?: () => Promise<any>; submit?: (...args: any[]) => Promise<any> } = {}) {
    globalThis.fetch = (async () => { throw new Error("Unexpected network request in offline scope regression"); }) as typeof fetch;
    const path = new URL(`../src/pages/${kind}/index.tsx`, import.meta.url);
    const requireModule = createRequire(path);
    const frame = () => ({ states: [] as any[], refs: [] as any[], memos: [] as any[], effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: (() => void) | void }>, pending: [] as Array<() => void> });
    const taskFrames = new Map([["default", frame()]]);
    let taskId = "default", currentFrame = taskFrames.get(taskId)!;
    let stateIndex = 0, refIndex = 0, effectIndex = 0, memoIndex = 0;
    const drafts = new Map<string, any>();
    const draftSetters = new Map<string, (next: any) => void>();
    const storedLogs = new Map((options.logs || []).map(log => [log.id, log]));
    const writes: any[] = [], assets: any[] = [], confirmations: any[] = [], notices: any[] = [];
    const searchParams = new URLSearchParams(options.query);
    let urlInputKey: string | null = null;
    const location = { pathname: `/${kind}`, search: searchParams.size ? `?${searchParams}` : "", hash: "", state: null, key: `${kind}-async-scope` };
    const unexpectedNavigation = () => { throw new Error("Async scope tests must not navigate; reuseToken retains its separate handoff"); };
    const userState = { user: { id: "owner", status: "active", creditBalance: 100 }, status: "authenticated" };
    const useUserStore = Object.assign((select: any) => select(userState), { getState: () => userState });
    const assetState = { assets, addAsset: (asset: any) => { assets.push({ ...asset, id: "saved-asset", ownerId: "owner" }); return "saved-asset"; } };
    const useAssetStore = Object.assign((select: any) => select(assetState), { getState: () => assetState });
    const useState = (initial: any) => { const owner = currentFrame, index = stateIndex++; if (!(index in owner.states)) owner.states[index] = typeof initial === "function" ? initial() : initial;
        return [owner.states[index], (next: any) => { owner.states[index] = typeof next === "function" ? next(owner.states[index]) : next; }]; };
    const useMemo = (factory: () => any, deps?: readonly unknown[]) => { const owner = currentFrame, index = memoIndex++, previous = owner.memos[index];
        if (!previous || !deps || previous.deps?.length !== deps.length || !deps.every((value, i) => Object.is(value, previous.deps[i]))) owner.memos[index] = { deps, value: factory() };
        return owner.memos[index].value; };
    const appContext = { message: Object.fromEntries(["error", "warning", "success", "info"].map(name => [name, (value: any) => notices.push(value)])), modal: { confirm: (value: any) => confirmations.push(value) } };
    const dependencies: Record<string, any> = {
        react: { ...React, useState, useRef: (initial: any) => currentFrame.refs[refIndex++] ||= { current: initial }, useMemo, useCallback: (callback: any, deps?: readonly unknown[]) => useMemo(() => callback, deps),
            useEffect: (effect: () => any, values?: readonly unknown[]) => { const owner = currentFrame, index = effectIndex++, previous = owner.effects[index];
                if (previous && values && previous.deps?.length === values.length && values.every((value, i) => Object.is(value, previous.deps![i]))) return;
                owner.pending.push(() => { previous?.cleanup?.(); owner.effects[index] = { deps: values, cleanup: effect() }; }); } },
        "@/lib/i18n": i18nHarness,
        "@/hooks/use-display-text": { ...displayHooksHarness, DisplayText: ({ text }: { text: string }) => text, DisplayTranslationPreview: () => null },
        // Each task keeps its original hook owners and async closures. The real
        // registry, visible tabs and persistence failure paths run in DOM tests.
        "@/components/workbench-tasks": { WorkbenchTasks: ({ children, urlInputKey: nextKey }: any) => { urlInputKey = nextKey ?? null; return children.type(children.props); }, useWorkbenchTask: () => ({ id: taskId, active: true, ready: true, creating: false, createNewTask: async () => {
            taskId = `task-${taskFrames.size + 1}`; taskFrames.set(taskId, frame()); return true;
        }, urlInputKey, draftScope: (scope: string) => workbenchTaskScope(scope, taskId) }), useWorkbenchTaskStatus() {} },
        "@/lib/workspace-storage": { createWorkspaceStorage: (name: string) => ({ iterate: async (visit: any) => { if (!name.includes("pending")) { await options.readLogs?.(); storedLogs.forEach(visit); } }, setItem: async (key: string, value: any) => { writes.push(value); storedLogs.set(key, value); }, removeItem: async (key: string) => { storedLogs.delete(key); } }) },
        "@/hooks/use-generation-draft": { useGenerationDraft: (key: string, initial: any) => { if (!drafts.has(key)) drafts.set(key, key.endsWith(":settings") ? { ...config } : initial);
            if (!draftSetters.has(key)) draftSetters.set(key, (next: any) => drafts.set(key, typeof next === "function" ? next(drafts.get(key)) : next));
            return [drafts.get(key), draftSetters.get(key), true]; } },
        "@/hooks/use-image-drop": { useImageDrop: () => ({ dropProps: {}, dragging: false, reading: false }) },
        "@/hooks/use-unsaved-guard": { useUnsavedGuard: () => ({}) },
        "@/hooks/use-result-canvas": { useResultCanvas: () => ({ enabled: false, busy: false }) },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/hooks/use-tool-config": { useToolConfig: (value: any) => value },
        "@/hooks/use-image-copy-editor": { useImageCopyEditor: () => ({ node: null }) },
        "@/pages/design-library/use-design-library-share": { useDesignLibraryShare: () => ({ canShare: false }) },
        "@/stores/use-user-store": { useUserStore }, "@/stores/use-asset-store": { useAssetStore },
        "@/stores/use-config-store": { ...requireModule("@/stores/use-config-store"), useEffectiveConfig: () => config, useConfigStore: (select: any) => select({ openConfigDialog() {} }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: any) => select({ models: [{ id: "video-model", modelId: "doubao-seedance-2.5", name: "Video", capabilities: ["video"] }], tools: [], status: "ready", estimate: () => ({ credits: 0, configured: true }) }) },
        "@/lib/image-model-settings": { ...requireModule("@/lib/image-model-settings"), useImageModelProfile: () => requireModule("@/lib/image-model-settings").imageModelProfile("gpt-image-2") },
        "@/stores/use-theme-store": { useThemeStore: (select: any) => select({ theme: "light" }) },
        "@/lib/clipboard-images": { pastedImageFiles: () => [], readClipboardImages: async () => [new Blob(["png"], { type: "image/png" })] },
        "@/services/image-storage": { resolveImageUrl: async (_key: string, fallback: string) => fallback, uploadImage: options.upload || (async () => ({ ...image, url: image.dataUrl })) },
        "@/services/file-storage": { resolveMediaUrl: async (_key: string, fallback: string) => fallback, uploadMediaFile: options.media || (async () => ({ url: "blob:old-media", storageKey: "media:old" })), deleteStoredMedia: async () => undefined },
        "@/lib/video-reference-files": { readReferenceMediaFile: async (file: File) => ({ id: file.name, name: file.name, type: file.type, bytes: file.size, url: "", durationMs: 4000, width: 1280, height: 720, fps: 24 }) },
        "@/services/api/generation-tasks": { ...requireModule("@/services/api/generation-tasks"), waitForTasks: options.wait || (async () => { throw new Error("Unexpected polling"); }) },
        "@/services/api/generation-history": { restoreGenerationDraft: async () => ({ prompt: "恢复的草稿", operationType: "image_generation", config, references: [{ ...image, storageKey: "image:restored" }] }) },
        "@/services/api/video": { createVideoGenerationTask: options.submit || (() => { throw new Error("Must never submit generation"); }), storeGeneratedVideo: async () => ({ url: "blob:old-result", storageKey: "video:old-result", mimeType: "video/mp4", bytes: 100 }) },
        "@/services/api/prompts": { hydratePromptReuse: options.template },
        "@/services/api/server-assets": { fetchServerAssetContent: async () => new Blob(["image"], { type: "image/png" }) },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false } },
        "react-router-dom": { useSearchParams: () => [searchParams], useLocation: () => location, useNavigate: () => unexpectedNavigation },
        antd: { ...antd, App: { useApp: () => appContext } },
    };
    const compile = (path: URL) => ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const workspace = { exports: {} };
    new Function("require", "module", "exports", compile(new URL("../src/hooks/use-generation-workspace.ts", import.meta.url)))((name: string) => dependencies[name], workspace, workspace.exports);
    dependencies["@/hooks/use-generation-workspace"] = workspace.exports;
    // Execute the real URL gate with these same React/router shims, including reuseToken exclusion.
    const handoffModule = { exports: {} };
    new Function("require", "module", "exports", compile(new URL("../src/hooks/use-prompt-url-handoff.ts", import.meta.url)))((name: string) => dependencies[name] || requireModule(name), handoffModule, handoffModule.exports);
    dependencies["@/hooks/use-prompt-url-handoff"] = handoffModule.exports;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "window", "navigator", compile(path))((name: string) => name.endsWith(".css") ? {} : dependencies[name] || requireModule(name), module, module.exports, {}, { clipboard: {} });
    const render = () => { currentFrame = taskFrames.get(taskId)!; stateIndex = refIndex = effectIndex = memoIndex = 0;
        const page = kind === "image" ? module.exports.ImageGenerationPage() : module.exports.default();
        const tree = page.type(page.props); currentFrame.pending.splice(0).forEach(effect => effect()); return tree; };
    const unmount = () => taskFrames.forEach(owner => owner.effects.forEach(effect => effect.cleanup?.()));
    cleanups.push(unmount);
    const find = (name: string) => elements(render()).find(element => element.type?.name === name)!;
    return { render, find, drafts, writes, assets, notices, confirmations, userState, unmount,
        currentDraft: (field: string) => { if (kind === "video") return drafts.get(workbenchTaskScope(field, taskId)); const [scope, ...parts] = field.split(":"); return drafts.get(`${workbenchTaskScope(scope, taskId)}:${parts.join(":")}`); },
        references: () => drafts.get(kind === "video" ? workbenchTaskScope("video:references", taskId) : `${workbenchTaskScope("image-generation", taskId)}:references`),
        selectTask: (id: string) => { if (!taskFrames.has(id)) throw new Error(`Unknown workspace ${id}`); taskId = id; return render(); },
        createSession: () => { const props = find("LogPanel").props; (props.onCreateTask || props.onCreateSession)(); render(); },
        clipboard: () => kind === "image" ? find("ReferenceImageTray").props.onRequestClipboard() : elements(render()).find(element => element.props.children === "剪切板")!.props.onClick(),
        cards: () => elements(render()).filter(element => ["ResultVideoCard", "PendingVideoCard", "FailedVideoCard"].includes(element.type?.name)),
    };
}

test("video: the first history read blocks button, shortcut and direct submission, then keeps original and new tasks parallel", async () => {
    const read = Promise.withResolvers<void>();
    const polls: string[][] = []; let submissions = 0;
    const app = harness("video", { logs: [videoLog], readLogs: () => read.promise,
        wait: (...args: any[]) => { polls.push(args[0]); return new Promise(() => {}); },
        submit: async (...args) => { submissions++; await args[5].onSubmissionStarted("new-request"); return { ...videoLog.task, id: "new-task", requestId: "new-request" }; } });
    app.render(); await settle();
    const generate = elements(app.render()).find(element => element.props.children === "生成视频" && element.props.onClick)!;
    expect(generate.props.disabled).toBe(true);
    generate.props.onClick();
    elements(app.render()).find(element => element.props["aria-label"] === "视频提示词")!.props.onKeyDown({ key: "Enter", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, nativeEvent: {}, preventDefault() {} });
    await settle();
    expect(submissions).toBe(0); expect(app.writes).toEqual([]); expect(polls).toEqual([]);
    read.resolve(); await settle(); app.render();
    expect(polls).toEqual([["old-task"]]);
    const parallel = elements(app.render()).find(element => element.props.children === "继续生成新视频" && element.props.onClick)!;
    expect(parallel.props.disabled).toBe(false); parallel.props.onClick(); await settle();
    expect(submissions).toBe(1); expect(polls).toEqual([["old-task"], ["new-task"]]);
});

test("video: failed initial history stays visibly blocked and explicit retry only reads the original task", async () => {
    const retry = Promise.withResolvers<void>(); let reads = 0, polls = 0, submissions = 0;
    const app = harness("video", { logs: [videoLog], readLogs: () => ++reads === 1 ? Promise.reject(new Error("FIXTURE_HISTORY_READ_FAILED")) : retry.promise,
        wait: () => { polls++; return new Promise(() => {}); }, submit: async () => { submissions++; return videoLog.task; } });
    app.render(); await settle();
    const alert = elements(app.render()).find(element => element.props.role === "alert")!;
    expect(alert).toBeDefined();
    expect(elements(alert).some(element => element.props.children === "视频历史读取失败：FIXTURE_HISTORY_READ_FAILED")).toBe(true);
    const generate = elements(app.render()).find(element => element.props.children === "生成视频" && element.props.onClick)!;
    expect(generate.props.disabled).toBe(true); generate.props.onClick(); await settle();
    expect(submissions).toBe(0); expect(app.writes).toEqual([]);
    elements(alert).find(element => element.props.children === "重新读取视频记录")!.props.onClick(); app.render();
    expect(reads).toBe(2); expect(polls).toBe(0); expect(submissions).toBe(0);
    retry.resolve(); await settle();
    expect(elements(app.render()).filter(element => element.props.role === "alert")).toEqual([]);
    expect(polls).toBe(1); expect(submissions).toBe(0); expect(app.writes).toEqual([]);
});

for (const boundary of ["owner", "unmount"] as const) test(`video: a delayed history retry cannot resume the old task after ${boundary}`, async () => {
    const retry = Promise.withResolvers<void>(); let reads = 0, polls = 0;
    const app = harness("video", { logs: [videoLog], readLogs: () => ++reads === 1 ? Promise.reject(new Error("FIXTURE_HISTORY_READ_FAILED")) : retry.promise,
        wait: () => { polls++; return new Promise(() => {}); } });
    app.render(); await settle();
    elements(app.render()).find(element => element.props.children === "重新读取视频记录")!.props.onClick();
    if (boundary === "owner") app.userState.user = { ...app.userState.user, id: "other-owner" };
    else app.unmount();
    retry.resolve(); await settle();
    expect(polls).toBe(0); expect(app.writes).toEqual([]); expect(app.assets).toEqual([]);
});

for (const kind of ["image", "video"] as const) {
    test(`${kind}: new draft rejects the previous clipboard upload but still accepts a current upload`, async () => {
        const first = Promise.withResolvers<any>(); let uploads = 0;
        const app = harness(kind, { upload: () => ++uploads === 1 ? first.promise : Promise.resolve({ ...image, url: "blob:current", storageKey: "image:current" }) });
        app.render(); await settle(); app.clipboard(); await settle(); app.createSession(); app.render();
        expect(app.references()).toEqual([]);
        first.resolve({ ...image, url: "blob:old" }); await settle(); app.render();
        expect(app.references()).toEqual([]);
        app.clipboard(); await settle(); app.render();
        expect(app.references()).toMatchObject([{ storageKey: "image:current" }]);
        if (kind === "video") { app.selectTask("default"); expect(app.references()).toMatchObject([{ dataUrl: "blob:old" }]); }
    });

    test(`${kind}: a late material picker import cannot repopulate a new draft`, async () => {
        const upload = Promise.withResolvers<any>();
        const app = harness(kind, { upload: () => upload.promise }); app.render(); await settle();
        const picker = elements(app.render()).find(element => element.type?.name === "AssetPickerModal" && (kind === "video" || element.props.onInsertMany))!;
        const payload = { kind: "image", title: "old asset", dataUrl: image.dataUrl };
        if (kind === "video") picker.props.onInsert(payload); else picker.props.onInsertMany([payload]);
        app.createSession(); app.render(); upload.resolve({ ...image, url: "blob:old" }); await settle();
        expect(app.references()).toEqual([]);
        if (kind === "video") { app.selectTask("default"); expect(app.references()).toMatchObject([{ dataUrl: "blob:old" }]); }
    });

    test(`${kind}: restoring historical inputs rejects an upload started for the previous draft`, async () => {
        const upload = Promise.withResolvers<any>();
        const app = harness(kind, { upload: () => upload.promise }); app.render(); await settle();
        const log = { ...videoLog, status: "成功", references: [{ ...image, storageKey: "image:restored" }], task: undefined, images: [{ ...image, sourceTaskId: "old-task" }], ownerId: "owner", tool: "image-generation" };
        await app.find("LogPanel").props.onPreviewLog(log); await settle(); app.clipboard(); await settle();
        elements(app.render()).find(element => element.props.children === "恢复为草稿继续改")!.props.onClick();
        await app.confirmations.at(-1).onOk(); await settle();
        upload.resolve({ ...image, url: "blob:old" }); await settle();
        expect(app.references()).toMatchObject([{ storageKey: "image:restored" }]);
        expect(app.references()).toHaveLength(1);
    });

    test(`${kind}: an old upload cannot release the new draft's upload busy state`, async () => {
        const first = Promise.withResolvers<any>(), second = Promise.withResolvers<any>(); let count = 0;
        const app = harness(kind, { upload: () => ++count === 1 ? first.promise : second.promise }); app.render(); await settle();
        app.clipboard(); await settle(); app.createSession(); app.clipboard(); await settle();
        first.resolve({ ...image, url: "blob:old" }); await settle();
        const busy = kind === "image" ? app.find("ReferenceImageTray").props.loading : elements(app.render()).find(element => element.type === "input" && element.props.accept.startsWith("image/"))!.props.disabled;
        expect(busy).toBe(true);
        second.resolve({ ...image, url: "blob:new", storageKey: "image:new" }); await settle();
        expect(app.references()).toMatchObject([{ storageKey: "image:new" }]);
        if (kind === "video") { app.selectTask("default"); expect(app.references()).toMatchObject([{ dataUrl: "blob:old" }]); }
    });

    test(`${kind}: leaving the workspace rejects a late clipboard result`, async () => {
        const upload = Promise.withResolvers<any>();
        const app = harness(kind, { upload: () => upload.promise }); app.render(); await settle(); app.clipboard(); await settle(); app.unmount();
        upload.resolve({ ...image, url: "blob:old" }); await settle();
        expect(app.references()).toEqual([]);
    });
}

for (const source of ["result", "single-asset"] as const) test(`image: a late ${source} reference stays out of a new draft`, async () => {
    const upload = Promise.withResolvers<any>();
    const app = harness("image", { upload: () => upload.promise }); app.render(); await settle();
    if (source === "result") {
        await app.find("LogPanel").props.onPreviewLog({ ...videoLog, images: [image] }); await settle();
        app.find("ResultImageCard").props.onEdit(image, 0);
    } else app.find("AssetPickerModal").props.onInsert({ kind: "image", title: "old", dataUrl: image.dataUrl });
    app.createSession(); app.render(); upload.resolve({ ...image, url: "blob:old" }); await settle();
    expect(app.references()).toEqual([]);
});

test("video: new draft rejects a template whose references finish loading later", async () => {
    const upload = Promise.withResolvers<any>();
    const app = harness("video", { query: "reuseToken=old-template", upload: () => upload.promise, template: async () => ({
        template: { prompt: "旧模板提示词", parameters: {}, referenceAssetIds: ["old-asset"] }, pricing: {}, warnings: [], mode: "fill_only",
    }) });
    app.render(); await settle(); app.createSession(); app.render(); upload.resolve({ ...image, url: "blob:old" }); await settle();
    expect(app.references()).toEqual([]);
    expect(app.currentDraft("video:prompt")).toBe("");
    app.selectTask("default");
    expect(app.currentDraft("video:prompt")).toBe("旧模板提示词");
    expect(app.references()).toMatchObject([{ dataUrl: "blob:old" }]);
});

for (const kind of ["video", "audio"] as const) test(`video: a late ${kind} upload cannot repopulate a new draft`, async () => {
    const upload = Promise.withResolvers<any>();
    let started = false;
    const app = harness("video", { media: () => { started = true; return upload.promise; } }); app.render(); await settle();
    app.drafts.set("video:settings", { ...config, videoMode: "reference" });
    const input = elements(app.render()).find(element => element.type === "input" && element.props.accept.startsWith(`${kind}/`))!;
    input.props.onChange({ target: { files: [new File(["media"], kind === "video" ? "old.mp4" : "old.wav", { type: kind === "video" ? "video/mp4" : "audio/wav" })], value: "" } });
    await settle(); expect(started).toBe(true); app.createSession(); app.render(); upload.resolve({ url: "blob:old-media", storageKey: "media:old" }); await settle();
    const field = kind === "video" ? "video:videos" : "video:audios";
    expect(app.currentDraft(field)).toEqual([]);
    app.selectTask("default");
    expect(app.currentDraft(field)).toMatchObject([{ storageKey: "media:old" }]);
});

for (const switchView of ["new", "history"] as const) test(`video: old completion stays in history/assets after switching to ${switchView}`, async () => {
    const wait = Promise.withResolvers<any>();
    const app = harness("video", { logs: [videoLog], wait: () => wait.promise }); app.render(); await settle(); app.render();
    if (switchView === "new") app.createSession();
    else app.find("LogPanel").props.onPreviewLog({ ...videoLog, id: "other-log", status: "失败", task: undefined, error: "other failure" });
    await settle();
    wait.resolve([{ id: "old-task", requestId: "old-request", status: "success", resultUrls: ["/api/assets/old/content"] }]); await settle(); app.render();
    expect(app.cards().some(card => card.type?.name === "ResultVideoCard")).toBe(false);
    expect(app.writes.at(-1)).toMatchObject({ id: "old-task-log", status: "成功" });
    expect(app.assets).toMatchObject([{ data: { storageKey: "video:old-result" } }]);
});

test("video: selecting the original running task again receives its completion", async () => {
    const wait = Promise.withResolvers<any>();
    const app = harness("video", { logs: [videoLog], wait: () => wait.promise }); app.render(); await settle(); app.render();
    app.createSession(); app.render();
    expect(app.cards()).toEqual([]);
    app.selectTask("default"); app.find("LogPanel").props.onPreviewLog(videoLog); await settle();
    // This hook harness does not schedule React renders after a state update.
    // Commit the selected history view before the deferred server response.
    expect(app.cards()[0]!.type.name).toBe("PendingVideoCard");
    wait.resolve([{ id: "old-task", requestId: "old-request", status: "success", resultUrls: ["/api/assets/old/content"] }]); await settle();
    expect(app.cards()).toHaveLength(1);
    expect(app.cards()[0]!.props.video).toMatchObject({ storageKey: "video:old-result" });
});

test("video: a delayed submission acknowledgement does not reclaim a new result view", async () => {
    const submitted = Promise.withResolvers<any>(); let submissions = 0;
    const app = harness("video", { submit: async (...args) => { submissions++; await args[5].onSubmissionStarted("old-request"); return submitted.promise; },
        wait: async () => [{ id: "old-task", requestId: "old-request", status: "success", resultUrls: ["/api/assets/old/content"] }] });
    app.render(); await settle();
    const generate = elements(app.render()).find(element => element.props.children === "生成视频" && element.props.onClick)!;
    expect(generate.props.disabled).toBe(false); generate.props.onClick(); await settle();
    app.createSession(); app.render(); submitted.resolve(videoLog.task); await settle(); app.render();
    expect(submissions).toBe(1);
    expect(app.cards()).toEqual([]);
    expect(app.writes.at(-1)).toMatchObject({ status: "成功" });
    expect(app.assets).toHaveLength(1);
});

test("video: refreshing history after deleting another record cannot reclaim a new view for an old task", async () => {
    const firstWait = Promise.withResolvers<any>(); let polls = 0;
    const app = harness("video", { logs: [videoLog, { ...videoLog, id: "delete-me", status: "失败", task: undefined }], wait: () => ++polls === 1 ? firstWait.promise : Promise.resolve([{ id: "old-task", requestId: "old-request", status: "success", resultUrls: ["/api/assets/old/content"] }]) });
    app.render(); await settle(); app.createSession(); app.render();
    firstWait.reject(new Error("Observation paused")); await settle(); app.render();
    expect(app.find("LogPanel").props.logs).toEqual([]);
    app.selectTask("default");
    app.find("LogPanel").props.onSelectedLogIdsChange(["delete-me"]);
    app.find("LogPanel").props.onDeleteSelected();
    const deleting = elements(app.render()).find(element => element.props.title === "删除生成记录")!.props.onOk();
    app.selectTask("task-2");
    await deleting; await settle();
    expect(polls).toBe(2);
    expect(app.cards()).toEqual([]);
    expect(app.writes.at(-1)).toMatchObject({ id: "old-task-log", status: "成功" });
    expect(app.assets).toHaveLength(1);
    app.selectTask("default");
    expect(app.cards()[0]!.props.video).toMatchObject({ storageKey: "video:old-result" });
});
