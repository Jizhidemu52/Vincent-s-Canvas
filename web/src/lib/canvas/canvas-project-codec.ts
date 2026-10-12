import type { CanvasHistorySnapshot, CanvasProject } from "@/stores/canvas/use-canvas-store";

const historyFormat = "canvas-history-delta-v1";
const snapshotKeys = ["nodes", "groups", "connections", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo"] as const;
const arrayKeys = new Set<string>(["nodes", "groups", "connections", "chatSessions"]);
const allowedKeys = new Set<string>(snapshotKeys);
type SnapshotKey = typeof snapshotKeys[number];
type Fields = Partial<Record<SnapshotKey, unknown>>;
type ArrayDelta = { kind: "items"; length: number; changes: [number, unknown][] }
    | { kind: "splice"; start: number; deleteCount: number; items: unknown[] };
type SnapshotDelta = { set?: Fields; remove?: SnapshotKey[]; arrays?: Partial<Record<SnapshotKey, ArrayDelta>> };
type CompactHistory = { format: typeof historyFormat; past: SnapshotDelta[]; future: SnapshotDelta[] };
export type EncodedCanvasProject = Omit<CanvasProject, "history"> & { history?: CompactHistory };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (): never => { throw new Error("画布撤销历史数据损坏，未覆盖原数据"); };

// Runtime snapshots already share unchanged nodes. Equality also accepts imported
// expanded JSON, without stringifying every node in every historical frame.
function equalValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equalValue(value, b[index]));
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKeys = Object.keys(a).filter(key => a[key] !== undefined);
    const bKeys = Object.keys(b).filter(key => b[key] !== undefined);
    return aKeys.length === bKeys.length && aKeys.every(key => Object.hasOwn(b, key) && equalValue(a[key], b[key]));
}

function snapshot(project: CanvasProject): CanvasHistorySnapshot {
    return Object.fromEntries(snapshotKeys.filter(key => project[key] !== undefined).map(key => [key, project[key]])) as CanvasHistorySnapshot;
}

function arrayDelta(before: unknown[], after: unknown[]): ArrayDelta | undefined {
    if (before === after) return;
    let start = 0;
    const length = Math.min(before.length, after.length);
    while (start < length && equalValue(before[start], after[start])) start += 1;
    if (start === before.length && start === after.length) return;
    let tail = 0;
    while (tail < length - start && equalValue(before[before.length - 1 - tail], after[after.length - 1 - tail])) tail += 1;
    const items = after.slice(start, after.length - tail);
    const splice: ArrayDelta = { kind: "splice", start, deleteCount: before.length - start - tail, items };
    // Insertions/deletions retain their shared suffix instead of recording every
    // shifted node. Same-length edits use sparse changes when that is smaller.
    if (before.length !== after.length) return splice;
    const changes: [number, unknown][] = [];
    for (let index = start; index < after.length - tail; index += 1) {
        if (!equalValue(before[index], after[index])) changes.push([index, after[index]]);
    }
    return changes.length * 2 < items.length ? { kind: "items", length: after.length, changes } : splice;
}

function snapshotDelta(before: CanvasHistorySnapshot, after: CanvasHistorySnapshot): SnapshotDelta {
    const set: Fields = {};
    const remove: SnapshotKey[] = [];
    const arrays: Partial<Record<SnapshotKey, ArrayDelta>> = {};
    for (const key of snapshotKeys) {
        const previous = before[key];
        const next = after[key];
        if (previous === next) continue;
        if (next === undefined) remove.push(key);
        else if (Array.isArray(previous) && Array.isArray(next)) {
            const delta = arrayDelta(previous, next);
            if (delta) arrays[key] = delta;
        } else if (!equalValue(previous, next)) set[key] = next;
    }
    return {
        ...(Object.keys(set).length ? { set } : {}),
        ...(remove.length ? { remove } : {}),
        ...(Object.keys(arrays).length ? { arrays } : {}),
    };
}

function encodeStack(anchor: CanvasHistorySnapshot, frames: CanvasHistorySnapshot[]): SnapshotDelta[] {
    const encoded: SnapshotDelta[] = new Array(frames.length);
    let previous = anchor;
    // Both undo and redo pop their nearest frame from the end of their stack.
    for (let index = frames.length - 1; index >= 0; index -= 1) {
        encoded[index] = snapshotDelta(previous, frames[index]);
        previous = frames[index];
    }
    return encoded;
}

/** Keep the complete current graph visible to normal media/security traversal. */
export function encodeCanvasProject(project: CanvasProject): EncodedCanvasProject {
    const { history, ...document } = project;
    if (!history) return document;
    const anchor = snapshot(project);
    return { ...document, history: { format: historyFormat, past: encodeStack(anchor, history.past), future: encodeStack(anchor, history.future) } };
}

function exactKeys(value: Record<string, unknown>, permitted: readonly string[]) {
    if (Object.keys(value).some(key => !permitted.includes(key))) invalid();
}

function applyArrayDelta(before: unknown[], value: unknown): unknown[] {
    if (!isRecord(value)) return invalid();
    if (value.kind === "splice") {
        exactKeys(value, ["kind", "start", "deleteCount", "items"]);
        const { start, deleteCount, items } = value;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(deleteCount) || !Array.isArray(items)) return invalid();
        if ((start as number) < 0 || (start as number) > before.length || (deleteCount as number) < 0 || (deleteCount as number) > before.length - (start as number)) return invalid();
        if (!deleteCount && !items.length) return before;
        return [...before.slice(0, start as number), ...items, ...before.slice((start as number) + (deleteCount as number))];
    }
    if (value.kind !== "items") return invalid();
    exactKeys(value, ["kind", "length", "changes"]);
    const { length, changes } = value;
    // Sparse edits only replace existing slots. Length-changing operations use
    // splice, so corrupt lengths cannot allocate huge arrays or create holes.
    if (length !== before.length || !Array.isArray(changes)) return invalid();
    let previousIndex = -1;
    for (const change of changes) {
        if (!Array.isArray(change) || change.length !== 2 || !Number.isSafeInteger(change[0]) || change[0] <= previousIndex || change[0] >= before.length) return invalid();
        previousIndex = change[0];
    }
    if (!changes.length) return before;
    const result = before.slice();
    for (const [index, item] of changes) result[index] = item;
    return result;
}

function applySnapshotDelta(before: CanvasHistorySnapshot, value: unknown): CanvasHistorySnapshot {
    if (!isRecord(value)) return invalid();
    exactKeys(value, ["set", "remove", "arrays"]);
    if (value.set !== undefined && !isRecord(value.set)) return invalid();
    if (value.arrays !== undefined && !isRecord(value.arrays)) return invalid();
    if (value.remove !== undefined && !Array.isArray(value.remove)) return invalid();
    const set = (value.set || {}) as Record<string, unknown>;
    const arrays = (value.arrays || {}) as Record<string, unknown>;
    const remove = (value.remove || []) as unknown[];
    const touched = [...Object.keys(set), ...Object.keys(arrays), ...remove];
    if (touched.some(key => typeof key !== "string" || !allowedKeys.has(key)) || new Set(touched).size !== touched.length) return invalid();
    if (remove.some(key => key !== "groups")) return invalid();
    if (Object.keys(arrays).some(key => !arrayKeys.has(key))) return invalid();
    for (const [key, field] of Object.entries(set)) if (arrayKeys.has(key) && !Array.isArray(field)) return invalid();
    if (Object.hasOwn(set, "activeChatId") && set.activeChatId !== null && typeof set.activeChatId !== "string") return invalid();
    if (Object.hasOwn(set, "backgroundMode") && !["dots", "lines", "blank"].includes(set.backgroundMode as string)) return invalid();
    if (Object.hasOwn(set, "showImageInfo") && typeof set.showImageInfo !== "boolean") return invalid();
    if (!touched.length) return before;
    const result = { ...before, ...set } as Record<string, unknown>;
    for (const key of remove as string[]) delete result[key];
    for (const [key, delta] of Object.entries(arrays)) {
        const previous = before[key as SnapshotKey];
        if (!Array.isArray(previous)) return invalid();
        result[key] = applyArrayDelta(previous, delta);
    }
    return result as CanvasHistorySnapshot;
}

function decodeStack(anchor: CanvasHistorySnapshot, frames: unknown): CanvasHistorySnapshot[] {
    if (!Array.isArray(frames)) return invalid();
    const decoded: CanvasHistorySnapshot[] = new Array(frames.length);
    let previous = anchor;
    for (let index = frames.length - 1; index >= 0; index -= 1) {
        decoded[index] = applySnapshotDelta(previous, frames[index]);
        previous = decoded[index];
    }
    return decoded;
}

/** Expanded import documents remain valid; malformed compact data never falls back. */
export function decodeCanvasProject(value: unknown): CanvasProject {
    if (!isRecord(value)) return invalid();
    const history = value.history;
    if (!history || (isRecord(history) && !Object.hasOwn(history, "format"))) return value as CanvasProject;
    if (!isRecord(history) || history.format !== historyFormat) return invalid();
    exactKeys(history, ["format", "past", "future"]);
    const anchor = snapshot(value as CanvasProject);
    return { ...value, history: { past: decodeStack(anchor, history.past), future: decodeStack(anchor, history.future) } } as CanvasProject;
}

/** Deterministic bytes also survive PostgreSQL jsonb's object-key reordering. */
export function serializeCanvasProject(project: CanvasProject): string {
    return JSON.stringify(encodeCanvasProject(project), (_key, value) => isRecord(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

export function parseCanvasProject(value: string): CanvasProject {
    return decodeCanvasProject(JSON.parse(value));
}
