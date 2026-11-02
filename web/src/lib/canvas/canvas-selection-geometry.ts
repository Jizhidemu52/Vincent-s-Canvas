import type { CanvasNodeData, CanvasNodeGroup, Position } from "@/types/canvas";
import { canvasGroupBounds, createCanvasGroupIndex } from "./canvas-node-groups";

export function canvasSelectionBounds(nodes: readonly CanvasNodeData[]) {
    if (!nodes.length) return null;
    const x = Math.min(...nodes.map(node => node.position.x)), y = Math.min(...nodes.map(node => node.position.y));
    return { x, y, width: Math.max(...nodes.map(node => node.position.x + node.width)) - x, height: Math.max(...nodes.map(node => node.position.y + node.height)) - y };
}

export function snapCanvasDrag(moving: readonly CanvasNodeData[], stationary: readonly CanvasNodeData[], delta: Position, scale: number, options: { disabled?: boolean; axis?: boolean } = {}) {
    let x = delta.x, y = delta.y;
    if (options.axis) { if (Math.abs(x) >= Math.abs(y)) y = 0; else x = 0; }
    const bounds = canvasSelectionBounds(moving);
    const guides: { axis: "x" | "y"; value: number; start: number; end: number }[] = [];
    if (!bounds || options.disabled) return { x, y, guides };
    const threshold = 6 / Math.max(scale, 0.01);
    for (const axis of ["x", "y"] as const) {
        if (options.axis && (axis === "x" ? x === 0 : y === 0)) continue;
        const dimension = axis === "x" ? "width" : "height", cross = axis === "x" ? "y" : "x", crossDimension = cross === "x" ? "width" : "height";
        const start = bounds[axis] + (axis === "x" ? x : y), end = start + bounds[dimension];
        const movingCross = bounds[cross] + (cross === "x" ? x : y);
        let best: { offset: number; value: number; node: CanvasNodeData } | undefined;
        for (const node of stationary) {
            if (node.position[cross] > movingCross + bounds[crossDimension] + 240 / scale || node.position[cross] + node[crossDimension] < movingCross - 240 / scale) continue;
            for (const value of [node.position[axis], node.position[axis] + node[dimension] / 2, node.position[axis] + node[dimension]]) {
                for (const edge of [start, (start + end) / 2, end]) {
                    const offset = value - edge;
                    if (Math.abs(offset) <= threshold && (!best || Math.abs(offset) < Math.abs(best.offset))) best = { offset, value, node };
                }
            }
        }
        if (best) {
            if (axis === "x") x += best.offset; else y += best.offset;
            guides.push({ axis, value: best.value, start: Math.min(movingCross, best.node.position[cross]), end: Math.max(movingCross + bounds[crossDimension], best.node.position[cross] + best.node[crossDimension]) });
        }
    }
    return { x, y, guides };
}

/** Compare against pre-drag frames; moving a whole group must not ungroup it. */
export function transferCanvasGroupMembers(groups: CanvasNodeGroup[], before: CanvasNodeData[], after: CanvasNodeData[], movedIds: ReadonlySet<string>) {
    const index = createCanvasGroupIndex(groups, new Map(before.map(node => [node.id, node])));
    const frames = index.groups.filter(item => !item.group.collapsed).map(item => ({ item, bounds: canvasGroupBounds(item)! }));
    const wholeGroups = new Set(index.groups.filter(item => [...item.nodeIds].every(id => movedIds.has(id))).map(item => item.group.id));
    const destinations = new Map<string, string | null>();
    for (const node of after) {
        if (!movedIds.has(node.id) || groups.some(group => wholeGroups.has(group.id) && group.nodeIds.includes(node.id))) continue;
        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
        const frame = frames.filter(({ bounds }) => center.x >= bounds.x && center.x <= bounds.x + bounds.width && center.y >= bounds.y && center.y <= bounds.y + bounds.height)
            .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height)[0];
        destinations.set(node.id, frame?.item.group.id || null);
    }
    let changed = false;
    const result = groups.flatMap(group => {
        const ids = group.nodeIds.filter(id => !destinations.has(id) || destinations.get(id) === group.id);
        destinations.forEach((destination, id) => { if (destination === group.id && !ids.includes(id)) ids.push(id); });
        if (ids.length === group.nodeIds.length && ids.every((id, index) => id === group.nodeIds[index])) return [group];
        changed = true;
        return ids.length >= 2 ? [{ ...group, nodeIds: ids }] : [];
    });
    return changed ? result : groups;
}
