import { forwardRef, memo, useImperativeHandle, useRef, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, FolderOpen, PencilLine, Ungroup } from "lucide-react";
import { canvasGroupBounds, type ResolvedCanvasGroup } from "@/lib/canvas/canvas-node-groups";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasGroupLayerHandle = { refresh: () => void };
type Props = {
    groups: ResolvedCanvasGroup[];
    selectedIds: ReadonlySet<string>;
    theme: CanvasTheme;
    resolveNode: (id: string) => CanvasNodeData | undefined;
    onMove: (event: MouseEvent, groupId: string) => void;
    onSelect: (groupId: string) => void;
    onRename: (groupId: string) => void;
    onToggle: (groupId: string) => void;
    onUngroup: (groupId: string) => void;
};

/** Frames follow the existing imperative drag preview, without rendering the whole editor per pointer event. */
export const CanvasGroupLayer = memo(forwardRef<CanvasGroupLayerHandle, Props>(function CanvasGroupLayer({ groups, selectedIds, theme, resolveNode, onMove, onSelect, onRename, onToggle, onUngroup }, ref) {
    const elements = useRef(new Map<string, HTMLDivElement>());
    useImperativeHandle(ref, () => ({ refresh() {
        for (const item of groups) {
            const element = elements.current.get(item.group.id);
            const bounds = canvasGroupBounds(item, resolveNode);
            if (!element || !bounds) continue;
            element.style.transform = `translate(${bounds.x}px, ${bounds.y}px)`;
            element.style.width = `${bounds.width}px`;
            element.style.height = `${bounds.height}px`;
        }
    } }), [groups, resolveNode]);

    return <>
        {groups.map(item => {
            const { group, nodeIds } = item;
            const bounds = canvasGroupBounds(item, resolveNode);
            if (!bounds) return null;
            const selected = [...nodeIds].every(id => selectedIds.has(id));
            return <div
                key={group.id}
                ref={element => { if (element) elements.current.set(group.id, element); else elements.current.delete(group.id); }}
                data-canvas-group-id={group.id}
                data-group-collapsed={group.collapsed ? "true" : "false"}
                className="pointer-events-none absolute left-0 top-0 rounded-lg border border-dashed"
                style={{ transform: `translate(${bounds.x}px, ${bounds.y}px)`, width: bounds.width, height: bounds.height, borderColor: selected ? theme.canvas.selectionStroke : theme.node.stroke, background: group.collapsed ? theme.node.panel : "transparent", zIndex: 1 }}
            >
                <div className="pointer-events-auto flex h-10 min-w-0 items-center gap-1 px-2" style={{ color: theme.node.muted }} onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
                    <button type="button" title={group.collapsed ? "展开款式组" : "折叠款式组（内容和连线仍保留）"} aria-label={`${group.collapsed ? "展开" : "折叠"}款式组 ${group.title}`} aria-expanded={!group.collapsed} className="shrink-0 rounded p-1 hover:opacity-70" onClick={() => onToggle(group.id)}>
                        {group.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    </button>
                    <button type="button" title="拖动标题整体移动；双击重命名" aria-label={`选择款式组 ${group.title}`} className="flex min-w-0 flex-1 cursor-grab items-center gap-2 py-1 text-left text-xs active:cursor-grabbing" onMouseDown={event => { if (event.button === 0) onMove(event, group.id); }} onClick={event => { if (event.detail === 0) onSelect(group.id); }} onDoubleClick={() => onRename(group.id)}>
                        <FolderOpen size={14} className="shrink-0" />
                        <span className="truncate font-medium" style={{ color: theme.node.text }}>{group.title}</span>
                        <span className="shrink-0 opacity-70">{nodeIds.size}</span>
                    </button>
                    <button type="button" title="重命名款式组" aria-label={`重命名款式组 ${group.title}`} className="shrink-0 rounded p-1 hover:opacity-70" onClick={() => onRename(group.id)}><PencilLine size={14} /></button>
                    <button type="button" title="取消分组，保留全部内容" aria-label={`取消分组 ${group.title}`} className="shrink-0 rounded p-1 hover:opacity-70" onClick={() => onUngroup(group.id)}><Ungroup size={14} /></button>
                </div>
            </div>;
        })}
    </>;
}));
