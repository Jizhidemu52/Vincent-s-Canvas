import type { CanvasNodeData, CanvasNodeGroup } from "@/types/canvas";
import type { CanvasArrangeMode } from "./canvas-node-arrange-options";
export { canvasArrangeOptions, type CanvasArrangeMode } from "./canvas-node-arrange-options";

/** A group or batch is one movable unit, including when only one member is selected. */
export function arrangeCanvasNodes(nodes: CanvasNodeData[], groups: CanvasNodeGroup[], selected: ReadonlySet<string>, mode: CanvasArrangeMode, gap = 80) {
    const parents = new Map(nodes.map(node => [node.id, node.id]));
    const find = (id: string): string => { const parent = parents.get(id)!; if (parent === id) return id; const root = find(parent); parents.set(id, root); return root; };
    const unite = (ids: string[]) => { const existing = ids.filter(id => parents.has(id)); if (!existing.length) return; const root = find(existing[0]); existing.forEach(id => parents.set(find(id), root)); };
    groups.forEach(group => unite(group.nodeIds));
    nodes.forEach(node => { if (node.metadata?.isBatchRoot) unite([node.id, ...(node.metadata.batchChildIds || [])]); if (node.metadata?.batchRootId) unite([node.id, node.metadata.batchRootId]); });
    const units = new Map<string, CanvasNodeData[]>();
    nodes.forEach(node => { const key = find(node.id); const members = units.get(key); if (members) members.push(node); else units.set(key, [node]); });
    const moving = [...units.values()].filter(members => !members.some(node => node.metadata?.locked) && (!selected.size || members.some(node => selected.has(node.id)))).map(members => {
        const x = Math.min(...members.map(node => node.position.x));
        const y = Math.min(...members.map(node => node.position.y));
        return { members, x, y, width: Math.max(...members.map(node => node.position.x + node.width)) - x, height: Math.max(...members.map(node => node.position.y + node.height)) - y };
    });
    if (moving.length < 2) return nodes;
    const left = Math.min(...moving.map(unit => unit.x)), top = Math.min(...moving.map(unit => unit.y));
    const right = Math.max(...moving.map(unit => unit.x + unit.width)), bottom = Math.max(...moving.map(unit => unit.y + unit.height));
    const deltas = new Map<string, { x: number; y: number }>();
    const ordered = moving.sort((a, b) => mode === "distribute-x" ? a.x - b.x : mode === "distribute-y" ? a.y - b.y : a.y - b.y || a.x - b.x);
    const columns = Math.ceil(Math.sqrt(moving.length));
    const cellWidth = Math.max(...moving.map(unit => unit.width)) + gap;
    const cellHeight = Math.max(...moving.map(unit => unit.height)) + gap;
    const axis = mode === "distribute-x" || mode === "row" ? "x" : "y";
    const dimension = axis === "x" ? "width" : "height";
    const spacing = Math.max(gap, (Math.max(...moving.map(unit => unit[axis] + unit[dimension])) - Math.min(...moving.map(unit => unit[axis])) - moving.reduce((sum, unit) => sum + unit[dimension], 0)) / (moving.length - 1));
    let cursor = axis === "x" ? left : top;
    const occupied: { x: number; y: number; width: number; height: number }[] = [];
    ordered.forEach((unit, index) => {
        let x = unit.x, y = unit.y;
        if (mode === "grid") { x = left + (index % columns) * cellWidth; y = top + Math.floor(index / columns) * cellHeight; }
        if (mode === "horizontal") y = top;
        if (mode === "vertical") x = left;
        if (mode === "right") x = right - unit.width;
        if (mode === "bottom") y = bottom - unit.height;
        if (mode === "center-x") x = (left + right - unit.width) / 2;
        if (mode === "center-y") y = (top + bottom - unit.height) / 2;
        if (mode === "row") { x = cursor; y = top; }
        if (mode === "column") { y = cursor; x = left; }
        if (mode === "distribute-x") x = cursor;
        if (mode === "distribute-y") y = cursor;
        const alignedX = ["vertical", "right", "center-x"].includes(mode);
        const alignedY = ["horizontal", "bottom", "center-y"].includes(mode);
        if (alignedX || alignedY) for (const placed of occupied) {
            if (x < placed.x + placed.width && x + unit.width > placed.x && y < placed.y + placed.height && y + unit.height > placed.y) {
                if (alignedX) y = placed.y + placed.height + gap; else x = placed.x + placed.width + gap;
            }
        }
        occupied.push({ x, y, width: unit.width, height: unit.height });
        cursor += unit[dimension] + spacing;
        unit.members.forEach(node => deltas.set(node.id, { x: x - unit.x, y: y - unit.y }));
    });
    let changed = false;
    const result = nodes.map(node => { const delta = deltas.get(node.id); if (!delta || (!delta.x && !delta.y)) return node; changed = true; return { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } }; });
    return changed ? result : nodes;
}
