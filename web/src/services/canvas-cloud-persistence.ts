import localforage from "localforage";
import { nanoid } from "nanoid";
import { getCloudCanvas, listCloudCanvases, putCloudCanvas, CanvasCloudRequestError } from "./api/canvas-documents";
import { makeCloudCanvas } from "./canvas-cloud-media";
import { createCanvasCloudSync, CanvasCloudBatchError, canvasMediaSignature, type CanvasCloudBaseline } from "@/lib/canvas/canvas-cloud-sync";
import { isCanvasStorageQuotaError } from "@/lib/canvas/canvas-storage-capacity";
import { collectProjectChanges } from "@/lib/canvas/canvas-persistence-merge";
import { writeCanvasProjects, readCanvasProjects, readCanvasProject } from "@/lib/canvas/canvas-project-storage";
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
    let scheduledAt = 0;
    let chain = Promise.resolve();
    const loading = new Map<string, Promise<CanvasProject | null>>();
    let dirty = false;
    let pulled = false;
    let fullSave = false;
    let failures = 0;
    const outbox = new Map<string, CanvasProject | null>();
    const blocked = new Map<string, { signature?: string; message: string }>();
    const blockedMessage = () => [...blocked.values()].map(item => item.message).join("\n");
    const retryable = (value: unknown): boolean => value instanceof CanvasCloudRequestError ? value.retryable
        : value instanceof CanvasCloudBatchError ? value.failures.some(item => retryable(item.error)) : true;
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
                portable: async (project, rejected) => { assertOwner(); const result = await makeCloudCanvas(owner, project, rejected); assertOwner(); return result; },
                saveBaseline: async value => {
                    assertOwner();
                    try { await runLocalForageStorage(() => localforage.setItem(baselineKey, value)); }
                    catch (error) { if (!isCanvasStorageQuotaError(error)) throw error; }
                    assertOwner();
                },
                newId: nanoid,
                onCopy: async copy => {
                    assertOwner();
                    const existing = await readCanvasProject(name, copy.id);
                    const before = existing ? [existing] : [];
                    assertOwner();
                    try { await writeCanvasProjects(name, collectProjectChanges(before, [copy, ...before.filter(project => project.id !== copy.id)])); }
                    catch (error) { if (!isCanvasStorageQuotaError(error)) throw error; }
                    assertOwner();
                    hooks.copy(copy);
                },
            });
            return engine;
        })().finally(() => { initializing = undefined; });
        return initializing;
    }
    function schedule(delay = 1200, changes?: ReadonlyMap<string, CanvasProject | null>) {
        if (!hooks.valid()) return;
        if (changes) for (const [id, project] of changes) {
            outbox.set(id, project);
            if (blocked.get(id)?.signature === undefined) blocked.delete(id);
        }
        else fullSave = true;
        dirty = true;
        hooks.status("pending");
        wakeAfter(delay);
    }
    function wakeAfter(delay: number) {
        const next = Date.now() + delay;
        if (timer && scheduledAt <= next) return;
        if (timer) clearTimeout(timer);
        scheduledAt = next;
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
                if (!pulled && !outbox.size) {
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
                const batch = new Map(outbox);
                const saveAll = fullSave;
                fullSave = false;
                const attempted = new Map<string, CanvasProject>();
                try {
                    const projects = saveAll ? await readCanvasProjects(name) : [];
                    for (const project of projects) attempted.set(project.id, project);
                    for (const [id, project] of batch) { if (project) attempted.set(id, project); else attempted.delete(id); }
                    const changedIds = saveAll ? new Set([...attempted.keys(), ...batch.keys(), ...sync.pendingDeleteIds()]) : batch.keys();
                    for (const [id, failure] of blocked) {
                        if (!saveAll && !batch.has(id)) continue;
                        const project = attempted.get(id);
                        if (!project || (failure.signature !== undefined && failure.signature !== canvasMediaSignature(project))) blocked.delete(id);
                    }
                    await sync.save([...attempted.values()], changedIds, new Set(blocked.keys()));
                    for (const [id, value] of batch) if (!blocked.has(id) && outbox.get(id) === value) outbox.delete(id);
                } catch (error) {
                    if (error instanceof CanvasCloudBatchError) {
                        const failedIds = new Set(error.failures.map(item => item.id));
                        for (const { id, error: cause } of error.failures) if (!retryable(cause)) {
                            const project = attempted.get(id);
                            const signature = cause instanceof CanvasCloudRequestError && cause.code === "CANVAS_ASSET_FORBIDDEN" ? canvasMediaSignature(project ?? null) : undefined;
                            blocked.set(id, { signature, message: `《${project?.title || id}》${cause instanceof Error ? cause.message : "同步失败"}` });
                        }
                        for (const [id, value] of batch) if (!blocked.has(id) && !failedIds.has(id) && outbox.get(id) === value) outbox.delete(id);
                    }
                    fullSave ||= saveAll;
                    throw error;
                }
                failures = 0;
                if (!pulled && !outbox.size) {
                    dirty = true;
                    fullSave = true;
                    wakeAfter(0);
                }
                if (blocked.size) dirty = true;
                if (hooks.valid()) hooks.status(blocked.size ? "error" : dirty ? "pending" : "synced", blocked.size ? blockedMessage() : undefined);
            } catch (error) {
                dirty = true;
                if (hooks.valid()) {
                    hooks.status("error", blocked.size && !retryable(error) ? blockedMessage() : error instanceof Error ? error.message : "同步失败");
                    failures++;
                    if (retryable(error)) wakeAfter(Math.min(120000, 15000 * 2 ** Math.min(failures - 1, 3)));
                }
            }
        });
    }
    if (typeof window !== "undefined") {
        window.addEventListener("online", () => { if (dirty) void flush(); });
        window.addEventListener("pagehide", () => { if (dirty) void flush(); });
    }
    return {
        hydrate(local: CanvasProject[], live = false) {
            return enqueue(async () => {
                if (!hooks.valid()) return local;
                hooks.status("loading");
                let durable = local;
                try {
                    const sync = await initialize();
                    const projects = await sync.hydrate(local, { deferUncached: true, live });
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
                        wakeAfter(15000);
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
                const cached = await readCanvasProject(name, id);
                const before = cached ? [cached] : [];
                assertOwner();
                const existing = before.find(project => project.id === id);
                const project = !existing || sync.deferredProjects().some(item => item.id === id) ? await sync.load(id, existing) : existing;
                assertOwner();
                if (project && !existing) await writeCanvasProjects(name, collectProjectChanges(before, [project, ...before]));
                const saved = await readCanvasProject(name, id);
                const durable = saved ? [saved] : [];
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
        retry() { blocked.clear(); schedule(0); },
        flush,
        async confirmImageTask(projectId: string, nodeId: string, requestId: string) {
            await flush();
            assertOwner();
            return (await initialize()).hasSavedImageTask(projectId, nodeId, requestId, owner);
        },
        refresh(project: CanvasProject) {
            return enqueue(async () => {
                assertOwner();
                const sync = await initialize();
                const latest = await sync.refreshCached(project);
                assertOwner();
                if (latest === project) return project;
                await writeCanvasProjects(name, collectProjectChanges([project], [latest]));
                const saved = await readCanvasProject(name, project.id);
                assertOwner();
                await sync.confirmHydrated(saved ? [saved] : []);
                return saved || project;
            });
        },
        async synchronizedProjectIds(projects: CanvasProject[]) {
            assertOwner();
            const sync = await initialize();
            return sync.synchronizedProjectIds(projects);
        },
    };
}
