import type { CanvasHistorySnapshot } from "@/stores/canvas/use-canvas-store";

// Avoid serializing image strings; expanded imports can have equivalent values
// with different object identities, unlike live structurally shared snapshots.
function sameValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
        && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every(key => sameValue(a[key], b[key]));
}

/** Describe the original command; undo and redo use the same before/after order. */
export function describeCanvasHistoryChange(before: CanvasHistorySnapshot, after: CanvasHistorySnapshot): string {
    const previous = new Map(before.nodes.map(node => [node.id, node]));
    const next = new Map(after.nodes.map(node => [node.id, node]));
    const added = after.nodes.filter(node => !previous.has(node.id));
    const removed = before.nodes.filter(node => !next.has(node.id));
    const changed = after.nodes.filter(node => previous.has(node.id) && !sameValue(previous.get(node.id), node));
    const actions: string[] = [];
    if (added.length) actions.push(`新增 ${added.length} 个节点`);
    if (removed.length) actions.push(`删除 ${removed.length} 个节点`);
    if (changed.length) {
        const movedOnly = changed.every(node => {
            const { position: oldPosition, ...oldFields } = previous.get(node.id)!;
            const { position, ...fields } = node;
            return !sameValue(oldPosition, position) && sameValue(oldFields, fields);
        });
        const resizedOnly = changed.every(node => {
            const { position: _oldPosition, width: oldWidth, height: oldHeight, ...oldFields } = previous.get(node.id)!;
            const { position: _position, width, height, ...fields } = node;
            return (oldWidth !== width || oldHeight !== height) && sameValue(oldFields, fields);
        });
        actions.push(movedOnly ? `移动 ${changed.length} 个节点`
            : resizedOnly ? `调整 ${changed.length} 个节点大小`
                : changed.every(node => node.type === "config") ? `调整 ${changed.length} 个配置节点`
                    : `修改 ${changed.length} 个节点`);
    }
    if (!actions.length) {
        if (!sameValue(before.groups || [], after.groups || [])) actions.push("调整分组");
        if (!sameValue(before.connections, after.connections)) actions.push("调整连线");
        if (before.backgroundMode !== after.backgroundMode) actions.push("切换画布背景");
        if (before.showImageInfo !== after.showImageInfo) actions.push("切换图片信息显示");
        if (before.nodes.some((node, index) => after.nodes[index]?.id !== node.id)) actions.push("调整节点顺序");
    }
    return actions.join("、") || "修改画布";
}
