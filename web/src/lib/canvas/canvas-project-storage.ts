import localforage from "localforage";
import { localForageStorage, readyLocalForageStorage } from "@/lib/localforage-storage";
import { updateCanvasStorage } from "./canvas-atomic-storage";
import { mergeProjectChanges, type ProjectChange } from "./canvas-persistence-merge";
import { decodeCanvasProject, encodeCanvasProject, parseCanvasProject, serializeCanvasProject } from "./canvas-project-codec";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { canvasProjectSummary, type CanvasProjectSummary } from "./canvas-project-summary";
import { isCanvasStorageQuotaError } from "./canvas-storage-capacity";

// One ordered manifest and one lossless JSON per project. Separate keys leave
// previous-format data untouched; existing projects use explicit export/import,
// not automatic migration or a second write-through copy of the whole workspace.
const manifestKey = (name: string) => `${name}:project-documents:v1`;
const documentKey = (name: string, id: string) => JSON.stringify([manifestKey(name), id]);
const summaryKey = (name: string, id: string) => JSON.stringify([`${name}:project-summaries:v1`, id]);
const viewKey = (name: string, id: string) => JSON.stringify([`${name}:project-view:v1`, id]);
const withView = (project: CanvasProject, view: unknown): CanvasProject => {
    if (!view || typeof view !== "object") return project;
    const value = view as Pick<CanvasProject, "viewport" | "selectedNodeIds">;
    if (!value.viewport || ![value.viewport.x, value.viewport.y, value.viewport.k].every(Number.isFinite) || value.viewport.k <= 0) return project;
    return { ...project, viewport: value.viewport, selectedNodeIds: Array.isArray(value.selectedNodeIds) ? value.selectedNodeIds.filter(id => typeof id === "string") : project.selectedNodeIds };
};

async function hasIndexedDb() {
    await readyLocalForageStorage();
    return localforage.driver() === localforage.INDEXEDDB;
}

function parseManifest(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(id => typeof id !== "string") || new Set(value).size !== value.length) {
        throw new Error("画布项目索引损坏，未覆盖原数据");
    }
    return value;
}

function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        const opening = indexedDB.open(localforage.config("name") as string);
        let settled = false;
        let failure: unknown;
        const rejectOnce = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
        opening.onupgradeneeded = () => { failure = new Error("画布存储尚未初始化"); opening.transaction?.abort(); };
        opening.onerror = () => rejectOnce(failure || opening.error);
        opening.onblocked = () => rejectOnce(new Error("画布存储被其他窗口阻塞"));
        opening.onsuccess = () => {
            const db = opening.result;
            if (settled) { db.close(); return; }
            db.onversionchange = () => db.close();
            let tx: IDBTransaction;
            try { tx = db.transaction(localforage.config("storeName") as string, mode); }
            catch (error) { db.close(); rejectOnce(error); return; }
            let value: T;
            const fail = (error: unknown) => { failure = error; tx.abort(); };
            tx.onabort = () => { db.close(); rejectOnce(failure || tx.error || new Error("画布保存事务已中止")); };
            tx.onerror = () => { failure ||= tx.error; };
            tx.oncomplete = () => { db.close(); if (!settled) { settled = true; resolve(value); } };
            try { run(tx.objectStore(localforage.config("storeName") as string), next => { value = next; }, fail); }
            catch (error) { fail(error); }
        };
    });
}

// Enqueue requests synchronously in IDB callbacks; never await inside a transaction.
function readDocuments(store: IDBObjectStore, name: string, ids: string[], done: (projects: CanvasProject[]) => void, fail: (error: unknown) => void) {
    if (!ids.length) { done([]); return; }
    const projects: CanvasProject[] = new Array(ids.length);
    let remaining = ids.length;
    ids.forEach((id, index) => {
        const reading = store.get(documentKey(name, id));
        reading.onsuccess = () => {
            try {
                if (typeof reading.result !== "string") throw new Error(`画布项目 ${id} 内容缺失，未覆盖原数据`);
                const project = parseCanvasProject(reading.result);
                if (!project || project.id !== id) throw new Error("画布项目 ID 与索引不一致");
                const view = store.get(viewKey(name, id));
                view.onsuccess = () => {
                    projects[index] = withView(project, view.result);
                    if (--remaining === 0) done(projects);
                };
            } catch (error) { fail(error); }
        };
    });
}

export async function readCanvasProjects(name: string): Promise<CanvasProject[]> {
    if (!await hasIndexedDb()) {
        const stored = await localForageStorage.getItem(name);
        return stored ? JSON.parse(stored).state.projects.map(decodeCanvasProject) : [];
    }
    return transaction("readonly", (store, result, fail) => {
        const reading = store.get(manifestKey(name));
        reading.onsuccess = () => {
            try { readDocuments(store, name, parseManifest(reading.result), result, fail); }
            catch (error) { fail(error); }
        };
    });
}

export async function readCanvasProject(name: string, id: string): Promise<CanvasProject | null> {
    if (!await hasIndexedDb()) return (await readCanvasProjects(name)).find(project => project.id === id) || null;
    return transaction("readonly", (store, result, fail) => {
        const reading = store.get(documentKey(name, id));
        reading.onsuccess = () => {
            try {
                const project = typeof reading.result === "string" ? parseCanvasProject(reading.result) : null;
                if (project && project.id !== id) throw new Error("画布项目 ID 与索引不一致");
                if (!project) { result(null); return; }
                const view = store.get(viewKey(name, id));
                view.onsuccess = () => result(withView(project, view.result));
            }
            catch (error) { fail(error); }
        };
    });
}

/** Saved summaries let the library render without decoding large graphs/history. */
export async function readCanvasLibrary(name: string): Promise<{ projects: CanvasProject[]; summaries: CanvasProjectSummary[] }> {
    if (!await hasIndexedDb()) return { projects: await readCanvasProjects(name), summaries: [] };
    return transaction<{ projects: CanvasProject[]; summaries: CanvasProjectSummary[] }>("readwrite", (store, result, fail) => {
        const reading = store.get(manifestKey(name));
        reading.onsuccess = () => {
            try {
                const ids = parseManifest(reading.result);
                if (!ids.length) { result({ projects: [], summaries: [] }); return; }
                const summaries: CanvasProjectSummary[] = [], missing: string[] = [];
                let remaining = ids.length;
                for (const id of ids) {
                    const summary = store.get(summaryKey(name, id));
                    summary.onsuccess = () => {
                        const value = summary.result as CanvasProjectSummary | undefined;
                        if (value?.id === id && typeof value.title === "string" && typeof value.updatedAt === "string") summaries.push(value);
                        else missing.push(id);
                        if (--remaining === 0) readDocuments(store, name, missing, projects => {
                            // Populate only the rebuildable index, never rewrite the source document.
                            for (const project of projects) store.put(canvasProjectSummary(project), summaryKey(name, project.id));
                            result({ projects, summaries });
                        }, fail);
                    };
                }
            } catch (error) { fail(error); }
        };
    }).catch(async error => {
        if (!isCanvasStorageQuotaError(error)) throw error;
        return { projects: await readCanvasProjects(name), summaries: [] };
    });
}

export async function writeCanvasProjects(name: string, changes: ReadonlyMap<string, ProjectChange<CanvasProject>>): Promise<CanvasProject[]> {
    if (!await hasIndexedDb()) {
        let written: CanvasProject[] = [];
        await updateCanvasStorage(name, stored => {
            const previous = stored ? JSON.parse(stored) : { version: 0 };
            written = mergeProjectChanges((previous.state?.projects || []).map(decodeCanvasProject), changes);
            return JSON.stringify({ ...previous, state: { projects: written.map(encodeCanvasProject) } });
        });
        return written;
    }
    return transaction("readwrite", (store, result, fail) => {
        const reading = store.get(manifestKey(name));
        reading.onsuccess = () => {
            try {
                const ids = parseManifest(reading.result);
                const documentChanges = new Map(changes);
                for (const [id, change] of changes) {
                    if (!change.base || !change.value) continue;
                    const viewOnly = Object.keys(change.value).every(key => key === "viewport" || key === "selectedNodeIds"
                        || Object.is(change.base![key as keyof CanvasProject], change.value![key as keyof CanvasProject]));
                    if (!viewOnly) continue;
                    if (ids.includes(id)) store.put({ viewport: change.value.viewport, selectedNodeIds: change.value.selectedNodeIds }, viewKey(name, id));
                    documentChanges.delete(id);
                }
                if (!documentChanges.size) { result([]); return; }
                // Include recovery copies for the existing merge's collision and
                // retry handling, but never deserialize unrelated projects.
                const prefixes = [...documentChanges].map(([id, change]) => `${id}--conflict-${change.conflictId}`);
                const affected = ids.filter(id => documentChanges.has(id) || prefixes.some(prefix => id.startsWith(prefix)));
                readDocuments(store, name, affected, projects => {
                    const merged = mergeProjectChanges(projects, documentChanges);
                    const mergedIds = new Set(merged.map(project => project.id));
                    const existingIds = new Set(ids);
                    const previous = new Map(projects.map(project => [project.id, project]));
                    for (const id of affected) if (!mergedIds.has(id)) { store.delete(documentKey(name, id)); store.delete(summaryKey(name, id)); store.delete(viewKey(name, id)); }
                    for (const project of merged) {
                        if (project !== previous.get(project.id)) store.put(serializeCanvasProject(project), documentKey(name, project.id));
                        store.put({ viewport: project.viewport, selectedNodeIds: project.selectedNodeIds }, viewKey(name, project.id));
                        store.put(canvasProjectSummary(project), summaryKey(name, project.id));
                    }
                    const affectedIds = new Set(affected);
                    const nextIds = [...merged.filter(project => !existingIds.has(project.id)).map(project => project.id), ...ids.filter(id => !affectedIds.has(id) || mergedIds.has(id))];
                    store.put(nextIds, manifestKey(name));
                    result(merged);
                }, fail);
            } catch (error) { fail(error); }
        };
    });
}

export async function removeCanvasProjects(name: string) {
    if (!await hasIndexedDb()) return updateCanvasStorage(name, () => null);
    return transaction<void>("readwrite", (store, result, fail) => {
        const reading = store.get(manifestKey(name));
        reading.onsuccess = () => {
            try {
                for (const id of parseManifest(reading.result)) { store.delete(documentKey(name, id)); store.delete(summaryKey(name, id)); store.delete(viewKey(name, id)); }
                store.delete(manifestKey(name));
                result();
            } catch (error) { fail(error); }
        };
    });
}
