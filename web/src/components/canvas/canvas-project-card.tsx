import { memo, useRef, useState } from "react";
import { Check, Download, Pencil, Trash2, X, LayoutGrid } from "lucide-react";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input } from "antd";

import { loadCanvasProject, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useCanvasExport } from "@/hooks/use-canvas-export";
import type { CanvasProjectSummary } from "@/lib/canvas/canvas-project-summary";

export const CanvasProjectCard = memo(function CanvasProjectCard({ project }: { project: CanvasProjectSummary }) {
    const { message } = App.useApp();
    const exportProjects = useCanvasExport();
    const [renaming, setRenaming] = useState(false);
    const renameLock = useRef(false);
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selected = useCanvasUiStore((state) => state.selectedProjectIds.includes(project.id));
    const editing = useCanvasUiStore((state) => state.editingProjectId === project.id);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectId === project.id ? state.editingProjectTitle : "");
    const exporting = useCanvasUiStore((state) => state.exportingProjectIds.includes(project.id));
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const cover = project.cover;
    const open = () => navigate(`/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`);
    const saveTitle = async () => {
        if (renameLock.current) return;
        renameLock.current = true;
        setRenaming(true);
        try {
            if (!await loadCanvasProject(project.id)) throw new Error("画布已不存在，请刷新后重试。");
            renameProject(project.id, editingTitle);
            if (useCanvasUiStore.getState().editingProjectId === project.id) stopEditing();
        } catch (error) { void message.error(error instanceof Error ? error.message : "重命名失败，请重试。"); }
        finally { renameLock.current = false; setRenaming(false); }
    };

    return (
        <article data-canvas-project-id={project.id} className="wb-surface group flex cursor-pointer flex-col overflow-hidden transition hover:shadow-sm" onClick={() => !editing && open()}>
            <div className="flex h-36 items-center justify-center overflow-hidden border-b border-stone-200/60 bg-stone-100 dark:border-stone-800 dark:bg-stone-800">
                {cover ? <CanvasPersistedMediaPreview kind="image" storageKey={cover.storageKey} url={cover.content} alt={project.title} className="h-full w-full object-cover" /> : <LayoutGrid size={28} className="text-stone-400" />}
            </div>
            <div className="p-4">
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    className="mt-1 size-4 accent-stone-950 dark:accent-stone-100"
                    aria-label={`选择 ${project.title}`}
                />
                {editing ? (
                    <Input className="min-w-0" disabled={renaming} value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveTitle(); }} autoFocus />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="truncate text-base font-semibold">{project.title}</h2>
                        <p className="mt-1 text-xs leading-6 text-stone-500 dark:text-stone-400">
                            {project.nodeCount} 个节点 · {project.connectionCount} 条连线
                        </p>
                    </button>
                )}
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
                <p className="text-xs text-stone-500">更新于 {new Date(project.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" loading={renaming} icon={<Check className="size-4" />} onClick={() => void saveTitle()} aria-label="保存名称" />
                            <Button type="text" size="small" shape="circle" disabled={renaming} icon={<X className="size-4" />} onClick={stopEditing} aria-label="取消重命名" />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" loading={exporting} icon={<Download className="size-4" />} onClick={() => void exportProjects([project.id], project.title || "无线画布")} aria-label="导出" />
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label="重命名" />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label="删除" />
                        </>
                    )}
                </div>
            </div>
            </div>
        </article>
    );
});
