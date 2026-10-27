import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { collectProjectChanges, createProjectChangeBuffer, type CanvasPersistenceConflict, type ProjectChange } from "@/lib/canvas/canvas-persistence-merge";
import { readCanvasProjects, writeCanvasProjects, removeCanvasProjects } from "@/lib/canvas/canvas-project-storage";
import { applyCanvasProjectPatch, type CanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import { normalizeCanvasSelectedNodeIds } from "@/lib/canvas/canvas-view-state";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createCloudCanvasPersistence, type CloudSaveState } from "@/services/canvas-cloud-persistence";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasNodeGroup, ViewportTransform } from "@/types/canvas";
import type { CanvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { isWorkspaceRole } from "../../../../shared/workspace-access";

export type CanvasProject = {
    id: string;
    title: string;
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
export type CanvasHistorySnapshot = Pick<CanvasProject, "nodes" | "groups" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo">;

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
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: CanvasProjectPatch) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const initialSession = useUserStore.getState();
const canvasOwnerId = deploymentFeatures.authenticationEnabled && initialSession.status === "authenticated" && initialSession.user && isWorkspaceRole(initialSession.user.role) ? initialSession.user.id : null;
const CANVAS_STORE_KEY = deploymentFeatures.authenticationEnabled
    ? `wireless-canvas:canvas_store:oa:user:${encodeURIComponent(canvasOwnerId || "")}`
    : "wireless-canvas:canvas_store";
let canvasOwnerValid = !deploymentFeatures.authenticationEnabled || Boolean(canvasOwnerId);
const isCanvasOwnerValid = () => canvasOwnerValid && (!canvasOwnerId || (useUserStore.getState().status === "authenticated" && useUserStore.getState().user?.id === canvasOwnerId && isWorkspaceRole(useUserStore.getState().user?.role)));
const cloudPersistence = canvasOwnerId ? createCloudCanvasPersistence(canvasOwnerId, CANVAS_STORE_KEY, {
    valid: isCanvasOwnerValid,
    status: (cloudStatus, cloudError = "") => { if (isCanvasOwnerValid() && !lastPersistError) useCanvasStore.setState({ cloudStatus, cloudError }); },
    copy: (copy) => { if (isCanvasOwnerValid()) useCanvasStore.setState(state => ({ projects: [copy, ...state.projects.filter(project => project.id !== copy.id)], unloadedProjects: state.unloadedProjects.filter(project => project.id !== copy.id) })); },
    unloaded: (unloadedProjects) => { if (isCanvasOwnerValid()) useCanvasStore.setState({ unloadedProjects }); },
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
            const writtenProjects = await writeCanvasProjects(name, retainedChanges);
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
                if (cloudPersistence) cloudPersistence.schedule();
                else useCanvasStore.setState({ cloudStatus: "local", cloudError: "" });
            }
        })
        .catch(error => {
            lastPersistError = error;
            if (isCanvasOwnerValid()) {
                consecutivePersistFailures += 1;
                useCanvasStore.setState(state => ({
                    cloudStatus: "local-error", cloudError: "画布写入本机失败，尚未同步本次改动；请重试保存或导出备份。",
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
export function loadCanvasProject(id: string): Promise<CanvasProject | null> {
    if (!isCanvasOwnerValid()) return Promise.reject(new Error("账号已切换，请重新打开画布"));
    const state = useCanvasStore.getState();
    const current = state.openProject(id);
    if (current && !state.unloadedProjects.some(project => project.id === id)) return Promise.resolve(current);
    if (!cloudPersistence) return Promise.resolve(current);
    const loading = loadingProjects.get(id);
    if (loading) return loading;
    const pending = cloudPersistence.load(id).then(project => {
        if (!isCanvasOwnerValid()) throw new Error("账号已切换，请重新打开画布");
        const latest = useCanvasStore.getState();
        const existing = latest.openProject(id);
        // A concurrent local/import action may have made this project editable
        // while its remote request was pending. Never replace those live edits.
        const projects = existing || !project ? latest.projects : [project, ...latest.projects];
        // The cloud loader has already committed these bytes and its revision.
        if (projects !== latest.projects) queuedPersistState = { projects };
        useCanvasStore.setState({ projects, unloadedProjects: latest.unloadedProjects.filter(item => item.id !== id) });
        return existing || project;
    }).finally(() => loadingProjects.delete(id));
    loadingProjects.set(id, pending);
    return pending;
}

if (typeof window !== "undefined") {
    const flushCanvasPersistence = () => persistQueue.flush();
    window.addEventListener("pagehide", flushCanvasPersistence);
    window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushCanvasPersistence();
    });
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        if (!isCanvasOwnerValid()) return null;
        const local = await readCanvasProjects(name);
        const projects = isCanvasOwnerValid() && cloudPersistence ? await cloudPersistence.hydrate(local) : local;
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
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    ...(source.groups ? { groups: source.groups } : {}),
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "dots",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    selectedNodeIds: normalizeCanvasSelectedNodeIds(source.selectedNodeIds, source.nodes || [], source.groups),
                    ...(source.history ? { history: source.history } : {}),
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
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
    let restartingForOwner = false;
    useUserStore.subscribe((state) => {
        if (restartingForOwner || (state.status === "authenticated" && state.user?.id === canvasOwnerId && isWorkspaceRole(state.user.role))) return;
        // A cookie may change in another tab. Never reuse a live editor or its
        // debounce/retry buffers for a different employee. Drain the old owner's
        // immutable storage key, hide the workspace, then bootstrap a fresh one.
        restartingForOwner = true;
        canvasOwnerValid = false;
        clearPersistRetry();
        consecutivePersistFailures = 0;
        persistQueue.flush();
        useCanvasStore.setState({ projects: [], unloadedProjects: [], hydrated: false, localSaveFailureCount: 0, localSaveFailureId: 0 });
        useUserStore.setState({ user: null, status: "loading" });
        void flushCanvasPersistence().catch(() => undefined).finally(() => window.location.reload());
    });
}
