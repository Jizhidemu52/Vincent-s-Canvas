import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { activeStatuses, designResultNodeId, designTaskMetadata, taskLabel } from "../src/components/canvas/design-discussion/task-model.mjs";

const sourceUrl = new URL("../src/components/canvas/design-discussion/CanvasDesignDiscussion.jsx", import.meta.url);
const requireModule = createRequire(sourceUrl);
const code = ts.transpileModule(readFileSync(sourceUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const ownerId = "designer-a";
const projectId = "canvas-a";
const resultUrl = "/api/assets/11111111-1111-4111-8111-111111111111/content";
const storedImage = { url: resultUrl, storageKey: "stored-result", width: 500, height: 700, bytes: 100, mimeType: "image/png" };
const savedTask = { id: "local-task", requestId: "original-request", taskId: "server-task", ownerId, projectId, status: "success", mediaKind: "image", resultUrls: [resultUrl], references: [], prompt: "保留针织纹理", userText: "旧员工设计要求", proposal: { title: "旧员工方案", features: ["蓝灰色"] } };
type Data = Record<string, any>;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function harness(options: { tasks?: Data[]; savedSession?: Data; upload?: (url: string, video: boolean) => Promise<Data>; resolveImage?: (key: string, fallback: string) => Promise<string>; nodes?: Data[]; selected?: string[]; conversations?: boolean } = {}) {
    const state: any[] = [], effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
    const layouts: Array<() => void> = [], queued: Array<() => void> = [];
    const timers = new Set<() => Promise<unknown> | void>();
    const events = new Map<string, Set<(event: Data) => void>>();
    const downloads: Array<{ url: string; video: boolean }> = [], starts: Data[] = [], histories: string[] = [], locations: string[][] = [];
    const writes: Array<{ key: string; value: Data }> = [], runtime: Data[] = [];
    const records = new Map<string, Data>();
    if (options.savedSession) records.set(`${ownerId}:${projectId}:session`, structuredClone(options.savedSession));
    const graphs = new Map<string, { nodes: Data[]; selected: Set<string> }>([[projectId, { nodes: options.nodes || [], selected: new Set(options.selected) }]]);
    let identity = { status: "authenticated", user: { id: ownerId, status: "active" } };
    let serverOwner = ownerId;
    let currentProject = projectId;
    let historyError = false;
    let cursor = 0;
    let sessionSequence = 0;
    let disposed = false;
    const equal = (first?: unknown[], second?: unknown[]) => Boolean(first && second && first.length === second.length && first.every((value, index) => Object.is(value, second[index])));
    const schedule = (effect: () => (() => void) | undefined, deps: unknown[], queue: Array<() => void>) => {
        const index = cursor++;
        if (!equal(deps, effects[index]?.deps)) queue.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
    };
    const memo = (factory: () => unknown, deps: unknown[]) => {
        const index = cursor++;
        if (!state[index] || !equal(deps, state[index].deps)) state[index] = { deps, value: factory() };
        return state[index].value;
    };
    const graph = () => graphs.get(currentProject)!;
    const setNodes = (next: Data[] | ((nodes: Data[]) => Data[])) => { graph().nodes = typeof next === "function" ? next(graph().nodes) : next; };
    const setSelected = (next: Set<string>) => { graph().selected = next; };
    const upload = async (url: string, video = false) => {
        downloads.push({ url, video });
        return options.upload ? options.upload(url, video) : { ...storedImage };
    };
    const newSession = (references: Data[] = []) => ({ id: `session-${++sessionSequence}`, references, history: [], prompt: "", brief: {}, designRecord: {}, outputKind: "image" });
    const userStore = Object.assign((select: (value: Data) => unknown) => select(identity), { getState: () => identity });
    const dependencies: Record<string, any> = {
        react: { ...React,
            useState(initial: any) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (next: any) => { if (!disposed) state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
            useRef(initial: unknown) { const index = cursor++; return state[index] ||= { current: initial }; },
            useMemo: memo,
            useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
            useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => schedule(effect, deps, queued),
            useLayoutEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => schedule(effect, deps, layouts),
        },
        "lucide-react": { ChevronDown: "icon", LocateFixed: "icon", RefreshCw: "icon", Sparkles: "icon", X: "icon" },
        "@/stores/canvas/canvas-graph-store": { useCanvasGraphField: (field: string) => field === "nodes" ? [graph().nodes, setNodes] : [graph().selected, setSelected] },
        "@/stores/use-user-store": { useUserStore: userStore },
        "@/lib/deployment-features": { deploymentFeatures: { imageConversationsEnabled: options.conversations === true } },
        "@/lib/workspace-storage": { createWorkspaceStorage: () => {
            const owner = identity.user.id;
            return { isCurrent: () => owner === identity.user.id && identity.status === "authenticated", getItem: async (key: string) => records.get(key) || null, setItem: async (key: string, value: Data) => { writes.push({ key, value }); records.set(key, value); }, iterate: async () => {} };
        } },
        "@/services/image-storage": { resolveImageUrl: (key: string, fallback: string) => options.resolveImage ? options.resolveImage(key, fallback) : Promise.resolve(fallback), uploadImage: (url: string) => upload(url) },
        "@/services/api/video": { storeGeneratedVideo: ({ url }: { url: string }) => upload(url, true) },
        "@/services/api/design-discussion.mjs": {
            createApi: () => ({ session: async () => ({ user: { id: serverOwner, status: "active" } }), catalog: async () => ({ models: [], tools: [] }) }),
            createTaskController: (configuration: Data) => {
                const localTasks = (options.tasks || []).filter(task => task.ownerId === configuration.ownerId && task.projectId === configuration.projectId);
                const controller = {
                    ...configuration,
                    needsRefresh: () => localTasks.some(task => ["processing", "waiting"].includes(task.status)),
                    async refreshAnnotations() {},
                    async load() { configuration.onChange([...localTasks]); },
                    async refreshAll() { if (serverOwner !== configuration.ownerId) throw Object.assign(new Error("登录身份已变化"), { code: "SESSION_CHANGED" }); configuration.onChange([...localTasks]); },
                    async action() { configuration.onChange([...localTasks]); },
                    async start(input: Data) { starts.push(input); return { ...savedTask, status: "processing" }; },
                };
                runtime.push(controller);
                return controller;
            },
        },
        "@/pages/canvas/canvas-project-utils": { createCanvasNode: (type: string, position: Data, metadata: Data) => ({ id: crypto.randomUUID(), type, position, metadata, width: 500, height: 700 }), imageMetadata: (stored: Data) => ({ content: stored.url, storageKey: stored.storageKey }), videoMetadata: (stored: Data) => ({ content: stored.url, storageKey: stored.storageKey }) },
        "@/lib/canvas/canvas-node-size": { fitNodeSize: (width: number, height: number) => ({ width, height }) },
        "@/types/canvas": { CanvasNodeType: { Image: "image", Video: "video" } },
        "./StudioPanel.jsx": { StudioPanel: "StudioPanel", newStudioSession: newSession },
        "./task-model.mjs": { activeStatuses, designResultNodeId, designTaskMetadata, taskLabel },
        "./studio-media.mjs": { readImageFiles: async (files: Data[]) => files },
        "./design-record.mjs": { continueDesignRecord: () => ({}) },
        "./studio.css": {}, "./canvas-discussion.css": {},
    };
    const props = { writable: { current: true }, getCanvasCenter: () => ({ x: 0, y: 0 }), onBeforeChange: () => { if (historyError) throw new Error("fixture canvas history unavailable"); histories.push(currentProject); }, onLocate: (ids: string[]) => locations.push(ids) };
    const module = { exports: {} as Data };
    new Function("require", "module", "exports", "window", "setInterval", "clearInterval", code)(
        (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports,
        { addEventListener(name: string, listener: (event: Data) => void) { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(listener); }, removeEventListener(name: string, listener: (event: Data) => void) { events.get(name)?.delete(listener); } }, (callback: () => void) => { timers.add(callback); return callback; }, (callback: () => void) => timers.delete(callback),
    );
    const render = () => {
        cursor = 0;
        const tree = elements(module.exports.CanvasDesignDiscussion({ ...props, projectId: currentProject }));
        for (const effect of layouts.splice(0)) effect();
        for (const effect of queued.splice(0)) effect();
        return tree;
    };
    const settle = async () => { let tree = render(); for (let index = 0; index < 35; index++) { await Promise.resolve(); tree = render(); } return tree; };
    return {
        render, settle, downloads, starts, histories, locations, writes, runtime, props,
        panel: () => render().find(element => element.type === "StudioPanel")!.props,
        nodes: (id = currentProject) => graphs.get(id)?.nodes || [],
        select(ids: string[]) { setSelected(new Set(ids)); },
        switchProject(id: string, nodes: Data[] = []) { currentProject = id; graphs.set(id, { nodes, selected: new Set() }); },
        switchOwner(id: string) { identity = { ...identity, user: { ...identity.user, id } }; serverOwner = id; },
        switchServerOwner(id: string) { serverOwner = id; },
        setHistoryError(value: boolean) { historyError = value; },
        keydown(key: string) { for (const listener of events.get("keydown") || []) listener({ key }); },
        async tick() { for (const callback of [...timers]) await callback(); return settle(); },
        dispose() { disposed = true; effects.forEach(effect => effect.cleanup?.()); },
    };
}

function button(tree: ReactElement<any>[], label: string) {
    const element = tree.find(item => item.type === "button" && item.props["aria-label"] === label);
    if (!element) throw new Error(`Missing fixture button: ${label}`);
    return element;
}

test("typing merges the latest draft without repeatedly persisting document image bytes", async () => {
    const subject = harness();
    try {
        await subject.settle();
        const dataUrl = "data:image/png;base64," + "A".repeat(1024 * 1024);
        subject.panel().onChange({ documents: [{ id: "document", figures: [{ id: "figure", dataUrl }] }] });
        for (let index = 0; index < 40; index++) subject.panel().onChange({ prompt: `草稿 ${index}` });
        await subject.panel().onSave();
        expect(subject.panel().session.prompt).toBe("草稿 39");
        const sessions = subject.writes.filter(write => write.key.endsWith(":session:media-v1"));
        expect(sessions).toHaveLength(1);
        expect(JSON.stringify(sessions[0].value)).not.toContain(dataUrl);
        expect(subject.writes.filter(write => JSON.stringify(write.value).includes(dataUrl))).toHaveLength(1);
    } finally { subject.dispose(); }
});

describe("conversation result projection identity", () => {
    const version = { id: "81000000-0000-4000-8000-000000000003", conversationId: "81000000-0000-4000-8000-000000000001", assetId: "11111111-1111-4111-8111-111111111111", turnId: "81000000-0000-4000-8000-000000000006" };
    const task = { ...savedTask, resultVersions: [version], conversationExecution: { phase: "completed", turnDispatchStartedAt: "2026-11-19T04:00:00Z" } };
    test("a persisted version with another node id is reused and located without download or POST", async () => {
        const node = { id: "already-installed-version", type: "image", position: { x: 10, y: 20 }, width: 500, height: 700, metadata: { content: resultUrl, imageConversation: { conversationId: version.conversationId, versionId: version.id, assetId: version.assetId, turnId: version.turnId } } };
        const subject = harness({ conversations: true, tasks: [task], nodes: [node] });
        try {
            await subject.settle(); await subject.tick();
            button(subject.render(), "查看设计生成任务").props.onClick();
            button(subject.render(), "定位设计结果").props.onClick();
            expect(subject.nodes()).toEqual([node]); expect(subject.downloads).toEqual([]); expect(subject.starts).toEqual([]);
            expect(subject.locations.at(-1)).toEqual([node.id]);
        } finally { subject.dispose(); }
    });
    test("the original placeholder becomes one version-bound node at the same position", async () => {
        const position = { x: 530, y: 780 };
        const placeholder = { id: `design-${task.id}-0`, type: "image", position, width: 420, height: 420, metadata: designTaskMetadata(task) };
        const subject = harness({ conversations: true, tasks: [task], nodes: [placeholder] });
        try {
            await subject.settle(); await subject.tick();
            expect(subject.nodes()).toHaveLength(1);
            expect(subject.nodes()[0]).toMatchObject({ id: `design-version-${version.id}`, position, metadata: { imageConversation: { versionId: version.id, conversationId: version.conversationId, assetId: version.assetId, turnId: version.turnId }, designExecutionId: task.id } });
            expect(subject.downloads).toHaveLength(1); expect(subject.starts).toEqual([]);
            subject.props.writable.current = false;
            expect(() => subject.runtime[0].assertWritable()).toThrow("不可写");
        } finally { subject.dispose(); }
    });
});

describe("task island hover and pinned interaction", () => {
    test("hover previews tasks and pointer leave closes an unpinned preview", async () => {
        const subject = harness();
        try {
            await subject.settle();
            const island = () => subject.render().find(element => element.props.className === "dd-island")!;
            expect(button(subject.render(), "查看设计生成任务").props["aria-expanded"]).toBe(false);
            island().props.onMouseEnter();
            expect(button(subject.render(), "查看设计生成任务").props).toMatchObject({ "aria-expanded": true, "aria-pressed": false });
            island().props.onMouseLeave();
            expect(button(subject.render(), "查看设计生成任务").props).toMatchObject({ "aria-expanded": false, "aria-pressed": false });
            expect(subject.starts).toEqual([]);
        } finally { subject.dispose(); }
    });

    test("clicking a hovered arrow pins the preview and a repeated click collapses it", async () => {
        const subject = harness();
        try {
            await subject.settle();
            const island = () => subject.render().find(element => element.props.className === "dd-island")!;
            island().props.onMouseEnter();
            button(subject.render(), "查看设计生成任务").props.onClick();
            expect(button(subject.render(), "查看设计生成任务").props).toMatchObject({ "aria-expanded": true, "aria-pressed": true });
            island().props.onMouseLeave();
            expect(button(subject.render(), "查看设计生成任务").props["aria-expanded"]).toBe(true);
            island().props.onMouseEnter();
            button(subject.render(), "查看设计生成任务").props.onClick();
            expect(button(subject.render(), "查看设计生成任务").props).toMatchObject({ "aria-expanded": false, "aria-pressed": false });
            island().props.onMouseLeave();
            island().props.onMouseEnter();
            expect(button(subject.render(), "查看设计生成任务").props).toMatchObject({ "aria-expanded": true, "aria-pressed": false });
            expect(subject.starts).toEqual([]);
        } finally { subject.dispose(); }
    });

    test("Escape closes a pinned island and clears the pin for the next hover", async () => {
        const subject = harness();
        try {
            await subject.settle();
            button(subject.render(), "查看设计生成任务").props.onClick();
            expect(button(subject.render(), "查看设计生成任务").props["aria-pressed"]).toBe(true);
            subject.keydown("Escape");
            expect(button(subject.render(), "查看设计生成任务").props).toMatchObject({ "aria-expanded": false, "aria-pressed": false });
            subject.render().find(element => element.props.className === "dd-island")!.props.onMouseEnter();
            expect(button(subject.render(), "查看设计生成任务").props["aria-pressed"]).toBe(false);
            subject.render().find(element => element.props.className === "dd-island")!.props.onMouseLeave();
            expect(button(subject.render(), "查看设计生成任务").props["aria-expanded"]).toBe(false);
            expect(subject.starts).toEqual([]);
        } finally { subject.dispose(); }
    });
});

describe("canvas design discussion async ownership", () => {
    test("restored canvas selection does not replace saved references, but a new selection still imports", async () => {
        const references = ["source-a", "source-b"].map(id => ({ id, title: id, image: resultUrl }));
        const resultNodes = ["result-a", "result-b", "result-c"].map(id => ({ id, title: id, type: "image", metadata: { content: resultUrl, sourceTaskId: id } }));
        const session = { id: "restored-session", references, history: [], prompt: "", brief: {} };
        const subject = harness({ savedSession: session, nodes: resultNodes, selected: resultNodes.map(node => node.id) });
        try {
            await subject.settle();
            expect(subject.panel().session.references.map((reference: Data) => reference.id)).toEqual(["source-a", "source-b"]);
            subject.panel().onChange({ references: [] });
            await subject.tick();
            expect(subject.panel().session.references).toEqual([]);
            subject.select(["result-b"]);
            await subject.settle();
            expect(subject.panel().session.references.map((reference: Data) => reference.id)).toEqual(["result-b"]);
        } finally { subject.dispose(); }
    });

    test("manually cleared references are not restored by a late canvas selection read", async () => {
        const pending = deferred<string>();
        const node = { id: "pending-reference", title: "稍后读取的图", type: "image", metadata: { content: resultUrl } };
        const subject = harness({ nodes: [node], resolveImage: () => pending.promise });
        try {
            await subject.settle();
            subject.select([node.id]);
            await subject.settle();
            subject.panel().onChange({ references: [] });
            pending.resolve(resultUrl);
            await subject.settle();
            expect(subject.panel().session.references).toEqual([]);
        } finally { subject.dispose(); }
    });

    test("a result finishing after a project change never inserts into the new canvas", async () => {
        const pending = deferred<Data>();
        const subject = harness({ tasks: [savedTask], upload: () => pending.promise });
        try {
            await subject.settle();
            expect(subject.downloads).toHaveLength(1);
            const sentinel = { id: "canvas-b-original", type: "image", position: { x: 0, y: 0 }, width: 40, metadata: {} };
            subject.switchProject("canvas-b", [sentinel]);
            await subject.settle();
            pending.resolve(storedImage);
            await subject.settle();
            expect(subject.nodes()).toEqual([sentinel]);
            expect(subject.nodes(projectId)).toEqual([]);
            expect(subject.histories).toEqual([]);
            expect(subject.panel().session.references).toEqual([]);
        } finally { subject.dispose(); }
    });

    test.each(["image", "video"])("an unmounted %s result never changes canvas nodes", async mediaKind => {
        const pending = deferred<Data>();
        const subject = harness({ tasks: [{ ...savedTask, mediaKind }], upload: () => pending.promise });
        await subject.settle();
        expect(subject.downloads).toEqual([{ url: resultUrl, video: mediaKind === "video" }]);
        subject.dispose();
        pending.resolve(storedImage);
        for (let index = 0; index < 15; index++) await Promise.resolve();
        expect(subject.nodes()).toEqual([]);
        expect(subject.histories).toEqual([]);
    });

    test("an imported image completing in another project cannot update its nodes or references", async () => {
        const pending = deferred<Data>();
        const subject = harness({ upload: () => pending.promise });
        try {
            await subject.settle();
            const importing = subject.panel().onImport([{ id: "import-a", image: "data:image/png;base64,AA==", title: "旧图" }]);
            await Promise.resolve();
            subject.switchProject("canvas-b");
            await subject.settle();
            pending.resolve(storedImage);
            await expect(importing).rejects.toThrow("画布或员工会话已变化");
            await subject.settle();
            expect(subject.nodes()).toEqual([]);
            expect(subject.histories).toEqual([]);
            expect(subject.panel().session.references).toEqual([]);
        } finally { subject.dispose(); }
    });

    test("late selected-reference resolution and runtime callbacks stay in their original project", async () => {
        const pending = deferred<string>();
        const node = { id: "private-reference", title: "旧图", type: "image", metadata: { content: resultUrl, storageKey: "old-key" } };
        const subject = harness({ nodes: [node], selected: [node.id], resolveImage: () => pending.promise });
        try {
            await subject.settle();
            const originalRuntime = subject.runtime[0];
            subject.switchProject("canvas-b");
            await subject.settle();
            originalRuntime.onChange([savedTask]);
            pending.resolve(resultUrl);
            await subject.settle();
            expect(subject.panel().session.references).toEqual([]);
            expect(subject.panel().items).toEqual([]);
            expect(subject.downloads).toEqual([]);
            expect(subject.render().some(element => element.props["data-design-task-id"] === savedTask.id)).toBe(false);
        } finally { subject.dispose(); }
    });

    test("an employee change immediately hides prior conversation, references and tasks", async () => {
        const session = { id: "private-session", references: [{ id: "private-ref", title: "旧员工图片", image: resultUrl }], history: [{ role: "user", content: "旧员工保密要求" }], prompt: "旧员工草稿", brief: {} };
        const subject = harness({ savedSession: session, tasks: [{ ...savedTask, status: "failed" }] });
        try {
            await subject.settle();
            expect(subject.panel().session.history).toHaveLength(1);
            const stalePanel = subject.panel();
            subject.switchOwner("designer-b");
            const immediate = subject.render().find(element => element.type === "StudioPanel")!.props;
            expect(immediate.session.history).toEqual([]);
            expect(immediate.session.references).toEqual([]);
            expect(immediate.ownerId).toBe("");
            expect(immediate.catalog).toBeNull();
            expect(immediate.ready).toBe(false);
            stalePanel.onChange({ prompt: "迟到的旧员工回复" });
            subject.runtime[0].onChange([savedTask]);
            await subject.settle();
            expect(subject.panel().session.prompt).toBe("");
            expect(subject.panel().items).toEqual([]);
            expect(subject.runtime).toHaveLength(1);
            expect(subject.downloads).toEqual([]);
        } finally { subject.dispose(); }
    });

    test("a backend identity change clears stale records when the original task is polled", async () => {
        const subject = harness({ tasks: [{ ...savedTask, status: "processing" }], savedSession: { id: "private-session", references: [], history: [{ role: "user", content: "旧员工要求" }], prompt: "", brief: {} } });
        try {
            await subject.settle();
            subject.switchServerOwner("designer-b");
            await subject.tick();
            expect(subject.panel().ready).toBe(false);
            expect(subject.panel().ownerId).toBe("");
            expect(subject.panel().session.history).toEqual([]);
            expect(subject.panel().items).toEqual([]);
            expect(subject.starts).toEqual([]);
        } finally { subject.dispose(); }
    });

    test("identity changing during result download prevents installation even before polling", async () => {
        const pending = deferred<Data>();
        const subject = harness({ tasks: [savedTask], upload: () => pending.promise });
        try {
            await subject.settle();
            subject.switchServerOwner("designer-b");
            pending.resolve(storedImage);
            await subject.settle();
            expect(subject.nodes()).toEqual([]);
            expect(subject.histories).toEqual([]);
            expect(subject.panel().ready).toBe(false);
            expect(subject.panel().ownerId).toBe("");
        } finally { subject.dispose(); }
    });
});

describe("original result recovery without generation", () => {
    test.each(["image", "video"])("failed %s installation retries the same result only on explicit action", async mediaKind => {
        let attempts = 0;
        const subject = harness({ tasks: [{ ...savedTask, mediaKind }], upload: async () => { if (++attempts === 1) throw new Error("fixture download interrupted"); return storedImage; } });
        try {
            await subject.settle();
            expect(subject.downloads).toHaveLength(1);
            await subject.tick();
            expect(subject.downloads).toHaveLength(1);
            button(subject.render(), "查看设计生成任务").props.onClick();
            const tree = subject.render();
            expect(tree.some(element => element.type === "small" && String(element.props.children).includes("放入画布失败"))).toBe(true);
            button(tree, "重试放入设计结果").props.onClick();
            await subject.settle();
            expect(subject.downloads).toEqual([{ url: resultUrl, video: mediaKind === "video" }, { url: resultUrl, video: mediaKind === "video" }]);
            expect(subject.nodes()).toHaveLength(1);
            expect(subject.nodes()[0]).toMatchObject({ id: "design-local-task-0", type: mediaKind, metadata: { sourceTaskId: "server-task" } });
            expect(subject.starts).toEqual([]);
            button(subject.render(), "定位设计结果").props.onClick();
            expect(subject.locations).toEqual([["design-local-task-0"]]);
        } finally { subject.dispose(); }
    });

    test("a canvas insertion failure remains recoverable without creating a new task", async () => {
        const subject = harness({ tasks: [savedTask] });
        try {
            subject.setHistoryError(true);
            await subject.settle();
            expect(subject.nodes()).toEqual([]);
            subject.setHistoryError(false);
            button(subject.render(), "查看设计生成任务").props.onClick();
            button(subject.render(), "重试放入设计结果").props.onClick();
            await subject.settle();
            expect(subject.nodes()).toHaveLength(1);
            expect(subject.histories).toEqual([projectId]);
            expect(subject.starts).toEqual([]);
        } finally { subject.dispose(); }
    });

    test.each(["success", "processing"])("a restored %s task reused before its batch receipt was saved keeps only its original canvas node", async status => {
        const original = { ...savedTask, status, resultUrls: status === "success" ? [resultUrl] : [] };
        const subject = harness({ tasks: [original] });
        const receipts: Data[] = [];
        try {
            await subject.settle();
            subject.runtime[0].start = async (input: Data) => {
                expect(input.requestId).not.toBe(original.requestId);
                return original;
            };
            button(subject.render(), "打开设计讨论").props.onClick();
            await subject.panel().onSubmitBatch([{ generationAllowed: true, prompt: "reuse the recorded proposal slot" }], (task: Data) => receipts.push(task));
            await subject.settle();
            expect(receipts).toEqual([original]);
            expect(subject.nodes()).toHaveLength(1);
            expect(subject.nodes()[0].id).toBe("design-local-task-0");
            if (status === "processing") {
                expect(subject.nodes()[0].metadata).toMatchObject({ status: "loading", designTask: { requestId: original.requestId, status } });
                subject.runtime[0].onChange([savedTask]);
                await subject.settle();
            }
            expect(subject.nodes()).toHaveLength(1);
            expect(subject.nodes()[0].metadata).toMatchObject({ content: resultUrl, sourceTaskId: original.taskId });
            expect(subject.downloads).toHaveLength(1);
        } finally { subject.dispose(); }
    });

    test("mounting and hiding the panel never submit generation, including stale open callbacks", async () => {
        const subject = harness();
        try {
            await subject.settle();
            await expect(subject.panel().onSubmitBatch([{ generationAllowed: true }], () => {})).rejects.toThrow("已关闭");
            expect(subject.starts).toEqual([]);
            button(subject.render(), "打开设计讨论").props.onClick();
            const opened = subject.panel();
            expect(opened.visible).toBe(true);
            await opened.onSubmitBatch([{ generationAllowed: true, prompt: "explicit action" }], () => {});
            expect(subject.starts).toHaveLength(1);
            expect(subject.panel().visible).toBe(true);
            opened.onClose();
            await expect(opened.onSubmitBatch([{ generationAllowed: true }], () => {})).rejects.toThrow("已关闭");
            await subject.tick();
            expect(subject.starts).toHaveLength(1);
        } finally { subject.dispose(); }
    });
});
