import { createClientId } from "@/lib/client-id";

export type CanvasPersistenceConflict = { projectId: string; paths: string[]; savedAt: string };
export type ProjectChange<T> = { base: T | null; value: T | null; conflictId: string; savedAt: string };

/** Retain the first immutable baseline, including across debounce and failed writes. */
function retainChange<T>(pending: Map<string, ProjectChange<T>>, id: string, change: ProjectChange<T>) {
    const earlier = pending.get(id);
    pending.set(id, earlier ? { ...earlier, value: change.value } : change);
}

/** Track only this tab's mutations, never treat its stale list as the whole database. */
export function collectProjectChanges<T extends { id: string }>(previous: T[], next: T[], pending = new Map<string, ProjectChange<T>>()) {
    const before = new Map(previous.map(project => [project.id, project]));
    const after = new Set(next.map(project => project.id));
    const record = (id: string, value: T | null) => retainChange(pending, id, {
        base: before.get(id) || null, value, conflictId: createClientId(), savedAt: new Date().toISOString(),
    });
    for (const project of next) if (before.get(project.id) !== project) record(project.id, project);
    for (const project of previous) if (!after.has(project.id)) record(project.id, null);
    return pending;
}

type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Automatic timestamps are not user conflicts. Values stay intact; images are never re-encoded. */
function sameValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
    if (!isObject(a) || !isObject(b)) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every(key => key === "updatedAt" || sameValue(a[key], b[key]));
}

function keyedArray(value: unknown): value is Array<JsonObject & { id: string }> {
    return Array.isArray(value) && value.every(item => isObject(item) && typeof item.id === "string") && new Set(value.map(item => item.id)).size === value.length;
}

function sameOrder(a: string[], b: string[]) { return a.length === b.length && a.every((id, index) => id === b[index]); }

function mergeArray(base: Array<JsonObject & { id: string }>, local: Array<JsonObject & { id: string }>, remote: Array<JsonObject & { id: string }>, path: string, conflicts: string[]): unknown[] {
    const before = new Map(base.map(item => [item.id, item]));
    const ours = new Map(local.map(item => [item.id, item]));
    const theirs = new Map(remote.map(item => [item.id, item]));
    const values = new Map<string, unknown>();
    for (const id of new Set([...before.keys(), ...theirs.keys(), ...ours.keys()])) {
        const value = mergeValue(before.get(id), ours.get(id), theirs.get(id), `${path}[${id}]`, conflicts);
        if (value !== undefined) values.set(id, value);
    }
    const baseIds = base.map(item => item.id);
    const localIds = local.map(item => item.id);
    const remoteIds = remote.map(item => item.id);
    const localReordered = !sameOrder(baseIds.filter(id => ours.has(id)), localIds.filter(id => before.has(id)));
    const remoteReordered = !sameOrder(baseIds.filter(id => theirs.has(id)), remoteIds.filter(id => before.has(id)));
    const common = (ids: string[]) => ids.filter(id => before.has(id) && ours.has(id) && theirs.has(id));
    if (localReordered && remoteReordered && !sameOrder(common(localIds), common(remoteIds))) conflicts.push(`${path}.$order`);
    const primary = localReordered ? localIds : remoteIds;
    const secondary = localReordered ? remoteIds : localIds;
    const order = primary.filter(id => values.has(id));
    const included = new Set(order);
    // Place independent insertions next to their known neighbours, preserving
    // each window's intentional ordering rather than sorting graph/message IDs.
    for (let index = 0; index < secondary.length; index += 1) {
        const id = secondary[index];
        if (!values.has(id) || included.has(id)) continue;
        const previous = secondary.slice(0, index).reverse().find(candidate => included.has(candidate));
        const following = secondary.slice(index + 1).find(candidate => included.has(candidate));
        const insertion = previous ? order.indexOf(previous) + 1 : following ? order.indexOf(following) : order.length;
        order.splice(insertion, 0, id);
        included.add(id);
    }
    return order.map(id => values.get(id));
}

function mergeValue(base: unknown, local: unknown, remote: unknown, path: string, conflicts: string[]): unknown {
    if (sameValue(local, base)) return remote;
    if (sameValue(remote, base) || sameValue(local, remote)) return local;
    if (keyedArray(base) && keyedArray(local) && keyedArray(remote)) return mergeArray(base, local, remote, path, conflicts);
    if (isObject(local) && isObject(remote) && (base === undefined || base === null || isObject(base))) {
        const result: JsonObject = {};
        const before = isObject(base) ? base : {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(remote), ...Object.keys(local)])) {
            const value = key === "updatedAt"
                ? [before[key], remote[key], local[key]].filter((item): item is string => typeof item === "string").sort().at(-1)
                : mergeValue(before[key], local[key], remote[key], path ? `${path}.${key}` : key, conflicts);
            if (value !== undefined) result[key] = value;
        }
        return result;
    }
    conflicts.push(path);
    return local;
}

/** Independently merged arrays must not strand a connection whose node was deleted. */
function reconcileGraphConnections(merged: unknown, local: unknown, remote: unknown, localConflicts: string[], remoteConflicts: string[]): unknown {
    if (!isObject(merged) || !keyedArray(merged.nodes) || !keyedArray(merged.connections)) return merged;
    const nodeIds = new Set(merged.nodes.map(node => node.id));
    const sources = [[local, localConflicts], [remote, remoteConflicts]] as const;
    const graphs = sources.flatMap(([source, paths]) => {
        if (!isObject(source) || !keyedArray(source.nodes) || !keyedArray(source.connections)) return [];
        return [{ paths, nodeIds: new Set(source.nodes.map(node => node.id)), connections: new Map(source.connections.map(edge => [edge.id, edge])) }];
    });
    const connections = merged.connections.filter(edge => {
        if (typeof edge.fromNodeId !== "string" || typeof edge.toNodeId !== "string" || (nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))) return true;
        let recoverable = false;
        for (const graph of graphs) {
            const original = graph.connections.get(edge.id);
            if (!original || typeof original.fromNodeId !== "string" || typeof original.toNodeId !== "string" || !graph.nodeIds.has(original.fromNodeId) || !graph.nodeIds.has(original.toNodeId)) continue;
            graph.paths.push(`connections[${edge.id}].$missingNode`);
            recoverable = true;
        }
        // Preserve the complete valid source graph before dropping the edge.
        // Already-invalid input is not silently cleaned up by a concurrency merge.
        return !recoverable;
    });
    return connections.length === merged.connections.length ? merged : { ...merged, connections };
}

/** Merge field-level edits, retaining a full recoverable snapshot on actual conflicts. */
export function mergeProjectChanges<T extends { id: string }>(stored: T[], changes: ReadonlyMap<string, ProjectChange<T>>): T[] {
    const current = new Map(stored.map(project => [project.id, project]));
    const created: T[] = [];
    const copies: T[] = [];
    const copyConflict = (source: T, change: ProjectChange<T>, paths: string[], localGraph = false) => {
        const details = source as T & { title?: string };
        let id = `${source.id}--conflict-${change.conflictId}${localGraph ? "-local-graph" : ""}`;
        const copy = { ...source, id, title: `${details.title || "未命名画布"}（保存冲突副本）`, updatedAt: change.savedAt, persistenceConflict: { projectId: source.id, paths, savedAt: change.savedAt } };
        // A failed/uncertain write may already have persisted this copy. Reuse it
        // without replacing a different recovery snapshot created in the meantime.
        if (current.has(id) && sameValue(current.get(id), copy)) return;
        if (current.has(id)) id = `${id}-${createClientId()}`;
        copies.push({ ...copy, id });
    };
    for (const [id, change] of changes) {
        const remote = current.get(id);
        if (change.value === null) {
            if (remote && change.base && !sameValue(remote, change.base)) copyConflict(remote, change, ["$projectDeleted"]);
            current.delete(id);
        } else if (!remote) {
            if (change.base) {
                if (!sameValue(change.value, change.base)) copyConflict(change.value, change, ["$projectDeleted"]);
            } else {
                current.set(id, change.value);
                created.push(change.value);
            }
        } else {
            const conflicts: string[] = [];
            const localGraphConflicts: string[] = [];
            const merged = mergeValue(change.base, change.value, remote, "", conflicts);
            current.set(id, reconcileGraphConnections(merged, change.value, remote, localGraphConflicts, conflicts) as T);
            if (conflicts.length) copyConflict(remote, change, conflicts);
            if (localGraphConflicts.length) copyConflict(change.value, change, localGraphConflicts, true);
        }
    }
    return [...copies, ...created, ...stored.flatMap(project => current.has(project.id) ? [current.get(project.id)!] : [])];
}

/** Calls are serialized by the storage writer. Failed mutations survive its next flush. */
export function createProjectChangeBuffer<T extends { id: string }>() {
    const pending = new Map<string, ProjectChange<T>>();
    return {
        async write(changes: ReadonlyMap<string, ProjectChange<T>>, persist: (changes: ReadonlyMap<string, ProjectChange<T>>) => Promise<void>) {
            for (const [id, change] of changes) retainChange(pending, id, change);
            await persist(pending);
            pending.clear();
        },
        clear() { pending.clear(); },
    };
}

export async function withCanvasStorageLock<T>(name: string, write: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
        return navigator.locks.request(`canvas-storage:${name}`, write);
    }
    return write();
}
