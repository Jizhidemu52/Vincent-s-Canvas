import localforage from "localforage";
import { nanoid } from "nanoid";
import { getCloudCanvas, listCloudCanvases, putCloudCanvas } from "./api/canvas-documents";
import { makeCloudCanvas } from "./canvas-cloud-media";
import { createCanvasCloudSync, type CanvasCloudBaseline } from "@/lib/canvas/canvas-cloud-sync";
import { collectProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import { writeCanvasProjects, readCanvasProjects } from "@/lib/canvas/canvas-project-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { runLocalForageStorage } from "@/lib/localforage-storage";

export type CloudSaveState = "local" | "loading" | "pending" | "syncing" | "synced" | "error" | "local-error";
export function createCloudCanvasPersistence(owner: string, name: string, hooks: {
    valid: () => boolean;
    status: (status: CloudSaveState, error?: string) => void;
    copy: (project: CanvasProject) => void;
    unloaded: (projects: CanvasProjectSummary[]) => void;
}) {
    let engine: ReturnType<typeof createCanvasCloudSync> | undefined;
    let initializing: Promise<ReturnType<typeof createCanvasCloudSync>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chain = Promise.resolve();
    const loading = new Map<string, Promise<CanvasProject | null>>();
    let dirty = false;
    let pulled = false;
    const baselineKey = `${name}:cloud-baseline:v1`;
    const assertOwner = () => { if (!hooks.valid()) throw new Error("账号已切换，请重新打开画布"); };
    function enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const pending = chain.catch(() => undefined).then(operation);
        chain = pending.then(() => undefined, () => undefined);
        return pending;
    }
    function initialize() {
        assertOwner();
        if (engine) return Promise.resolve(engine);
        if (initializing) return initializing;
        initializing = (async () => {
            const baseline = await runLocalForageStorage(() => localforage.getItem<CanvasCloudBaseline>(baselineKey)) || {};
            assertOwner();
            engine = createCanvasCloudSync(baseline, {
                list: async () => { assertOwner(); const result = await listCloudCanvases(owner); assertOwner(); return result.documents; },
                get: async id => { assertOwner(); const result = await getCloudCanvas(owner, id); assertOwner(); return result; },
                put: async (id, revision, document) => { assertOwner(); const result = await putCloudCanvas(owner, id, revision, document); assertOwner(); return result; },
                portable: async project => { assertOwner(); const result = await makeCloudCanvas(owner, project); assertOwner(); return result; },
                saveBaseline: async value => { assertOwner(); await runLocalForageStorage(() => localforage.setItem(baselineKey, value)); assertOwner(); },
                newId: nanoid,
                onCopy: async copy => {
                    assertOwner();
                    const before = await readCanvasProjects(name);
                    assertOwner();
                    await writeCanvasProjects(name, collectProjectChanges(before, [copy, ...before.filter(project => project.id !== copy.id)]));
                    assertOwner();
                    hooks.copy(copy);
                },
            });
            return engine;
        })().finally(() => { initializing = undefined; });
        return initializing;
    }
    function schedule(delay = 1200) {
        if (!hooks.valid()) return;
        dirty = true;
        hooks.status("pending");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
    }
    async function flush() {
        if (timer) clearTimeout(timer);
        timer = undefined;
        return enqueue(async () => {
            if (!dirty || !hooks.valid()) return;
            dirty = false;
            hooks.status("syncing");
            try {
                const sync = await initialize();
                if (!pulled) {
                    const before = await readCanvasProjects(name);
                    const restored = await sync.hydrate(before, { live: true, deferUncached: true });
                    assertOwner();
                    await writeCanvasProjects(name, collectProjectChanges(before, restored));
                    await sync.confirmHydrated(await readCanvasProjects(name));
                    assertOwner();
                    hooks.unloaded(sync.deferredProjects());
                    const existing = new Set(before.map(project => project.id));
                    for (const project of restored) if (!existing.has(project.id)) hooks.copy(project);
                    pulled = true;
                }
                await sync.save(await readCanvasProjects(name));
                if (hooks.valid()) hooks.status(dirty ? "pending" : "synced");
            } catch (error) {
                dirty = true;
                if (hooks.valid()) {
                    hooks.status("error", error instanceof Error ? error.message : "同步失败");
                    if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 15000);
                }
            }
        });
    }
    if (typeof window !== "undefined") {
        window.addEventListener("online", () => { if (dirty) void flush(); });
        window.addEventListener("pagehide", () => { if (dirty) void flush(); });
    }
    return {
        hydrate(local: CanvasProject[]) {
            return enqueue(async () => {
                if (!hooks.valid()) return local;
                hooks.status("loading");
                let durable = local;
                try {
                    const sync = await initialize();
                    const projects = await sync.hydrate(local, { deferUncached: true });
                    assertOwner();
                    await writeCanvasProjects(name, collectProjectChanges(local, projects));
                    durable = await readCanvasProjects(name);
                    assertOwner();
                    await sync.confirmHydrated(durable);
                    assertOwner();
                    hooks.unloaded(sync.deferredProjects());
                    pulled = true;
                    schedule();
                    return durable;
                } catch (error) {
                    // Keep the durable local outbox. Cached revisions prevent a later retry from clobbering remote edits.
                    dirty = true;
                    if (hooks.valid()) {
                        hooks.status("error", error instanceof Error ? error.message : "云端读取失败");
                        if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 15000);
                    }
                    return durable;
                }
            });
        },
        load(id: string): Promise<CanvasProject | null> {
            const existingLoad = loading.get(id);
            if (existingLoad) return existingLoad;
            // Loading and autosave share one queue: an unopened cloud document
            // can never be interpreted as a local deletion by a concurrent save.
            const operation = enqueue(async () => {
                assertOwner();
                const sync = await initialize();
                const before = await readCanvasProjects(name);
                assertOwner();
                const existing = before.find(project => project.id === id);
                const project = !existing || sync.deferredProjects().some(item => item.id === id) ? await sync.load(id, existing) : existing;
                assertOwner();
                if (project && !existing) await writeCanvasProjects(name, collectProjectChanges(before, [project, ...before]));
                const durable = await readCanvasProjects(name);
                assertOwner();
                await sync.confirmHydrated(durable);
                assertOwner();
                hooks.unloaded(sync.deferredProjects());
                return durable.find(item => item.id === id) || null;
            }).finally(() => loading.delete(id));
            loading.set(id, operation);
            return operation;
        },
        schedule,
        flush,
    };
}
