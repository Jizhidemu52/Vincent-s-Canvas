import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createCanvasCloudSync, type CanvasCloudBaseline } from "@/lib/canvas/canvas-cloud-sync";
import { CanvasRevisionConflict, type CloudCanvasDocument } from "@/services/api/canvas-documents";
import { collectProjectChanges, createProjectChangeBuffer, mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import { canvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { applyCanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import { serializeCanvasProject } from "@/lib/canvas/canvas-project-codec";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

function moduleCode(path: string) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return ts.transpileModule(ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join("\n"), {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;
}
const serviceCode = moduleCode("../src/services/canvas-cloud-persistence.ts");
const storeCode = moduleCode("../src/stores/canvas/use-canvas-store.ts");
const clone = <T>(value: T): T => structuredClone(value);
const owner = "employee-a";
const name = `wireless-canvas:canvas_store:oa:user:${owner}`;
const mediaUrl = "/api/assets/11111111-2222-4333-8444-555555555555/content";
function project(id = "cloud", title = "完整项目"): CanvasProject {
    return {
        id, title, createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z",
        nodes: [{ id: "image", type: "image", title: "原稿", width: 640, height: 320, position: { x: -123, y: 456 }, metadata: { content: mediaUrl, bytes: 12, prompt: "保留原稿" } }],
        connections: [], chatSessions: [{ id: "chat", title: "讨论", createdAt: "old", updatedAt: "old", messages: [{ id: "m", role: "user", text: "完整讨论" }] }],
        activeChatId: "chat", backgroundMode: "dots", showImageInfo: true, viewport: { x: 1, y: 2, k: .8 },
    } as CanvasProject;
}
const envelope = (document: CanvasProject | null, revision = 7, id = document?.id || "cloud"): CloudCanvasDocument => ({ id, document: clone(document), revision, deleted: !document, updatedAt: "now" });
const known = (document: CanvasProject, revision = 7): CanvasCloudBaseline => ({ [document.id]: { revision, local: serializeCanvasProject(document) } });

function harness(remoteDocuments: CloudCanvasDocument[] = [envelope(project())], local: CanvasProject[] = [], baseline: CanvasCloudBaseline = {}) {
    const remote = new Map(remoteDocuments.map(document => [document.id, clone(document)]));
    const state = {
        local: clone(local), baseline: clone(baseline), valid: true, nextId: 0,
        gets: [] as string[], puts: [] as Array<{ id: string; revision: number; document: CanvasProject | null }>,
        writes: [] as string[], statuses: [] as string[], copies: [] as CanvasProject[], unloaded: [] as any[],
        baselineReads: 0, baselineWrites: 0, writeFailure: false, baselineFailure: false,
        beforeWrite: undefined as (() => Promise<void>) | undefined,
        beforeGet: undefined as (() => Promise<void>) | undefined,
        beforeBaselineRead: undefined as (() => Promise<void>) | undefined,
    };
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const readCanvasProjects = async () => clone(state.local);
    const writeCanvasProjects = async (key: string, changes: Parameters<typeof mergeProjectChanges<CanvasProject>>[1]) => {
        await state.beforeWrite?.();
        if (state.writeFailure) throw new Error("disk unavailable");
        state.local = clone(mergeProjectChanges(state.local, changes));
        state.writes.push(key);
        return clone(state.local);
    };
    const bindings = {
        createCanvasCloudSync, collectProjectChanges, nanoid: () => `copy-${++state.nextId}`,
        localforage: {
            getItem: async () => { state.baselineReads += 1; await state.beforeBaselineRead?.(); return clone(state.baseline); },
            setItem: async (_key: string, value: CanvasCloudBaseline) => { if (state.baselineFailure) throw new Error("baseline unavailable"); state.baselineWrites += 1; state.baseline = clone(value); },
        },
        runLocalForageStorage: async (run: () => unknown) => run(),
        listCloudCanvases: async () => ({ documents: [...remote.values()].map(({ document, ...metadata }) => ({ ...clone(metadata), summary: document ? canvasProjectSummary(document) : null })) }),
        getCloudCanvas: async (_owner: string, id: string) => { state.gets.push(id); await state.beforeGet?.(); return clone(remote.get(id) || envelope(null, 0, id)); },
        putCloudCanvas: async (_owner: string, id: string, revision: number, document: CanvasProject | null) => {
            state.puts.push({ id, revision, document: clone(document) });
            const previous = remote.get(id);
            if (previous ? previous.revision !== revision || (previous.deleted && document) : revision !== 0) throw new CanvasRevisionConflict(clone(previous || envelope(null, 0, id)));
            const saved = envelope(document, (previous?.revision || 0) + 1, id);
            remote.set(id, saved);
            return clone(saved);
        },
        makeCloudCanvas: async (_owner: string, document: CanvasProject) => {
            const portable = clone(document);
            for (const node of portable.nodes) if (node.metadata?.storageKey) { node.metadata.content = mediaUrl; delete node.metadata.storageKey; }
            return portable;
        },
        readCanvasProjects, writeCanvasProjects,
        window: undefined,
        setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id: number) => timers.delete(id),
    };
    const exported: any = {};
    new Function(...Object.keys(bindings), "exports", serviceCode)(...Object.values(bindings), exported);
    const factory = exported.createCloudCanvasPersistence;
    const service = factory(owner, name, {
        valid: () => state.valid,
        status: (status: string) => state.statuses.push(status),
        copy: (value: CanvasProject) => state.copies.push(value),
        unloaded: (values: any[]) => { state.unloaded = values; },
    });
    return { state, remote, timers, service, factory, readCanvasProjects, writeCanvasProjects };
}

async function openStore(io: ReturnType<typeof harness>) {
    const userStore = create<any>(() => ({ user: { id: owner, role: "designer" }, status: "authenticated" }));
    let reloads = 0;
    const bindings = {
        create, persist, nanoid: () => `local-${++io.state.nextId}`, createDeferredPersistQueue: <T>(delay: number, flush: (value: T) => void) => createDeferredPersistQueue(delay, flush, { setTimeout: () => 1, clearTimeout() {} }),
        collectProjectChanges, createProjectChangeBuffer, applyCanvasProjectPatch,
        readCanvasProjects: io.readCanvasProjects, writeCanvasProjects: io.writeCanvasProjects, removeCanvasProjects: async () => { io.state.local = []; },
        deploymentFeatures: { oaLoginEnabled: true }, useUserStore: userStore,
        createCloudCanvasPersistence: io.factory,
        window: { addEventListener() {}, location: { reload() { reloads += 1; } } },
        console: { error() {} },
    };
    const exported: any = {};
    new Function(...Object.keys(bindings), "exports", storeCode)(...Object.values(bindings), exported);
    const store = exported.useCanvasStore;
    if (!store.persist.hasHydrated()) await new Promise<void>(resolve => {
        const unsubscribe = store.persist.onFinishHydration(() => { unsubscribe(); resolve(); });
    });
    return { ...exported, store, userStore, reloads: () => reloads };
}

test("service summary hydration and idle flush never fetch or delete unopened projects", async () => {
    const io = harness(Array.from({ length: 60 }, (_, index) => envelope(project(`cloud-${index}`))));
    expect(await io.service.hydrate([])).toEqual([]);
    expect(io.state.unloaded).toHaveLength(60);
    expect(io.state.gets).toEqual([]);
    await io.service.flush();
    expect(io.state.puts).toEqual([]);
    expect([...io.remote.values()].every(item => !item.deleted)).toBe(true);
});

test("service adopts a matching document loaded by another tab before exposing it for rename", async () => {
    const original = project(); const io = harness([envelope(original)]);
    await io.service.hydrate([]);
    await io.service.flush();
    io.state.local = [clone(original)];
    expect(await io.service.load(original.id)).toEqual(original);
    expect(io.state.unloaded).toEqual([]);
    expect(io.state.baseline[original.id]).toEqual(known(original)[original.id]);
    io.state.local[0] = { ...io.state.local[0], title: "立即改名" };
    io.service.schedule(); await io.service.flush();
    expect(io.state.puts).toHaveLength(1);
    expect(io.state.puts[0].revision).toBe(7);
    expect(io.remote.size).toBe(1);
    expect(io.remote.get(original.id)!.document!.nodes).toEqual(original.nodes);
});

test("matching cached original media receives the remote baseline without losing local media bytes", async () => {
    const original = project(); const io = harness([envelope(original)]);
    await io.service.hydrate([]); await io.service.flush();
    const cached = clone(original);
    cached.nodes[0].metadata = { ...cached.nodes[0].metadata, content: "blob:original-cache", storageKey: "image:original-cache" };
    io.state.local = [cached];
    const loaded = await io.service.load(cached.id);
    expect(loaded).toEqual(cached);
    expect(io.state.baseline[cached.id]).toEqual(known(cached)[cached.id]);
    expect(io.state.unloaded).toEqual([]);
    io.state.local[0] = { ...cached, title: "缓存图改名" };
    io.service.schedule(); await io.service.flush();
    expect(io.state.puts).toHaveLength(1);
    expect(io.state.puts[0].revision).toBe(7);
});

test("a divergent cross-tab local draft is retained and the competing remote remains recoverable", async () => {
    const original = project(); const io = harness([envelope(original)]);
    await io.service.hydrate([]); await io.service.flush();
    const local = { ...original, title: "未确认的另一窗口本地稿" };
    io.state.local = [local];
    expect(await io.service.load(local.id)).toEqual(local);
    expect(io.state.unloaded).toEqual([]);
    io.service.schedule(); await io.service.flush();
    expect(io.remote.get(local.id)!.document!.title).toBe(local.title);
    expect([...io.remote.values()].some(item => item.id !== local.id && item.document?.title.includes(original.title))).toBe(true);
});

test("failed durable on-demand storage leaves no baseline or tombstone and retry restores the full document", async () => {
    const io = harness();
    await io.service.hydrate([]); await io.service.flush();
    io.state.writeFailure = true;
    await expect(io.service.load("cloud")).rejects.toThrow("disk unavailable");
    expect(io.state.baseline.cloud).toBeUndefined();
    expect(io.state.local).toEqual([]);
    expect(io.state.unloaded).toHaveLength(1);
    io.service.schedule(); await io.service.flush();
    expect(io.state.puts).toEqual([]);
    expect(io.remote.get("cloud")!.deleted).toBe(false);
    io.state.writeFailure = false;
    const restored = await io.service.load("cloud");
    expect(restored).toEqual(project());
    expect(io.state.baseline.cloud.revision).toBe(7);
    expect(io.state.unloaded).toEqual([]);
});

test("a failed baseline checkpoint is durably retried when opening the already-written document", async () => {
    const io = harness();
    await io.service.hydrate([]); await io.service.flush();
    io.state.baselineFailure = true;
    await expect(io.service.load("cloud")).rejects.toThrow("baseline unavailable");
    expect(io.state.local).toEqual([project()]);
    expect(io.state.baseline.cloud).toBeUndefined();
    io.state.baselineFailure = false;
    expect(await io.service.load("cloud")).toEqual(project());
    expect(io.state.baseline.cloud.revision).toBe(7);
});

test("concurrent same-project loads share one request and initialize the engine only once", async () => {
    const io = harness();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    io.state.beforeBaselineRead = async () => { entered.resolve(); await gate.promise; };
    const hydrate = io.service.hydrate([]);
    await entered.promise;
    const first = io.service.load("cloud"), second = io.service.load("cloud");
    gate.resolve();
    await hydrate;
    expect(await first).toEqual(project());
    expect(await second).toEqual(project());
    expect(io.state.baselineReads).toBe(1);
    expect(io.state.gets).toEqual(["cloud"]);
});

test("owner switch during hydration storage cannot publish stale status or queue old-owner retries", async () => {
    const original = project(); const io = harness([envelope({ ...original, title: "远端新版" }, 8)], [original], known(original));
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    io.state.beforeWrite = async () => { entered.resolve(); await gate.promise; };
    const pending = io.service.hydrate([original]);
    await entered.promise;
    io.state.valid = false;
    const statuses = [...io.state.statuses];
    gate.resolve(); await pending;
    expect(io.state.statuses).toEqual(statuses);
    expect(io.state.copies).toEqual([]);
    expect(io.timers.size).toBe(0);
    expect(io.state.writes.every(key => key === name)).toBe(true);
});

test("owner switch during conflict-copy storage cannot republish old-owner content", async () => {
    const original = project(); const edited = { ...original, title: "本地新版" };
    const io = harness([envelope({ ...original, title: "远端冲突" }, 8)], [edited], known(original));
    await io.service.hydrate([edited]);
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    io.state.beforeWrite = async () => { entered.resolve(); await gate.promise; };
    const pending = io.service.flush();
    await entered.promise;
    io.state.valid = false;
    gate.resolve(); await pending;
    expect(io.state.copies).toEqual([]);
    expect(io.timers.size).toBe(0);
    expect(io.remote.get(original.id)!.document!.title).toBe("远端冲突");
});

test("store singleflight open then rename and delete operates on the complete graph and consumes summaries", async () => {
    const io = harness(); const tab = await openStore(io);
    expect(tab.store.getState().projects).toEqual([]);
    expect(tab.store.getState().unloadedProjects).toHaveLength(1);
    const first = tab.loadCanvasProject("cloud"), second = tab.loadCanvasProject("cloud");
    expect(first).toBe(second);
    const loaded = await first;
    expect(loaded).toEqual(project());
    expect(tab.store.getState().unloadedProjects).toEqual([]);
    expect(io.state.gets).toEqual(["cloud"]);
    tab.store.getState().renameProject("cloud", "打开后改名");
    await tab.flushCanvasCloudPersistence();
    expect(io.remote.get("cloud")!.document!.title).toBe("打开后改名");
    expect(io.remote.get("cloud")!.document!.nodes).toEqual(project().nodes);
    tab.store.getState().deleteProjects(["cloud"]);
    await tab.flushCanvasCloudPersistence();
    expect(io.remote.get("cloud")!.deleted).toBe(true);
    expect(tab.store.getState().projects).toEqual([]);
    expect(tab.store.getState().unloadedProjects).toEqual([]);
});

test("an in-flight store load cannot repopulate the editor after employee identity changes", async () => {
    const io = harness(); const tab = await openStore(io);
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    io.state.beforeGet = async () => { entered.resolve(); await gate.promise; };
    const pending = tab.loadCanvasProject("cloud");
    await entered.promise;
    tab.userStore.setState({ user: { id: "employee-b", role: "designer" } });
    gate.resolve();
    await expect(pending).rejects.toThrow("账号已切换");
    expect(tab.store.getState().projects).toEqual([]);
    expect(tab.store.getState().unloadedProjects).toEqual([]);
    expect(tab.store.getState().hydrated).toBe(false);
    expect(io.state.local).toEqual([]);
    await tab.flushCanvasPersistence();
});

test("a remote deletion during deferred opening removes its summary without inventing an empty graph", async () => {
    const io = harness(); const tab = await openStore(io);
    io.remote.set("cloud", envelope(null, 8));
    expect(await tab.loadCanvasProject("cloud")).toBeNull();
    expect(tab.store.getState().projects).toEqual([]);
    expect(tab.store.getState().unloadedProjects).toEqual([]);
    expect(io.state.local).toEqual([]);
    expect(io.state.puts).toEqual([]);
});

test("a cached store project with a deferred summary still confirms its cloud revision before editing", async () => {
    const io = harness(); const tab = await openStore(io);
    const cached = project();
    io.state.local = [clone(cached)];
    tab.store.getState().replaceProjects([cached]);
    await tab.flushCanvasPersistence();
    expect(await tab.loadCanvasProject("cloud")).toBe(cached);
    expect(tab.store.getState().unloadedProjects).toEqual([]);
    expect(io.state.baseline.cloud.revision).toBe(7);
    tab.store.getState().renameProject("cloud", "缓存打开后改名");
    await tab.flushCanvasCloudPersistence();
    expect(io.state.puts).toHaveLength(1);
    expect(io.state.puts[0].revision).toBe(7);
    expect(io.remote.get("cloud")!.document!.nodes).toEqual(cached.nodes);
});

test("a pending remote load does not overwrite a project made editable by a concurrent local action", async () => {
    const io = harness(); const tab = await openStore(io);
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    io.state.beforeGet = async () => { entered.resolve(); await gate.promise; };
    const pending = tab.loadCanvasProject("cloud");
    await entered.promise;
    const edited = { ...project(), title: "请求期间的本机编辑" };
    tab.store.getState().replaceProjects([edited]);
    gate.resolve();
    expect(await pending).toBe(edited);
    expect(tab.store.getState().openProject("cloud")).toBe(edited);
    expect(tab.store.getState().unloadedProjects).toEqual([]);
});

test("cached data can never bypass the owner guard after employee identity changes", async () => {
    const io = harness(); const tab = await openStore(io);
    await tab.loadCanvasProject("cloud");
    tab.userStore.setState({ user: { id: "employee-b", role: "designer" } });
    // A stale caller still holding the old store cannot make its cached data
    // available through the public loader after the ownership boundary closed.
    tab.store.getState().replaceProjects([project()]);
    await expect(tab.loadCanvasProject("cloud")).rejects.toThrow("账号已切换");
    await tab.flushCanvasPersistence();
});
