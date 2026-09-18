import type { CanvasNodeData, CanvasNodeGroup } from "@/types/canvas";

export type ResolvedCanvasGroup = { group: CanvasNodeGroup; nodeIds: ReadonlySet<string>; nodes: CanvasNodeData[] };
export type CanvasGroupBounds = { x: number; y: number; width: number; height: number };

/** Batches remain indivisible when a designer organizes their surrounding work. */
export function canvasGroupMemberIds(ids: Iterable<string>, nodesById: ReadonlyMap<string, CanvasNodeData>) {
    const members = new Set<string>();
    const pending = [...ids];
    while (pending.length) {
        const id = pending.pop()!;
        if (members.has(id)) continue;
        const node = nodesById.get(id);
        if (!node) continue;
        members.add(id);
        const parentId = node.metadata?.batchRootId;
        if (parentId && nodesById.get(parentId)?.metadata?.isBatchRoot) pending.push(parentId);
        if (node.metadata?.isBatchRoot) pending.push(...(node.metadata.batchChildIds || []));
    }
    return members;
}

export function createCanvasGroupIndex(groups: readonly CanvasNodeGroup[], nodesById: ReadonlyMap<string, CanvasNodeData>) {
    const hiddenNodeIds = new Set<string>();
    const claimed = new Set<string>();
    const resolved: ResolvedCanvasGroup[] = [];
    for (const group of groups) {
        const members = canvasGroupMemberIds(group.nodeIds, nodesById);
        // Imported or concurrently merged documents can overlap. One visual owner
        // avoids rendering the same member in several groups without deleting data.
        const nodeIds = new Set(group.nodeIds.filter(id => members.has(id) && !claimed.has(id)));
        members.forEach(id => { if (!claimed.has(id)) nodeIds.add(id); });
        const nodes = [...nodeIds].map(id => nodesById.get(id)!);
        if (!nodes.length) continue;
        nodeIds.forEach(id => { claimed.add(id); if (group.collapsed) hiddenNodeIds.add(id); });
        resolved.push({ group, nodeIds, nodes });
    }
    return { groups: resolved, hiddenNodeIds };
}

export function canvasGroupBounds(resolved: ResolvedCanvasGroup, resolveNode?: (id: string) => CanvasNodeData | undefined): CanvasGroupBounds | null {
    const membersById = new Map(resolved.nodes.map(node => [node.id, node]));
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const source of resolved.nodes) {
        const root = source.metadata?.batchRootId ? membersById.get(source.metadata.batchRootId) : undefined;
        if (root?.metadata?.isBatchRoot && !root.metadata.imageBatchExpanded) continue;
        const node = resolveNode?.(source.id) || source;
        left = Math.min(left, node.position.x);
        top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width);
        bottom = Math.max(bottom, node.position.y + node.height);
    }
    if (!Number.isFinite(left)) return null;
    return {
        x: left - 20, y: top - 48,
        width: resolved.group.collapsed ? 300 : Math.max(300, right - left + 40),
        height: resolved.group.collapsed ? 44 : Math.max(140, bottom - top + 68),
    };
}

export function removeCanvasGroupMembers(groups: CanvasNodeGroup[], removed: ReadonlySet<string>) {
    let changed = false;
    const next = groups.flatMap(group => {
        const nodeIds = group.nodeIds.filter(id => !removed.has(id));
        if (nodeIds.length === group.nodeIds.length) return [group];
        changed = true;
        return nodeIds.length ? [{ ...group, nodeIds }] : [];
    });
    return changed ? next : groups;
}

export function assignCanvasNodeGroup(groups: CanvasNodeGroup[], group: CanvasNodeGroup, nodesById: ReadonlyMap<string, CanvasNodeData>) {
    const memberIds = canvasGroupMemberIds(group.nodeIds, nodesById);
    if (!memberIds.size) return groups;
    const nodeIds = [...group.nodeIds.filter(id => memberIds.has(id))];
    memberIds.forEach(id => { if (!nodeIds.includes(id)) nodeIds.push(id); });
    return [...removeCanvasGroupMembers(groups, memberIds), { ...group, nodeIds }];
}
