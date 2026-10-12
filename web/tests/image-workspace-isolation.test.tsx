import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type DependencyList, type EffectCallback, type ReactElement } from "react";
import ts from "typescript";

const pageUrl = new URL("../src/pages/image/index.tsx", import.meta.url);
const requireModule = createRequire(pageUrl);
const code = ts.transpileModule(readFileSync(pageUrl, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

const tools = ["image-generation", "image-edit", "detail-enhance", "angle-control"] as const;
type Image = { id: string; dataUrl: string; storageKey?: string; sourceTaskId?: string };
type StoredLog = ReturnType<typeof storedLog>;

function storedLog(tool: string, id: string, createdAt: number, ownerId = "designer-a") {
    return {
        id, ownerId, tool, createdAt, title: id, prompt: `${id} prompt`, model: "test-model", time: "12:00",
        config: { model: "test-model", imageModel: "test-model", quality: "standard", size: "1024x1024", count: "1" },
        references: [], durationMs: 10, successCount: 1, failCount: 0, imageCount: 1,
        size: "1024x1024", quality: "standard", status: "成功", thumbnails: [],
        images: [{ id: `${id}-image`, dataUrl: "", storageKey: `${id}-stored`, width: 1024, height: 1024, bytes: 100, durationMs: 10 }],
    };
}

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const element = node as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

/** Per-instance hook state, effect cleanup, and keyed reconciliation without process-global mocks. */
function pageHarness(initial: StoredLog[] = [], generate?: () => Promise<Image[]>) {
    type Frame = { values: any[]; effects: Array<{ dependencies?: DependencyList; cleanup?: ReturnType<EffectCallback> }>; pending: Array<() => void>; cursor: number; mounted: boolean };
    const frame = (): Frame => ({ values: [], effects: [], pending: [], cursor: 0, mounted: true });
    const wrapper = frame();
    let workspace = frame();
    let active = wrapper;
    let root: ReactElement<any>;
    let mountedKey: string | null | undefined;
    let mountedType: unknown;
    let params = new URLSearchParams("tool=image-generation");
    let ownerId = "designer-a";
    let creativePreset: any;
    let sequence = 0;
    const requests: Array<{ kind: string; args: any[] }> = [];
    const errors: string[] = [];
    const delayedMedia = new Map<string, Promise<string>>();
    const stored = new Map(initial.map(log => [log.id, structuredClone(log)]));
    const config: Record<string, any> = { model: "test-model", imageModel: "test-model", quality: "standard", size: "1024x1024", count: "1" };
    const equal = (a?: DependencyList, b?: DependencyList) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    const useState = (initialValue: any) => {
        const owner = active;
        const index = owner.cursor++;
        if (!(index in owner.values)) owner.values[index] = typeof initialValue === "function" ? initialValue() : initialValue;
        return [owner.values[index], (next: any) => {
            if (owner.mounted) owner.values[index] = typeof next === "function" ? next(owner.values[index]) : next;
        }];
    };
    const useMemo = (factory: () => unknown, dependencies?: DependencyList) => {
        const index = active.cursor++;
        const previous = active.values[index];
        if (!previous || !equal(previous.dependencies, dependencies)) active.values[index] = { dependencies, value: factory() };
        return active.values[index].value;
    };
    const cleanup = (owner: Frame) => {
        owner.mounted = false;
        owner.effects.forEach(effect => effect.cleanup?.());
    };
    const message = { success() {}, info() {}, warning() {}, error: (error: string) => errors.push(error) };
    const app = { message, modal: { confirm() {} } };
    const updateConfig = (key: string, value: unknown) => { config[key] = value; };
    const configState = { config, updateConfig, openConfigDialog() {} };
    const userState = () => ({ user: { id: ownerId, status: "active", role: "designer", creditBalance: 100 } });
    const storage = {
        available: true, isCurrent: () => true, assertAccess() {}, assertIdentity() {},
        async iterate(visitor: (value: StoredLog, key: string, index: number) => void) {
            [...stored.entries()].forEach(([key, value], index) => visitor(structuredClone(value), key, index + 1));
        },
        async setItem(key: string, value: StoredLog) { stored.set(key, structuredClone(value)); return value; },
        async getItem(key: string) { return stored.get(key) || null; },
        async removeItem(key: string) { stored.delete(key); },
    };
    const request = async (kind: string, args: any[]) => {
        requests.push({ kind, args });
        if (!generate) throw new Error("Unexpected image request: this regression test must not call a real API");
        return generate();
    };
    const component = (name: string) => name;
    const dependencies: Record<string, any> = {
        react: {
            ...React, useState, useMemo,
            useCallback: (callback: unknown, deps?: DependencyList) => useMemo(() => callback, deps),
            useRef: (initialValue: unknown) => { const index = active.cursor++; return active.values[index] ||= { current: initialValue }; },
            useEffect: (effect: EffectCallback, deps?: DependencyList) => {
                const owner = active;
                const index = owner.cursor++;
                if (!owner.effects[index] || !equal(owner.effects[index].dependencies, deps)) owner.pending.push(() => {
                    owner.effects[index]?.cleanup?.();
                    owner.effects[index] = { dependencies: deps, cleanup: effect() };
                });
            },
        },
        "lucide-react": new Proxy({}, { get: (_, name) => String(name) }),
        antd: {
            App: { useApp: () => app }, Button: "Button", Checkbox: "Checkbox", Drawer: "Drawer", Empty: "Empty", Image: "Image", Modal: "Modal", Tag: "Tag", Tooltip: "Tooltip",
            Input: { TextArea: "TextArea" }, Typography: { Text: "Typography.Text" },
        },
        "react-router-dom": { Link: "Link", useSearchParams: () => [params] },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => storage },
        "@/stores/use-config-store": {
            useConfigStore: Object.assign((select: Function) => select(configState), { getState: () => configState }),
            useEffectiveConfig: () => config, modelOptionName: (model: string) => model, modelOptionLabel: (_: unknown, model: string) => model,
        },
        "@/stores/use-user-store": { useUserStore: Object.assign((select: Function) => select(userState()), { getState: userState }) },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ estimate: () => ({ configured: true, credits: 0 }) }) },
        "@/stores/use-asset-store": { useAssetStore: (select: Function) => select({ addAsset() {} }) },
        "@/hooks/use-workbench-field": { useWorkbenchField: (_key: string, initialValue: unknown) => useState(initialValue) },
        "@/hooks/use-image-copy-editor": { useImageCopyEditor: () => ({ node: null }) },
        "@/hooks/use-can-manage-config": { useCanManageConfig: () => false },
        "@/lib/deployment-features": { deploymentFeatures: { creditsEnabled: false, oaLoginEnabled: false } },
        "@/lib/canvas-theme": { canvasThemes: { light: {} } },
        "@/lib/image-model-settings": { useImageModelProfile: () => ({ kind: "image", requiresPrompt: true }), normalizeImageModelSettings: (value: unknown) => value },
        "@/lib/submission-gate": { workbenchSubmissions: { acquire: () => () => undefined } },
        "@/services/api/image": { requestGeneration: (...args: any[]) => request("generate", args), requestEdit: (...args: any[]) => request("edit", args) },
        "@/services/image-storage": {
            resolveImageUrl: async (key: string, fallback: string) => delayedMedia.get(key) || (key ? `/stored/${key}` : fallback),
            uploadImage: async (url: string) => ({ url, storageKey: `upload-${++sequence}`, width: 1024, height: 1024, bytes: 100, mimeType: "image/png" }),
            deleteStoredImages: async () => undefined,
        },
        "@/lib/image-utils": { readImageMeta: async () => ({ width: 1024, height: 1024, mimeType: "image/png" }), getDataUrlByteSize: () => 100, formatBytes: String, formatDuration: String },
        "@/services/api/server-assets": { fetchServerAssetContent: async () => { throw new Error("Unexpected asset request"); }, recordServerAssetEvent() {} },
        "@/services/api/generation-history": { restoreGenerationDraft: async () => { throw new Error("Unexpected restore request"); } },
        "@/services/api/generation-tasks": { getQueuedTask: async () => { throw new Error("Unexpected legacy task lookup for explicitly scoped logs"); } },
        "@/services/api/prompts": { hydratePromptReuse: async () => { throw new Error("Unexpected reuse request"); }, savePromptFromTask() {} },
        "file-saver": { saveAs() {} }, nanoid: { nanoid: () => `generated-${++sequence}` },
    };
    for (const [path, name] of [
        ["@/components/image-settings-panel", "ImageSettingsPanel"], ["@/components/generation-elapsed", "GenerationElapsed"],
        ["@/components/reference-images/reference-image-tray", "ReferenceImageTray"], ["@/components/model-picker", "ModelPicker"],
        ["@/components/prompts/prompt-select-dialog", "PromptSelectDialog"], ["@/components/canvas/asset-picker-modal", "AssetPickerModal"],
        ["./image-log-thumbnail", "ImageLogThumbnail"], ["../creative/garment-recipe-panel", "GarmentRecipePanel"],
    ]) dependencies[path!] = { [name!]: component(name!) };
    const module = { exports: {} as { ImageGenerationPage: (props?: object) => ReactElement<any> } };
    // Everything under test, including scope filtering and media hydration, uses its real module.
    new Function("require", "module", "exports", "window", code)(
        (name: string) => name.endsWith(".css") ? {} : Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name),
        module, module.exports, {},
    );
    const run = (owner: Frame, render: () => ReactElement<any>) => {
        active = owner;
        owner.cursor = 0;
        const result = render();
        for (const effect of owner.pending.splice(0)) effect();
        return result;
    };
    const boundary = () => run(wrapper, () => module.exports.ImageGenerationPage({ creativePreset }));
    const render = () => {
        const child = boundary();
        // Also run the previous inline page: regressions must fail on visible data, not a harness error.
        if (typeof child.type !== "function") return root = child;
        if (child.key !== mountedKey || child.type !== mountedType) {
            cleanup(workspace);
            workspace = frame();
            mountedKey = child.key;
            mountedType = child.type;
        }
        root = run(workspace, () => (child.type as Function)(child.props));
        return root;
    };
    const unmount = () => { cleanup(workspace); cleanup(wrapper); };
    disposers.push(unmount);
    return {
        boundary, render, stored, requests, errors, config,
        navigate(tool: string, query = "") { params = new URLSearchParams(`tool=${tool}${query ? `&${query}` : ""}`); },
        setOwner(value: string) { ownerId = value; },
        setCreative(value?: object) { creativePreset = value; },
        delayMedia(key: string) { const pending = deferred<string>(); delayedMedia.set(key, pending.promise); return pending; },
        async settle() { for (let turn = 0; turn < 30; turn++) { render(); await Promise.resolve(); } return render(); },
        panels() { return elements(render()).filter(item => typeof item.type === "function" && item.type.name === "LogPanel").map(item => item.props); },
        cards() { return elements(render()).filter(item => typeof item.type === "function" && item.type.name === "ResultImageCard"); },
        failedCards() { return elements(render()).filter(item => typeof item.type === "function" && item.type.name === "FailedImageCard"); },
        images() { return elements(render()).filter(item => typeof item.type === "function" && item.type.name === "ResultImageCard").map(item => item.props.image); },
        references() { return elements(render()).find(item => item.type === "ReferenceImageTray")!.props; },
        prompt() { return elements(render()).find(item => item.type === "TextArea")!.props; },
        generate() { return elements(render()).find(item => item.type === "Button" && item.props.type === "primary" && item.props.block)!.props; },
    };
}

describe("image workspace isolation", () => {
    test("the real page keys by normalized tool and owner, not unrelated query values", () => {
        const page = pageHarness();
        const keys = tools.map(tool => { page.navigate(tool); return page.boundary().key; });
        expect(keys.every(Boolean)).toBe(true);
        expect(new Set(keys).size).toBe(4);
        page.navigate("image-generation", "prompt=changed&model=other&reuseToken=token&sourceAssetId=asset");
        expect(page.boundary().key).toBe(keys[0]);
        page.navigate("unrecognized");
        expect(page.boundary().key).toBe(keys[0]);
        page.setOwner("designer-b");
        expect(page.boundary().key).not.toBe(keys[0]);
        const creative = { id: "text-to-style", tool: "image-generation", title: "Creative", description: "", group: "new" };
        page.setCreative(creative);
        const creativeKey = page.boundary().key;
        page.navigate("angle-control", "prompt=changed");
        expect(page.boundary().key).toBe(creativeKey);
        page.setCreative({ ...creative, id: "another-preset" });
        expect(page.boundary().key).not.toBe(creativeKey);
    });

    for (const tool of tools) test(`${tool} renders only its own history and latest successful result`, async () => {
        const logs = tools.flatMap((entry, index) => [storedLog(entry, `${entry}-older`, 10 + index), storedLog(entry, `${entry}-newer`, 100 + index)]);
        const page = pageHarness(logs);
        page.navigate(tool);
        await page.settle();
        expect(page.panels()).toHaveLength(2);
        for (const panel of page.panels()) expect(panel.logs.map((log: StoredLog) => log.id)).toEqual([`${tool}-newer`, `${tool}-older`]);
        expect(page.images().map(image => image.id)).toEqual([`${tool}-newer-image`]);
        expect(page.images()[0].dataUrl).toBe(`/stored/${tool}-newer-stored`);
        expect(page.requests).toHaveLength(0);
        expect(page.errors).toEqual([]);
    });

    test("route changes clear visible selection, preview, and references before loading the next tool", async () => {
        const page = pageHarness([storedLog("image-generation", "a", 10), storedLog("image-edit", "b", 20)]);
        await page.settle();
        page.panels()[0].onSelectedLogIdsChange(["a"]);
        page.panels()[0].onPreviewLog(page.panels()[0].logs[0]);
        page.references().onChange([{ id: "reference-a", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,YQ==" }]);
        await page.settle();
        expect(page.panels()[0].activeLogId).toBe("a");
        expect(page.prompt().value).toBe("a prompt");
        page.navigate("image-generation", "prompt=new-prompt");
        page.render();
        expect(page.references().references).toHaveLength(1);
        expect(page.panels()[0].selectedLogIds).toEqual(["a"]);
        page.navigate("image-edit");
        page.render();
        expect(page.images()).toEqual([]);
        expect(page.panels()[0].logs).toEqual([]);
        expect(page.panels()[0].selectedLogIds).toEqual([]);
        expect(page.panels()[0].activeLogId).toBeUndefined();
        expect(page.references().references).toEqual([]);
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["b-image"]);
    });

    test("switching accounts remounts immediately and restores only the new owner's records", async () => {
        const page = pageHarness([storedLog("image-generation", "owner-a", 10), storedLog("image-generation", "owner-b", 20, "designer-b")]);
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["owner-a-image"]);
        expect(page.panels()[0].logs.map((log: StoredLog) => log.id)).toEqual(["owner-a"]);
        page.setOwner("designer-b");
        page.render();
        expect(page.images()).toEqual([]);
        expect(page.panels()[0].logs).toEqual([]);
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["owner-b-image"]);
        expect(page.panels()[0].logs.map((log: StoredLog) => log.id)).toEqual(["owner-b"]);
        expect(page.errors).toEqual([]);
    });

    test("a delayed history preview cannot overwrite the next tool's prompt or result", async () => {
        const page = pageHarness([storedLog("image-generation", "a-old", 10), storedLog("image-generation", "a-new", 20), storedLog("image-edit", "b", 30)]);
        await page.settle();
        const pending = page.delayMedia("a-old-stored");
        page.panels()[0].onPreviewLog(page.panels()[0].logs.find((log: StoredLog) => log.id === "a-old"));
        page.navigate("image-edit");
        await page.settle();
        page.prompt().onChange({ target: { value: "B's own draft" } });
        pending.resolve("/stored/a-old-stored");
        await page.settle();
        expect(page.prompt().value).toBe("B's own draft");
        expect(page.images().map(image => image.id)).toEqual(["b-image"]);
        expect(page.panels()[0].activeLogId).toBeUndefined();
        expect(page.errors).toEqual([]);
    });

    test("clicking a displayed result refills its own prompt without replacing current references or model", async () => {
        const page = pageHarness([storedLog("image-generation", "saved", 20)]);
        await page.settle();
        page.prompt().onChange({ target: { value: "changed draft" } });
        page.references().onChange([{ id: "draft-reference", name: "draft.png", type: "image/png", dataUrl: "data:image/png;base64,YQ==" }]);
        page.config.imageModel = "another-model";
        const card = page.cards()[0]!;
        const view = (card.type as Function)(card.props);
        const image = elements(view).find(item => item.type === "Image")!;
        expect(typeof image.props.onClick).toBe("function");
        image.props.onClick();
        expect(page.prompt().value).toBe("saved prompt");
        expect(page.references().references.map((reference: { id: string }) => reference.id)).toEqual(["draft-reference"]);
        expect(page.config.imageModel).toBe("another-model");
        expect(page.requests).toHaveLength(0);
    });

    test("a pending A task finishes into A history while B stays untouched; revisiting A restores the new result", async () => {
        const pending = deferred<Image[]>();
        const page = pageHarness([storedLog("detail-enhance", "b", 20)], () => pending.promise);
        await page.settle();
        page.prompt().onChange({ target: { value: "generate only for A" } });
        expect(page.generate().disabled).toBe(false);
        page.generate().onClick();
        expect(page.requests).toHaveLength(1);
        page.navigate("detail-enhance");
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["b-image"]);
        pending.resolve([{ id: "completed-a", dataUrl: "data:image/png;base64,YQ==", sourceTaskId: "task-a" }]);
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["b-image"]);
        expect(page.panels()[0].logs.map((log: StoredLog) => log.id)).toEqual(["b"]);
        const saved = [...page.stored.values()].find(log => log.images.some(image => image.id === "completed-a"));
        expect(saved).toMatchObject({ ownerId: "designer-a", tool: "image-generation" });
        page.navigate("image-generation");
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["completed-a"]);
        expect(page.panels()[0].logs).toHaveLength(1);
        expect(page.requests).toHaveLength(1);
        expect(page.errors).toEqual([]);
    });

    test("returning to A before its pending task finishes receives the new result in the remounted workspace", async () => {
        const pending = deferred<Image[]>();
        const page = pageHarness([storedLog("image-generation", "a-old", 10), storedLog("detail-enhance", "b", 20)], () => pending.promise);
        await page.settle();
        page.prompt().onChange({ target: { value: "new A request" } });
        page.generate().onClick();
        page.navigate("detail-enhance");
        await page.settle();
        page.navigate("image-generation");
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["a-old-image"]);
        pending.resolve([{ id: "new-a", dataUrl: "data:image/png;base64,YQ==", sourceTaskId: "task-new-a" }]);
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["new-a"]);
        expect(page.panels()[0].logs[0]).toMatchObject({ ownerId: "designer-a", tool: "image-generation", prompt: "new A request" });
        expect(page.requests).toHaveLength(1);
        expect(page.errors).toEqual([]);
    });

    test("a previous account's pending task cannot write into the new account's visible or stored history", async () => {
        const pending = deferred<Image[]>();
        const page = pageHarness([storedLog("image-generation", "owner-b", 20, "designer-b")], () => pending.promise);
        await page.settle();
        page.prompt().onChange({ target: { value: "A's pending request" } });
        page.generate().onClick();
        page.setOwner("designer-b");
        await page.settle();
        pending.resolve([{ id: "late-owner-a", dataUrl: "data:image/png;base64,YQ==" }]);
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["owner-b-image"]);
        expect(page.panels()[0].logs.map((log: StoredLog) => log.id)).toEqual(["owner-b"]);
        expect([...page.stored.keys()]).toEqual(["owner-b"]);
        expect(page.requests).toHaveLength(1);
        expect(page.errors).toEqual([]);
    });

    test("late completion updates history without overriding a history preview explicitly chosen after returning", async () => {
        const pending = deferred<Image[]>();
        const page = pageHarness([storedLog("image-generation", "a-old", 10), storedLog("image-generation", "a-newer", 20)], () => pending.promise);
        await page.settle();
        page.prompt().onChange({ target: { value: "background request" } });
        page.generate().onClick();
        page.navigate("angle-control");
        await page.settle();
        page.navigate("image-generation");
        await page.settle();
        page.panels()[0].onPreviewLog(page.panels()[0].logs.find((log: StoredLog) => log.id === "a-old"));
        await page.settle();
        pending.resolve([{ id: "late-a", dataUrl: "data:image/png;base64,YQ==" }]);
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["a-old-image"]);
        expect(page.prompt().value).toBe("a-old prompt");
        expect(page.panels()[0].activeLogId).toBe("a-old");
        expect(page.panels()[0].logs[0].images[0].id).toBe("late-a");
        expect(page.errors).toEqual([]);
    });

    test("a new session created after returning stays empty when the previous task finishes", async () => {
        const pending = deferred<Image[]>();
        const page = pageHarness([storedLog("image-generation", "a-old", 10)], () => pending.promise);
        await page.settle();
        page.prompt().onChange({ target: { value: "previous request" } });
        page.generate().onClick();
        page.navigate("image-edit");
        await page.settle();
        page.navigate("image-generation");
        await page.settle();
        page.panels()[0].onCreateSession();
        page.prompt().onChange({ target: { value: "fresh draft" } });
        pending.resolve([{ id: "previous-result", dataUrl: "data:image/png;base64,YQ==" }]);
        await page.settle();
        expect(page.images()).toEqual([]);
        expect(page.prompt().value).toBe("fresh draft");
        expect(page.panels()[0].activeLogId).toBeUndefined();
        expect(page.panels()[0].logs[0].images[0].id).toBe("previous-result");
        expect(page.errors).toEqual([]);
    });

    test("a failed slot retry preserves the other successful image from the current batch", async () => {
        let calls = 0;
        const page = pageHarness([], async () => {
            calls++;
            if (calls === 2) throw new Error("Simulated second-slot failure");
            return [{ id: calls === 1 ? "first-slot" : "retried-slot", dataUrl: "data:image/png;base64,YQ==" }];
        });
        await page.settle();
        page.config.count = "2";
        page.prompt().onChange({ target: { value: "two image batch" } });
        page.generate().onClick();
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["first-slot"]);
        expect(page.failedCards()).toHaveLength(1);
        await page.failedCards()[0]!.props.onRetry();
        await page.settle();
        expect(page.images().map(image => image.id)).toEqual(["first-slot", "retried-slot"]);
        expect(page.failedCards()).toEqual([]);
        expect(page.panels()[0].logs).toHaveLength(2);
        expect(page.requests).toHaveLength(3);
        expect(page.errors).toEqual([]);
    });
});
