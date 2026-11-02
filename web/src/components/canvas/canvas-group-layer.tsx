import { useUiText, uiText } from "@/lib/i18n";
import { forwardRef, memo, useImperativeHandle, useRef, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, FolderOpen, PencilLine, Ungroup, Workflow } from "lucide-react";
import { canvasGroupVisualBounds, type ResolvedCanvasGroup } from "@/lib/canvas/canvas-node-groups";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import { Dropdown } from "antd";

export type CanvasGroupLayerHandle = { refresh: () => void; highlight: (groupId: string | null) => void };
type Props = {
    groups: ResolvedCanvasGroup[];
    selectedIds: ReadonlySet<string>;
    theme: CanvasTheme;
    scale?: number;
    resolveNode: (id: string) => CanvasNodeData | undefined;
    onMove: (event: MouseEvent, groupId: string) => void;
    onSelect: (groupId: string) => void;
    onRename: (groupId: string) => void;
    onToggle: (groupId: string) => void;
    onUngroup: (groupId: string) => void;
    onDuplicate?: (nodeIds: ReadonlySet<string>) => void;
    onDelete?: (nodeIds: ReadonlySet<string>) => void;
    onImageSequence?: (groupId: string) => void;
};

/** Frames follow the existing imperative drag preview, without rendering the whole editor per pointer event. */
export const CanvasGroupLayer = memo(forwardRef<CanvasGroupLayerHandle, Props>(function CanvasGroupLayer({ groups, selectedIds, theme, scale = 1, resolveNode, onMove, onSelect, onRename, onToggle, onUngroup, onDuplicate, onDelete, onImageSequence }, ref) {
    const t = useUiText();
    const elements = useRef(new Map<string, HTMLDivElement>());
    useImperativeHandle(ref, () => ({ refresh() {
        for (const item of groups) {
            const element = elements.current.get(item.group.id);
            const bounds = canvasGroupVisualBounds(item, scale, resolveNode);
            if (!element || !bounds) continue;
            element.style.transform = `translate(${bounds.x}px, ${bounds.y}px)`;
            element.style.width = `${bounds.width}px`;
            element.style.height = `${bounds.height}px`;
        }
    }, highlight(groupId) {
        elements.current.forEach((element, id) => {
            element.dataset.dropTarget = id === groupId ? "true" : "false";
            element.style.boxShadow = id === groupId ? `0 0 0 ${3 / scale}px ${theme.canvas.selectionStroke}` : "none";
        });
    } }), [groups, resolveNode, scale, theme.canvas.selectionStroke]);

    return <>
        {groups.map(item => {
            const { group, nodeIds } = item;
            const bounds = canvasGroupVisualBounds(item, scale, resolveNode);
            if (!bounds) return null;
            const selected = [...nodeIds].every(id => selectedIds.has(id));
            return <div
                key={group.id}
                ref={element => { if (element) elements.current.set(group.id, element); else elements.current.delete(group.id); }}
                data-canvas-group-id={group.id}
                data-group-collapsed={group.collapsed ? "true" : "false"}
                className="pointer-events-none absolute left-0 top-0 rounded-lg border border-dashed"
                style={{ transform: `translate(${bounds.x}px, ${bounds.y}px)`, width: bounds.width, height: bounds.height, borderColor: selected ? theme.canvas.selectionStroke : theme.canvas.groupStroke, background: group.collapsed ? theme.node.panel : "transparent", zIndex: 1 }}
            >
                {!group.collapsed ? <div className="pointer-events-auto absolute inset-x-0 bottom-0 top-10" onPointerDown={event => onMove(event, group.id)} onClick={() => onSelect(group.id)} /> : null}
                <Dropdown trigger={["contextMenu"]} menu={{ items: [
                    { key: "rename", label: t("重命名款式组"), onClick: () => onRename(group.id) },
                    { key: "toggle", label: t(group.collapsed ? "展开款式组" : "折叠款式组"), onClick: () => onToggle(group.id) },
                    { key: "ungroup", label: t("取消分组，保留全部内容"), onClick: () => onUngroup(group.id) },
                    { key: "duplicate", label: t("复制整组"), onClick: () => onDuplicate?.(nodeIds) },
                    { key: "delete", label: t("删除整组"), danger: true, onClick: () => onDelete?.(nodeIds) },
                ] }}>
                <div className="pointer-events-auto flex h-10 min-w-0 items-center gap-1 px-2" style={{ color: theme.node.muted, width: bounds.width * scale, transform: `scale(${1 / Math.max(0.05, scale)})`, transformOrigin: "top left" }} onPointerDown={event => event.stopPropagation()}>
                    <button type="button" title={group.collapsed ? t("展开款式组") : t("折叠款式组（内容和连线仍保留）")} aria-label={t("{value1}款式组 {value2}", { value1: group.collapsed ? uiText("展开") : uiText("折叠"), value2: group.title })} aria-expanded={!group.collapsed} className="shrink-0 rounded p-1 hover:opacity-70" onClick={() => onToggle(group.id)}>
                        {group.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    </button>
                    <button type="button" title={t("拖动标题整体移动；双击重命名")} aria-label={t("选择款式组 {value1}", { value1: group.title })} className="flex min-w-0 flex-1 cursor-grab items-center gap-2 py-1 text-left text-xs active:cursor-grabbing" onPointerDown={event => { if (event.button === 0) onMove(event, group.id); }} onClick={event => { if (event.detail === 0) onSelect(group.id); }} onDoubleClick={() => onRename(group.id)}>
                        <FolderOpen size={14} className="shrink-0" />
                        <span className="truncate font-medium" style={{ color: theme.node.text }}>{group.title}</span>
                        <span className="shrink-0 opacity-70">{nodeIds.size}</span>
                    </button>
                    {group.imageSequence && onImageSequence ? <button type="button" title={t("查看连续改图步骤与运行进度")} aria-label={t("连续改图 {value1}", { value1: group.title })} className="flex shrink-0 items-center gap-1 rounded p-1 text-xs hover:opacity-70" onClick={() => onImageSequence(group.id)}><Workflow size={14} />{group.imageSequence.steps.filter(step => step.status === "success").length}/{group.imageSequence.steps.length}</button> : null}
                    <button type="button" title={t("重命名款式组")} aria-label={t("重命名款式组 {value1}", { value1: group.title })} className="shrink-0 rounded p-1 hover:opacity-70" onClick={() => onRename(group.id)}><PencilLine size={14} /></button>
                    <button type="button" title={t("取消分组，保留全部内容")} aria-label={t("取消分组 {value1}", { value1: group.title })} className="shrink-0 rounded p-1 hover:opacity-70" onClick={() => onUngroup(group.id)}><Ungroup size={14} /></button>
                </div>
                </Dropdown>
            </div>;
        })}
    </>;
}));
