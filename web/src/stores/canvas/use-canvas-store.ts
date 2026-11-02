import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { collectProjectChanges, createProjectChangeBuffer, type CanvasPersistenceConflict, type ProjectChange } from "@/lib/canvas/canvas-persistence-merge";
import { readCanvasProjects, readCanvasProject, readCanvasLibrary, writeCanvasProjects, removeCanvasProjects } from "@/lib/canvas/canvas-project-storage";
import { applyCanvasProjectPatch, hasCanvasContentChange, type CanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import { isCanvasStorageQuotaError, requestCanvasPersistentStorage } from "@/lib/canvas/canvas-storage-capacity";
import { normalizeCanvasSelectedNodeIds } from "@/lib/canvas/canvas-view-state";
import { clearImportedCanvasTasks } from "@/lib/canvas/canvas-import-task-state";
import { canvasDuplicateTitle } from "@/lib/canvas/canvas-library-ux";
import { deploymentFeatures } from "@/lib/deployment-features";
import { getWorkspaceIdentityDrainStatus, registerWorkspaceIdentityDrain, startWorkspaceIdentityDrain } from "@/lib/workspace-identity-drain";
import { createCloudCanvasPersistence, type CloudSaveState } from "@/services/canvas-cloud-persistence";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasNodeGroup, ViewportTransform } from "@/types/canvas";
import type { CanvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { isWorkspaceRole } from "../../../../shared/workspace-access";

export type CanvasProject = {
    id: string;
    title: string;
    coverNodeId?: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    groups?: CanvasNodeGroup[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    selectedNodeIds?: string[];
    history?: { past: CanvasHistorySnapshot[]; future: CanvasHistorySnapshot[] };
    persistenceConflict?: CanvasPersistenceConflict;
};
export type CanvasHistorySnapshot = Pick<CanvasProject, "nodes" | "groups" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "selectedNodeIds">;

type CanvasStore = {
    hydrated: boolean;
    cloudStatus: CloudSaveState;
    cloudError: string;
    localSaveFailureCount: number;
    localSaveFailureId: number;
    projects: CanvasProject[];
    unloadedProjects: CanvasProjectSummary[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    duplicateProject: (id: string) => string | null;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: CanvasProjectPatch) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const initialSession = useUserStore.getState();
const canvasOwnerId = deploymentFeatures.authenticationEnabled && initialSession.status === "authenticated" && initialSession.user && isWorkspaceRole(initialSession.user.role) ? initialSession.user.id : null;
const canvasOwnerRole = initialSession.user?.role;
const CANVAS_STORE_KEY = deploymentFeatures.authenticationEnabled
    ? `wireless-canvas:canvas_store:oa:user:${encodeURIComponent(canvasOwnerId || "")}`
    : "wireless-canvas:canvas_store";
let canvasOwnerValid = !deploymentFeatures.authenticationEnabled || (Boolean(canvasOwnerId) && getWorkspaceIdentityDrainStatus() === "idle");
let localUnloadedProjects: CanvasProjectSummary[] = [];
const isCanvasOwnerValid = () => canvasOwnerValid && (!canvasOwnerId || (useUserStore.getState().status === "authenticated" && useUserStore.getState().user?.id === canvasOwnerId && isWorkspaceRole(useUserStore.getState().user?.role)));
const cloudPersistence = canvasOwnerId ? createCloudCanvasPersistence(canvasOwnerId, CANVAS_STORE_KEY, {
    valid: isCanvasOwnerValid,
    status: (cloudStatus, cloudError = "") => {
        if (!isCanvasOwnerValid()) return;
        if (!lastPersistError) useCanvasStore.setState({ cloudStatus, cloudError });
        else if (cloudStatus === "synced") useCanvasStore.setState({ cloudStatus: "local-error", cloudError: "本机存储仍不可用，但本次改动已保存至服务器。建议导出备份后处理浏览器存储。" });
        else if (cloudStatus === "error") useCanvasStore.setState({ cloudStatus: "local-error", cloudError: `本机和云端保存均未成功，请保持页面并导出备份。云端：${cloudError}` });
    },
    copy: (copy) => { if (isCanvasOwnerValid()) useCanvasStore.setState(state => ({ projects: [copy, ...state.projects.filter(project => project.id !== copy.id)], unloadedProjects: state.unloadedProjects.filter(project => project.id !== copy.id) })); },
    unloaded: (unloadedProjects) => {
        if (!isCanvasOwnerValid()) return;
        const current = useCanvasStore.getState();
        const loaded = new Set(current.projects.map(project => project.id));
        // Keep the summary mounted until loadCanvasProject atomically swaps in
        // its durable document. Dropping it here loses card-local dialog state.
        const transitioning = current.unloadedProjects.filter(project => loadingProjects.has(project.id));
        const combined = new Map([...localUnloadedProjects, ...transitioning, ...unloadedProjects].map(project => [project.id, project]));
        useCanvasStore.setState({ unloadedProjects: [...combined.values()].filter(project => !loaded.has(project.id)) });
    },
}) : null;
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let queuedPersistState: PersistedCanvasState | null = null;
const pendingProjectChanges = new Map<string, ProjectChange<CanvasProject>>();
const projectWriteBuffer = createProjectChangeBuffer<CanvasProject>();
type PersistWrite = { name: string; value: StorageValue<CanvasStore>; changes: Map<string, ProjectChange<CanvasProject>> };
let persistWriteChain: Promise<void> = Promise.resolve();
let lastPersistError: unknown = null;
let pendingPersistWrites = 0;
let consecutivePersistFailures = 0;
let persistFailureSequence = 0;
let persistRetryTimer: ReturnType<typeof setTimeout> | null = null;
function clearPersistRetry() {
    if (persistRetryTimer !== null) clearTimeout(persistRetryTimer);
    persistRetryTimer = null;
}
const persistQueue = createDeferredPersistQueue<PersistWrite>(400, ({ name, changes }) => {
    const cloudChanges = new Map<string, CanvasProject | null>();
    clearPersistRetry();
    pendingProjectChanges.clear();
    // Mark the write before the Promise callback starts: a flushed debounce is
    // not durable until its IndexedDB transaction has actually completed.
    pendingPersistWrites += 1;
    // IndexedDB writes are asynchronous. Keep their order stable so a slow
    // older snapshot can never finish after and overwrite a newer edit.
    persistWriteChain = persistWriteChain
        .catch(() => undefined)
        .then(() => projectWriteBuffer.write(changes, async retainedChanges => {
            for (const [id, change] of retainedChanges) if (hasCanvasContentChange(change.base, change.value)) cloudChanges.set(id, change.value);
            let writtenProjects: CanvasProject[];
            try { writtenProjects = await writeCanvasProjects(name, retainedChanges); }
            catch (error) {
                // Cloud is an independent durability path. A full local disk must
                // not prevent an already-created in-memory work from being saved.
                if (isCanvasOwnerValid() && cloudChanges.size) cloudPersistence?.schedule(0, cloudChanges);
                throw error;
            }
            for (const project of writtenProjects) if (cloudChanges.has(project.id) || project.persistenceConflict) cloudChanges.set(project.id, project);
            // The editor owns a separate graph snapshot. Do not rebase its live
            // project behind its back: its next save would look like deletions.
            // Newly saved conflict copies can safely appear in the project list.
            const localProjects = useCanvasStore.getState().projects;
            const localIds = new Set(localProjects.map(project => project.id));
            const copies = writtenProjects.filter(project => project.persistenceConflict && !localIds.has(project.id));
            if (canvasOwnerValid && copies.length) {
                const projects = [...copies, ...localProjects];
                queuedPersistState = { projects };
                useCanvasStore.setState({ projects });
            }
        }))
        .then(() => {
            lastPersistError = null;
            consecutivePersistFailures = 0;
            clearPersistRetry();
            if (canvasOwnerValid) {
                useCanvasStore.setState({ localSaveFailureCount: 0, localSaveFailureId: 0 });
                if (cloudPersistence && cloudChanges.size) cloudPersistence.schedule(1200, cloudChanges);
                else if (!cloudPersistence) useCanvasStore.setState({ cloudStatus: "local", cloudError: "" });
            }
        })
        .catch(error => {
            lastPersistError = error;
            if (isCanvasOwnerValid()) {
                consecutivePersistFailures += 1;
                useCanvasStore.setState(state => ({
                    cloudStatus: "local-error", cloudError: `${isCanvasStorageQuotaError(error) ? "浏览器存储空间不足" : "画布写入本机失败"}，${cloudPersistence ? "正在独立尝试云端保存；请勿关闭页面，并导出备份。" : "请勿关闭页面，请导出备份后清理浏览器存储。"}`,
                    localSaveFailureCount: consecutivePersistFailures,
                    localSaveFailureId: consecutivePersistFailures === 2 ? ++persistFailureSequence : state.localSaveFailureId,
                }));
                // Confirm a transient failure once, even if editing stops. The
                // retained mutation buffer is reused; persistent failures never loop.
                if (consecutivePersistFailures === 1) persistRetryTimer = setTimeout(() => {
                    persistRetryTimer = null;
                    if (isCanvasOwnerValid() && lastPersistError) void flushCanvasCloudPersistence().catch(() => undefined);
                }, 1000);
            }
            console.error("画布自动保存失败，改动将随下次编辑重试；请先导出重要作品。", error);
        })
        .finally(() => { pendingPersistWrites -= 1; });
});

/** Includes scheduled changes, queued/in-flight writes and a failed write. */
export function hasPendingCanvasPersistence() {
    return isCanvasOwnerValid() && (pendingProjectChanges.size > 0 || pendingPersistWrites > 0 || Boolean(lastPersistError));
}

/** Explicit save actions wait for the same ordered queue used by autosave. */
export async function flushCanvasPersistence() {
    persistQueue.flush();
    await persistWriteChain;
    if (lastPersistError) throw new Error("画布写入本机失败，请保留编辑面板并重试保存");
}

export async function flushCanvasCloudPersistence() {
    if (canvasOwnerValid && lastPersistError) persistQueue.schedule({ name: CANVAS_STORE_KEY, value: { state: useCanvasStore.getState(), version: 0 }, changes: new Map(pendingProjectChanges) });
    await flushCanvasPersistence();
    cloudPersistence?.schedule(0);
    await cloudPersistence?.flush();
}

const loadingProjects = new Map<string, Promise<CanvasProject | null>>();
/** Call only while acquiring the exclusive editor lock, before allowing edits. */
export async function reloadCanvasProject(id: string): Promise<CanvasProject | null> {
    if (!isCanvasOwnerValid()) throw new Error("账号已切换，请重新打开画布");
    const project = await readCanvasProject(CANVAS_STORE_KEY, id);
    if (!isCanvasOwnerValid()) throw new Error("账号已切换，请重新打开画布");
    if (!project) return null;
    // An offline cloud checkpoint cannot erase the latest shared local graph.
    // If it differs from remote, ordinary CAS preserves both versions on save.
    await cloudPersistence?.refresh(project).catch(() => undefined);
    if (!isCanvasOwnerValid()) throw new Error("账号已切换，请重新打开画布");
    const state = useCanvasStore.getState();
    const projects = [project, ...state.projects.filter(item => item.id !== id)];
    queuedPersistState = { projects };
    localUnloadedProjects = localUnloadedProjects.filter(item => item.id !== id);
    useCanvasStore.setState({ projects, unloadedProjects: state.unloadedProjects.filter(item => item.id !== id) });
    return project;
}
export async function canvasCacheMaintenanceContext() {
    if (!cloudPersistence || !canvasOwnerId || !isCanvasOwnerValid()) throw new Error("仅员工云同步模式可清理已验证缓存，本地试用原件不会清理。");
    persistQueue.flush();
    await persistWriteChain;
    await cloudPersistence.flush();
    const durable = await readCanvasProjects(CANVAS_STORE_KEY);
    if (!isCanvasOwnerValid()) throw new Error("账号已变化，已停止缓存清理");
    const live = useCanvasStore.getState().projects;
    const merged = new Map(durable.map(project => [project.id, project]));
    for (const project of live) merged.set(project.id, project);
    const projects = [...merged.values()];
    const synchronized = new Set(await cloudPersistence.synchronizedProjectIds(projects));
    return { ownerId: canvasOwnerId, projects, synchronized, isCurrent: () => isCanvasOwnerValid() && useCanvasStore.getState().projects === live && pendingProjectChanges.size === 0 && pendingPersistWrites === 0 };
}
export function loadCanvasProject(id: string): Promise<CanvasProject | null> {
    if (!isCanvasOwnerValid()) return Promise.reject(new Error("账号已切换，请重新打开画布"));
    const state = useCanvasStore.getState();
    const current = state.openProject(id);
    if (current && !state.unloadedProjects.some(project => project.id === id)) return Promise.resolve(current);
    const loading = loadingProjects.get(id);
    if (loading) return loading;
    const pending = (cloudPersistence ? cloudPersistence.load(id) : readCanvasProject(CANVAS_STORE_KEY, id)).then(project => {
        if (!isCanvasOwnerValid()) throw new Error("账号已切换，请重新打开画布");
        const latest = useCanvasStore.getState();
        const existing = latest.openProject(id);
        // A concurrent local/import action may have made this project editable
        // while its remote request was pending. Never replace those live edits.
        const projects = existing || !project ? latest.projects : [project, ...latest.projects];
        localUnloadedProjects = localUnloadedProjects.filter(item => item.id !== id);
        // The cloud loader has already committed these bytes and its revision.
        if (projects !== latest.projects) queuedPersistState = { projects };
        useCanvasStore.setState({ projects, unloadedProjects: latest.unloadedProjects.filter(item => item.id !== id) });
        return existing || project;
    }).finally(() => loadingProjects.delete(id));
    loadingProjects.set(id, pending);
    return pending;
}

if (typeof window !== "undefined") {
    void requestCanvasPersistentStorage().then(ratio => {
        if (ratio !== undefined && ratio >= 0.8 && canvasOwnerValid) useCanvasStore.setState({ cloudError: "浏览器存储已使用超过 80%，请及时导出备份；不要清除尚未同步的原图。" });
    });
    const flushCanvasPersistence = () => persistQueue.flush();
    window.addEventListener("pagehide", flushCanvasPersistence);
    window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushCanvasPersistence();
    });
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        if (!isCanvasOwnerValid()) return null;
        const library = await readCanvasLibrary(name);
        const local = library.projects;
        localUnloadedProjects = library.summaries;
        if (isCanvasOwnerValid() && library.summaries.length) useCanvasStore.setState({ unloadedProjects: library.summaries });
        let projects = local;
        if (isCanvasOwnerValid() && cloudPersistence) {
            if (local.length || library.summaries.length) {
                // Cached canvases become usable before any remote list/detail request.
                // Reconciliation keeps a live editor untouched and still saves the
                // durable offline outbox in the background.
                setTimeout(() => { void readCanvasProjects(name).then(all => cloudPersistence.hydrate(all, true)).catch(() => undefined); }, 0);
            } else projects = await cloudPersistence.hydrate(local);
        }
        const parsed = { version: 0, state: { projects: isCanvasOwnerValid() ? projects : [] } } as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        if (typeof window === "undefined" || !canvasOwnerValid) return;
        if (!useCanvasStore.getState().hydrated) return;
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        collectProjectChanges(queuedPersistState?.projects || [], nextState.projects, pendingProjectChanges);
        queuedPersistState = nextState;
        persistQueue.schedule({ name, value, changes: new Map(pendingProjectChanges) });
    },
    removeItem: (name) => {
        if (!isCanvasOwnerValid()) return;
        persistQueue.clear();
        pendingProjectChanges.clear();
        pendingPersistWrites += 1;
        persistWriteChain = persistWriteChain
            .catch(() => undefined)
            .then(async () => {
                await removeCanvasProjects(name);
                projectWriteBuffer.clear();
            })
            .then(() => { lastPersistError = null; })
            .catch(error => { lastPersistError = error; throw error; })
            .finally(() => { pendingPersistWrites -= 1; });
        return persistWriteChain;
    },
};

export const useCanvasStore = create<CanvasStore>()(
    persist<CanvasStore>(
        (set, get) => ({
            hydrated: false,
            cloudStatus: cloudPersistence ? "loading" : "local",
            cloudError: "",
            localSaveFailureCount: 0,
            localSaveFailureId: 0,
            projects: [],
            unloadedProjects: [],
            createProject: (title = "未命名画布") => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "dots",
                    showImageInfo: false,
                    viewport: initialViewport,
                    selectedNodeIds: [],
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    ...(source.coverNodeId ? { coverNodeId: source.coverNodeId } : {}),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: clearImportedCanvasTasks(source.nodes || []),
                    ...(source.groups ? { groups: source.groups } : {}),
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "dots",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    selectedNodeIds: normalizeCanvasSelectedNodeIds(source.selectedNodeIds, source.nodes || [], source.groups),
                    ...(source.history ? { history: {
                        past: source.history.past.map(entry => ({ ...entry, nodes: clearImportedCanvasTasks(entry.nodes) })),
                        future: source.history.future.map(entry => ({ ...entry, nodes: clearImportedCanvasTasks(entry.nodes) })),
                    } } : {}),
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id && title.trim() && title.trim() !== project.title ? { ...project, title: title.trim() } : project)),
                })),
            duplicateProject: (id) => {
                const state = get();
                const source = state.openProject(id);
                if (!source) return null;
                return state.importProject({ ...structuredClone(source), title: canvasDuplicateTitle(source.title, [...state.projects, ...state.unloadedProjects]), createdAt: new Date().toISOString() });
            },
            deleteProjects: (ids) =>
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                }),
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) =>
                set((state) => {
                    const index = state.projects.findIndex((project) => project.id === id);
                    if (index < 0) return state;
                    const updated = applyCanvasProjectPatch(state.projects[index], patch);
                    if (updated === state.projects[index]) return state;
                    const projects = state.projects.slice();
                    projects[index] = updated;
                    return { projects };
                }),
        }),
        {
            name: CANVAS_STORE_KEY,
            skipHydration: !canvasOwnerValid,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: canvasOwnerValid });
            },
        },
    ),
);

if (deploymentFeatures.authenticationEnabled && canvasOwnerId) {
    let drainingForOwner = false;
    registerWorkspaceIdentityDrain(() => {
        // Never reuse the old editor, retries or immutable storage key for a
        // new employee. Only the user may reload after this local drain settles.
        drainingForOwner = true;
        canvasOwnerValid = false;
        clearPersistRetry();
        consecutivePersistFailures = 0;
        persistQueue.flush();
        useCanvasStore.setState({ projects: [], unloadedProjects: [], hydrated: false, localSaveFailureCount: 0, localSaveFailureId: 0 });
        useUserStore.setState({ user: null, status: "loading" });
        return flushCanvasPersistence();
    });
    useUserStore.subscribe((state) => {
        // Same-owner expiry keeps mounted drafts; API/storage writes still require reauthentication.
        if (drainingForOwner || ((state.status === "authenticated" || state.status === "expired") && state.user?.id === canvasOwnerId && state.user.role === canvasOwnerRole && isWorkspaceRole(state.user.role))) return;
        startWorkspaceIdentityDrain();
    });
}
