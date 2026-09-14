import localforage from "localforage";
import { localForageStorage } from "@/lib/localforage-storage";
import { updateCanvasStorage } from "./canvas-atomic-storage";
import { mergeProjectChanges, type ProjectChange } from "./canvas-persistence-merge";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// One ordered manifest and one lossless JSON per project. Separate keys leave
// previous-format data untouched; existing projects use explicit export/import,
// not automatic migration or a second write-through copy of the whole workspace.
const manifestKey = (name: string) => `${name}:project-documents:v1`;
const documentKey = (name: string, id: string) => JSON.stringify([manifestKey(name), id]);

async function hasIndexedDb() {
    await localforage.ready();
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
                const project = JSON.parse(reading.result) as CanvasProject;
                if (!project || project.id !== id) throw new Error("画布项目 ID 与索引不一致");
                projects[index] = project;
                if (--remaining === 0) done(projects);
            } catch (error) { fail(error); }
        };
    });
}

export async function readCanvasProjects(name: string): Promise<CanvasProject[]> {
    if (!await hasIndexedDb()) {
        const stored = await localForageStorage.getItem(name);
        return stored ? JSON.parse(stored).state.projects : [];
    }
    return transaction("readonly", (store, result, fail) => {
        const reading = store.get(manifestKey(name));
        reading.onsuccess = () => {
            try { readDocuments(store, name, parseManifest(reading.result), result, fail); }
            catch (error) { fail(error); }
        };
    });
}

export async function writeCanvasProjects(name: string, changes: ReadonlyMap<string, ProjectChange<CanvasProject>>): Promise<CanvasProject[]> {
    if (!await hasIndexedDb()) {
        let written: CanvasProject[] = [];
        await updateCanvasStorage(name, stored => {
            const previous = stored ? JSON.parse(stored) : { version: 0 };
            written = mergeProjectChanges(previous.state?.projects || [], changes);
            return JSON.stringify({ ...previous, state: { projects: written } });
        });
        return written;
    }
    return transaction("readwrite", (store, result, fail) => {
        const reading = store.get(manifestKey(name));
        reading.onsuccess = () => {
            try {
                const ids = parseManifest(reading.result);
                // Include recovery copies for the existing merge's collision and
                // retry handling, but never deserialize unrelated projects.
                const prefixes = [...changes].map(([id, change]) => `${id}--conflict-${change.conflictId}`);
                const affected = ids.filter(id => changes.has(id) || prefixes.some(prefix => id.startsWith(prefix)));
                readDocuments(store, name, affected, projects => {
                    const merged = mergeProjectChanges(projects, changes);
                    const mergedIds = new Set(merged.map(project => project.id));
                    const existingIds = new Set(ids);
                    const previous = new Map(projects.map(project => [project.id, project]));
                    for (const id of affected) if (!mergedIds.has(id)) store.delete(documentKey(name, id));
                    for (const project of merged) {
                        if (project !== previous.get(project.id)) store.put(JSON.stringify(project), documentKey(name, project.id));
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
                for (const id of parseManifest(reading.result)) store.delete(documentKey(name, id));
                store.delete(manifestKey(name));
                result();
            } catch (error) { fail(error); }
        };
    });
}
