/** Shared discovery/shortcut metadata. Execution stays in the owning canvas callbacks. */
export const canvasActions = [
    { id: "undo", label: "撤销", keywords: "undo", key: "z" },
    { id: "redo", label: "重做", keywords: "redo", key: "z", shift: true },
    { id: "duplicate", label: "快速复制选中节点", keywords: "duplicate", key: "d" },
    { id: "delete", label: "删除选中", keywords: "delete", key: "Delete", plain: true },
    { id: "group", label: "创建款式组", keywords: "分组 group", key: "g" },
    { id: "selectAll", label: "全选节点", keywords: "select", key: "a" },
    { id: "commands", label: "搜索命令、节点和素材", keywords: "command search", key: "k" },
] as const;
export type CanvasShortcutActionId = typeof canvasActions[number]["id"];
export type CanvasActionId = CanvasShortcutActionId | "upload" | "text" | "image" | "video" | "audio" | "config" | "generate" | "batch" | "assets" | "designTemplate" | "compare" | "resetView" | "minimap" | "export" | "tools" | "guide";
type Shortcut = { id: string; key?: string; shift?: boolean; plain?: boolean };
type KeyEvent = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };
export function canvasActionShortcut(id: string) {
    const action: Shortcut | undefined = canvasActions.find(action => action.id === id);
    return !action?.key ? "" : action.plain ? "Delete / Backspace" : `Ctrl / Cmd + ${action.shift ? "Shift + " : ""}${action.key.toUpperCase()}`;
}
export function canvasActionHint(id: CanvasShortcutActionId) {
    const action = canvasActions.find(action => action.id === id)!;
    const shortcut = canvasActionShortcut(id);
    return `${action.label}${shortcut ? `（${shortcut}）` : ""}`;
}
export function matchCanvasActionShortcut(event: KeyEvent): CanvasShortcutActionId | undefined {
    if (event.altKey) return;
    const modifier = Boolean(event.ctrlKey || event.metaKey);
    if (modifier && event.key.toLowerCase() === "y" && !event.shiftKey) return "redo";
    if (!modifier && !event.shiftKey && event.key === "Backspace") return "delete";
    return canvasActions.find(item => {
        const action: Shortcut = item;
        return action.key?.toLowerCase() === event.key.toLowerCase() && Boolean(action.shift) === Boolean(event.shiftKey) && Boolean(action.plain) !== modifier;
    })?.id;
}
export function filterCanvasCommands<T extends { label: string; keywords?: string; enabled?: boolean }>(items: readonly T[], query: string): T[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => item.enabled !== false && terms.every(term => `${item.label} ${item.keywords || ""}`.toLowerCase().includes(term)));
}
export function canvasNodeKeyAction(event: KeyEvent): { x: number; y: number } | "edit" | null {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    if (event.key === "Enter") return "edit";
    const distance = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") return { x: -distance, y: 0 };
    if (event.key === "ArrowRight") return { x: distance, y: 0 };
    if (event.key === "ArrowUp") return { x: 0, y: -distance };
    if (event.key === "ArrowDown") return { x: 0, y: distance };
    return null;
}
