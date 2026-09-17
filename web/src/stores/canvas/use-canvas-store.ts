import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { collectProjectChanges, createProjectChangeBuffer, type CanvasPersistenceConflict, type ProjectChange } from "@/lib/canvas/canvas-persistence-merge";
import { readCanvasProjects, writeCanvasProjects, removeCanvasProjects } from "@/lib/canvas/canvas-project-storage";
import { applyCanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createCloudCanvasPersistence, type CloudSaveState } from "@/services/canvas-cloud-persistence";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    history?: { past: CanvasHistorySnapshot[]; future: CanvasHistorySnapshot[] };
    persistenceConflict?: CanvasPersistenceConflict;
};
export type CanvasHistorySnapshot = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo">;

type CanvasStore = {
    hydrated: boolean;
    cloudStatus: CloudSaveState;
    cloudError: string;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport" | "history">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const oaCanvasOwnerId = deploymentFeatures.oaLoginEnabled ? useUserStore.getState().user?.id || null : null;
const CANVAS_STORE_KEY = deploymentFeatures.oaLoginEnabled
    ? `wireless-canvas:canvas_store:oa:user:${encodeURIComponent(oaCanvasOwnerId || "")}`
    : "wireless-canvas:canvas_store";
let canvasOwnerValid = !deploymentFeatures.oaLoginEnabled || Boolean(oaCanvasOwnerId);
const cloudPersistence = oaCanvasOwnerId ? createCloudCanvasPersistence(oaCanvasOwnerId, CANVAS_STORE_KEY, {
    valid: () => canvasOwnerValid && useUserStore.getState().user?.id === oaCanvasOwnerId,
    status: (cloudStatus, cloudError = "") => { if (!lastPersistError) useCanvasStore.setState({ cloudStatus, cloudError }); },
    copy: (copy) => useCanvasStore.setState(state => ({ projects: [copy, ...state.projects.filter(project => project.id !== copy.id)] })),
}) : null;
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let queuedPersistState: PersistedCanvasState | null = null;
const pendingProjectChanges = new Map<string, ProjectChange<CanvasProject>>();
const projectWriteBuffer = createProjectChangeBuffer<CanvasProject>();
type PersistWrite = { name: string; value: StorageValue<CanvasStore>; changes: Map<string, ProjectChange<CanvasProject>> };
let persistWriteChain: Promise<void> = Promise.resolve();
let lastPersistError: unknown = null;
const persistQueue = createDeferredPersistQueue<PersistWrite>(400, ({ name, changes }) => {
    pendingProjectChanges.clear();
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
        .then(() => { lastPersistError = null; if (canvasOwnerValid) { if (cloudPersistence) cloudPersistence.schedule(); else useCanvasStore.setState({ cloudStatus: "local", cloudError: "" }); } })
        .catch(error => {
            lastPersistError = error;
            if (canvasOwnerValid) useCanvasStore.setState({ cloudStatus: "local-error", cloudError: "画布写入本机失败，尚未同步本次改动；请重试保存或导出备份。" });
            console.error("画布自动保存失败，改动将随下次编辑重试；请先导出重要作品。", error);
        });
});

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

if (typeof window !== "undefined") {
    const flushCanvasPersistence = () => persistQueue.flush();
    window.addEventListener("pagehide", flushCanvasPersistence);
    window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushCanvasPersistence();
    });
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const local = await readCanvasProjects(name);
        const projects = canvasOwnerValid && cloudPersistence ? await cloudPersistence.hydrate(local) : local;
        const parsed = { version: 0, state: { projects: canvasOwnerValid ? projects : [] } } as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        if (!canvasOwnerValid) return;
        if (!useCanvasStore.getState().hydrated) return;
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        collectProjectChanges(queuedPersistState?.projects || [], nextState.projects, pendingProjectChanges);
        queuedPersistState = nextState;
        persistQueue.schedule({ name, value, changes: new Map(pendingProjectChanges) });
    },
    removeItem: (name) => {
        persistQueue.clear();
        pendingProjectChanges.clear();
        persistWriteChain = persistWriteChain
            .catch(() => undefined)
            .then(async () => {
                await removeCanvasProjects(name);
                projectWriteBuffer.clear();
            })
            .then(() => undefined);
        return persistWriteChain;
    },
};

export const useCanvasStore = create<CanvasStore>()(
    persist<CanvasStore>(
        (set, get) => ({
            hydrated: false,
            cloudStatus: cloudPersistence ? "loading" : "local",
            cloudError: "",
            projects: [],
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
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "dots",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
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

if (deploymentFeatures.oaLoginEnabled) {
    let restartingForOwner = false;
    useUserStore.subscribe((state) => {
        if (restartingForOwner || (state.user?.id || null) === oaCanvasOwnerId) return;
        // A cookie may change in another tab. Never reuse a live editor or its
        // debounce/retry buffers for a different employee. Drain the old owner's
        // immutable storage key, hide the workspace, then bootstrap a fresh one.
        restartingForOwner = true;
        canvasOwnerValid = false;
        persistQueue.flush();
        useCanvasStore.setState({ projects: [], hydrated: false });
        useUserStore.setState({ user: null, status: "loading" });
        void flushCanvasPersistence().catch(() => undefined).finally(() => window.location.reload());
    });
}
