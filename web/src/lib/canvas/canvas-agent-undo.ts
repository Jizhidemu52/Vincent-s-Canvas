import type { CanvasAgentSnapshot, CanvasAgentUndoReport } from "./canvas-agent-ops";
import { imageWorkflowConnectionError } from "./canvas-shared-connections";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
export { canvasAgentUndoMessage } from "./canvas-agent-undo-report";

type FieldChange = { kind: "field"; id: string; path: string[]; before: unknown; after: unknown; absentParents: string[][] };
type NodeChange = { kind: "node"; id: string; before?: CanvasNodeData; after?: CanvasNodeData; index: number; following?: string };
type ConnectionChange = { kind: "connection"; id: string; before?: CanvasConnection; after?: CanvasConnection; index: number; following?: string };
type ViewportChange = { kind: "viewport"; key: "x" | "y" | "k"; before: number; after: number };
type SelectionChange = { kind: "selection"; before: string[]; after: string[] };
type Change = FieldChange | NodeChange | ConnectionChange | ViewportChange | SelectionChange;
export type CanvasAgentUndoPatch = { projectId: string; changes: Change[] };
export type CanvasAgentUndoRecord = CanvasAgentUndoPatch | { before: CanvasAgentSnapshot; after: CanvasAgentSnapshot };
const blockedParent = Symbol("changed parent field");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function equal(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
    if (!record(a) || !record(b)) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every(key => equal(a[key], b[key]));
}

function fields(id: string, before: unknown, after: unknown, path: string[] = [], absentParents: string[][] = []): FieldChange[] {
    if (equal(before, after)) return [];
    if ((record(before) || before === undefined) && (record(after) || after === undefined) && (record(before) || record(after))) {
        const left = record(before) ? before : {}, right = record(after) ? after : {};
        const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
        if (keys.size) return [...keys].flatMap(key => fields(id, left[key], right[key], [...path, key], before === undefined ? [...absentParents, path] : absentParents));
    }
    return [{ kind: "field", id, path, before, after, absentParents }];
}

function keyedChanges<T extends { id: string }>(before: T[], after: T[], change: (id: string, before: T | undefined, after: T | undefined, index: number, following?: string) => Change[]): Change[] {
    const left = new Map(before.map((item, index) => [item.id, { item, index }]));
    const right = new Map(after.map(item => [item.id, item]));
    return [...new Set([...left.keys(), ...right.keys()])].flatMap(id => {
        const previous = left.get(id), next = right.get(id);
        return equal(previous?.item, next) ? [] : change(id, previous?.item, next, previous?.index ?? 0, previous ? before[previous.index + 1]?.id : undefined);
    });
}

/** Derive changed values on demand; never restore a captured whole-canvas snapshot. */
export function createCanvasAgentUndoPatch(before: CanvasAgentSnapshot, after: CanvasAgentSnapshot): CanvasAgentUndoPatch | null {
    const changes: Change[] = [
        ...keyedChanges(before.nodes, after.nodes, (id, previous, next, index, following) => previous && next
            ? fields(id, previous, next) : [{ kind: "node", id, before: previous, after: next, index, following }]),
        ...keyedChanges(before.connections, after.connections, (id, previous, next, index, following) => [{ kind: "connection", id, before: previous, after: next, index, following }]),
        ...(["x", "y", "k"] as const).flatMap(key => before.viewport[key] === after.viewport[key] ? [] : [{ kind: "viewport" as const, key, before: before.viewport[key], after: after.viewport[key] }]),
        ...(equal(before.selectedNodeIds, after.selectedNodeIds) ? [] : [{ kind: "selection" as const, before: before.selectedNodeIds, after: after.selectedNodeIds }]),
    ];
    return changes.length ? { projectId: before.projectId, changes } : null;
}

function atPath(value: unknown, path: string[]): unknown {
    for (const key of path) {
        if (value === undefined) return undefined;
        if (!record(value)) return blockedParent;
        value = value[key];
    }
    return value;
}

function writePath(value: unknown, path: string[], replacement: unknown): unknown {
    if (!path.length) return replacement;
    const [key, ...rest] = path;
    const current = record(value) ? value : {};
    const next = writePath(current[key!], rest, replacement);
    const result = { ...current, [key!]: next };
    if (next === undefined) delete result[key!];
    return result;
}

function restoreItem<T extends { id: string }>(items: T[], id: string, before: T | undefined, index: number, following?: string): T[] {
    const found = items.findIndex(item => item.id === id);
    if (!before) return found < 0 ? items : items.filter(item => item.id !== id);
    if (found >= 0) return items.map(item => item.id === id ? before : item);
    const next = items.slice();
    const anchor = following ? next.findIndex(item => item.id === following) : -1;
    next.splice(anchor >= 0 ? anchor : Math.min(index, next.length), 0, before);
    return next;
}

function applyChanges(current: CanvasAgentSnapshot, changes: Change[]): CanvasAgentSnapshot {
    let nodes = current.nodes, connections = current.connections, viewport = current.viewport, selectedNodeIds = current.selectedNodeIds;
    for (const change of changes) {
        if (change.kind === "node") nodes = restoreItem(nodes, change.id, change.before, change.index, change.following);
        if (change.kind === "connection") connections = restoreItem(connections, change.id, change.before, change.index, change.following);
        if (change.kind === "field") nodes = nodes.map(node => node.id === change.id ? writePath(node, change.path, change.before) as CanvasNodeData : node);
        if (change.kind === "viewport") viewport = { ...viewport, [change.key]: change.before };
        if (change.kind === "selection") selectedNodeIds = change.before;
    }
    for (const change of changes) if (change.kind === "field" && change.absentParents.length) {
        nodes = nodes.map(node => {
            if (node.id !== change.id) return node;
            let next = node;
            for (const path of change.absentParents.toReversed()) {
                const value = atPath(next, path);
                if (record(value) && !Object.keys(value).length) next = writePath(next, path, undefined) as CanvasNodeData;
            }
            return next;
        });
    }
    const ids = new Set(nodes.map(node => node.id));
    if (selectedNodeIds.some(id => !ids.has(id))) selectedNodeIds = selectedNodeIds.filter(id => ids.has(id));
    return nodes === current.nodes && connections === current.connections && viewport === current.viewport && selectedNodeIds === current.selectedNodeIds
        ? current : { ...current, nodes, connections, viewport, selectedNodeIds };
}

function edgeError(edge: CanvasConnection, snapshot: CanvasAgentSnapshot): string | undefined {
    const from = snapshot.nodes.find(node => node.id === edge.fromNodeId), to = snapshot.nodes.find(node => node.id === edge.toNodeId);
    if (!from || !to) return "端点已删除，不能恢复悬空连线";
    if (from.id === to.id) return "不能恢复指向自身的连线";
    const others = snapshot.connections.filter(item => item.id !== edge.id);
    if (others.some(item => item.fromNodeId === edge.fromNodeId && item.toNodeId === edge.toNodeId)) return "端点间已有另一条连线";
    if (edge.kind === "config-target") {
        if (from.type !== CanvasNodeType.Config || to.type === CanvasNodeType.Config) return "端点类型已改变，不能恢复共享配置连线";
        if (others.some(item => item.kind === "config-target" && item.toNodeId === edge.toNodeId)) return "任务已有其他共享配置";
    }
    if (edge.kind === "config-sequence") {
        if ([from, to].some(node => node.type !== CanvasNodeType.Config || (node.metadata?.generationMode || "image") !== "image")) return "端点类型已改变，不能恢复步骤连线";
        return imageWorkflowConnectionError(edge, others);
    }
    return undefined;
}

function location(change: Change) {
    if (change.kind === "selection") return "画布选择";
    if (change.kind === "viewport") return `视图.${change.key}`;
    return `${change.kind === "connection" ? "连线" : "节点"} ${change.id}${change.kind === "field" ? `.${change.path.join(".")}` : ""}`;
}

/** Compare-and-revert: a later value always wins. Failed fields alone remain retryable. */
export function undoCanvasAgentPatch(current: CanvasAgentSnapshot, patch: CanvasAgentUndoPatch, protectedNodeIds: ReadonlyMap<string, string> = new Map()) {
    const conflicts = new Map<Change, string>();
    const active = new Set<Change>();
    const nodes = new Map(current.nodes.map(node => [node.id, node])), edges = new Map(current.connections.map(edge => [edge.id, edge]));
    for (const change of patch.changes) {
        if (patch.projectId !== current.projectId) { conflicts.set(change, "画布已切换，不能撤销另一张画布的操作"); continue; }
        const value = change.kind === "selection" ? current.selectedNodeIds : change.kind === "viewport" ? current.viewport[change.key]
            : change.kind === "connection" ? edges.get(change.id) : change.kind === "node" ? nodes.get(change.id)
                : nodes.has(change.id) ? atPath(nodes.get(change.id), change.path) : blockedParent;
        if (equal(value, change.before)) continue; // Already reverted by Ctrl+Z or an earlier partial undo.
        if (!equal(value, change.after)) { conflicts.set(change, "此后已被编辑或生成结果更新，保留当前内容"); continue; }
        if (change.kind === "node" && !change.before && protectedNodeIds.has(change.id)) { conflicts.set(change, protectedNodeIds.get(change.id)!); continue; }
        active.add(change);
    }
    let snapshot = current;
    // Dependency checks only remove candidates, so the loop terminates in at most
    // one pass per candidate. Existing, unrelated graph problems are not repaired.
    while (true) {
        snapshot = applyChanges(current, [...active]);
        const blocked = new Map<Change, string>();
        for (const change of active) if (change.kind === "connection" && change.before) {
            const reusedEndpoint = patch.changes.some(candidate => candidate.kind === "node" && candidate.before && !candidate.after
                && conflicts.has(candidate) && [change.before!.fromNodeId, change.before!.toNodeId].includes(candidate.id));
            const error = reusedEndpoint ? "原端点 ID 已被后续节点占用，不能把旧连线接到新节点" : edgeError(change.before, snapshot);
            if (error) blocked.set(change, error);
        }
        if (!blocked.size) for (const change of active) {
            if (change.kind === "node" && !change.before && snapshot.connections.some(edge => edge.fromNodeId === change.id || edge.toNodeId === change.id)) {
                blocked.set(change, "后续连线仍在引用此节点，保留节点及连线");
            }
            if (change.kind === "field" && (change.path[0] === "type" || change.path.join(".") === "metadata.generationMode")) {
                const invalid = snapshot.connections.find(edge => (edge.fromNodeId === change.id || edge.toNodeId === change.id) && edgeError(edge, snapshot) && !edgeError(edge, current));
                if (invalid) blocked.set(change, "后续连线依赖当前节点类型，保留此字段");
            }
        }
        if (!blocked.size) break;
        for (const [change, reason] of blocked) { active.delete(change); conflicts.set(change, reason); }
    }
    const remaining = patch.changes.filter(change => conflicts.has(change));
    const report: CanvasAgentUndoReport = {
        applied: active.size,
        conflicts: remaining.map(change => ({ location: location(change), reason: conflicts.get(change)! })),
        retryable: remaining.length > 0,
    };
    return { snapshot, report, remaining: remaining.length ? { projectId: patch.projectId, changes: remaining } : null };
}
