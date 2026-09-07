import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { createDeferredPersistQueue } from "@/lib/deferred-persist-queue";
import { collectProjectChanges, createProjectChangeBuffer, mergeProjectChanges, withCanvasStorageLock } from "@/lib/canvas/canvas-persistence-merge";
import { localForageStorage } from "@/lib/localforage-storage";
import { applyCanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
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
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "wireless-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let queuedPersistState: PersistedCanvasState | null = null;
const pendingProjectChanges = new Map<string, CanvasProject | null>();
const projectWriteBuffer = createProjectChangeBuffer<CanvasProject>();
type PersistWrite = { name: string; value: StorageValue<CanvasStore>; changes: Map<string, CanvasProject | null> };
let persistWriteChain: Promise<void> = Promise.resolve();
let lastPersistError: unknown = null;
const persistQueue = createDeferredPersistQueue<PersistWrite>(400, ({ name, value, changes }) => {
    pendingProjectChanges.clear();
    // IndexedDB writes are asynchronous. Keep their order stable so a slow
    // older snapshot can never finish after and overwrite a newer edit.
    persistWriteChain = persistWriteChain
        .catch(() => undefined)
        .then(() => projectWriteBuffer.write(changes, retainedChanges => withCanvasStorageLock(name, async () => {
            const stored = await localForageStorage.getItem(name);
            const current = stored ? JSON.parse(stored) as StorageValue<CanvasStore> : null;
            const projects = mergeProjectChanges(current?.state.projects || [], retainedChanges);
            await localForageStorage.setItem(name, JSON.stringify({ ...value, state: { ...value.state, projects } }));
        })))
        .then(() => { lastPersistError = null; })
        .catch(error => { lastPersistError = error; console.error("画布自动保存失败，改动将随下次编辑重试；请先导出重要作品。", error); });
});

/** Explicit save actions wait for the same ordered queue used by autosave. */
export async function flushCanvasPersistence() {
    persistQueue.flush();
    await persistWriteChain;
    if (lastPersistError) throw new Error("画布写入本机失败，请保留编辑面板并重试保存");
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
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
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
            .then(() => withCanvasStorageLock(name, async () => {
                await localForageStorage.removeItem(name);
                projectWriteBuffer.clear();
            }))
            .then(() => undefined);
        return persistWriteChain;
    },
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
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
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
