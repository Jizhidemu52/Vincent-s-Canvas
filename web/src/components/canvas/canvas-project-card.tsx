import { useUiLocale, useUiText } from "@/lib/i18n";
import { memo, useId, useRef, useState } from "react";
import { Check, Copy, Download, Image, Pencil, Trash2, X, LayoutGrid } from "lucide-react";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input, Tag, Tooltip } from "antd";

import { loadCanvasProject, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useCanvasExport } from "@/hooks/use-canvas-export";
import type { CanvasProjectSummary } from "@/lib/canvas/canvas-project-summary";
import { formatCanvasProjectTime } from "@/lib/canvas/canvas-library-ux";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasProjectCoverDialog } from "./canvas-project-cover-dialog";
import { CanvasConflictCompareDialog } from "./canvas-conflict-compare-dialog";
import { DisplayText, useDisplayText } from "@/hooks/use-display-text";

export const CanvasProjectCard = memo(function CanvasProjectCard({ project }: { project: CanvasProjectSummary }) {
    const t = useUiText();
    const display = useDisplayText();
    const locale = useUiLocale();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { message } = App.useApp();
    const exportProjects = useCanvasExport();
    const [renaming, setRenaming] = useState(false);
    const renameLock = useRef(false);
    const actionLock = useRef(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState("");
    const [actionNotice, setActionNotice] = useState("");
    const [renameError, setRenameError] = useState("");
    const renameErrorId = useId();
    const [coverProject, setCoverProject] = useState<CanvasProject | null>(null);
    const [comparison, setComparison] = useState<{ original: CanvasProject | null; copy: CanvasProject } | null>(null);
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
        if (renameLock.current || useCanvasUiStore.getState().editingProjectId !== project.id) return;
        if (!editingTitle.trim() || editingTitle.trim() === project.title) { stopEditing(); return; }
        renameLock.current = true;
        setRenaming(true);
        setRenameError("");
        try {
            if (!await loadCanvasProject(project.id)) throw new Error("画布已不存在，请刷新后重试。");
            renameProject(project.id, editingTitle);
            if (useCanvasUiStore.getState().editingProjectId === project.id) stopEditing();
        } catch (error) { setRenameError(error instanceof Error ? error.message : t("重命名失败，请重试。")); }
        finally { renameLock.current = false; setRenaming(false); }
    };
    const act = async (action: () => Promise<void>) => {
        if (actionLock.current) return;
        actionLock.current = true; setBusy(true); setActionError(""); setActionNotice("");
        try { await action(); }
        catch (error) { setActionError(error instanceof Error ? error.message : t("操作失败，请重试。")); }
        finally { actionLock.current = false; setBusy(false); }
    };
    const loaded = async () => {
        const value = await loadCanvasProject(project.id);
        if (!value) throw new Error(t("画布已不存在，请刷新后重试。"));
        return value;
    };
    const keepCopy = async () => {
        await loaded();
        useCanvasStore.getState().updateProject(project.id, { persistenceConflict: undefined });
        renameProject(project.id, project.title.replace(/（(?:云端|保存)?冲突副本）/g, "（保留版本）"));
        setActionNotice(t("已保留为独立画布，另一版本不受影响"));
    };

    return (
        <article data-canvas-project-id={project.id} data-selected={selected ? "true" : "false"} className="wb-surface wb-list-card group flex cursor-pointer flex-col overflow-hidden" style={selected ? { outline: `2px solid ${theme.canvas.selectionStroke}`, outlineOffset: 2 } : undefined} onClick={() => !editing && open()}>
            <div className="flex h-36 items-center justify-center overflow-hidden border-b" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.muted }}>
                {cover ? <CanvasPersistedMediaPreview kind="image" storageKey={cover.storageKey} url={cover.content} alt={display(project.title)} className="h-full w-full object-cover" /> : <LayoutGrid size={28} />}
            </div>
            <div className="p-4">
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    className="mt-1 size-4"
                    style={{ accentColor: theme.node.activeStroke }}
                    aria-label={t("选择 {value1}", { value1: display(project.title) })}
                />
                {editing ? (
                    <Input className="min-w-0" aria-label={t("画布名称")} aria-invalid={Boolean(renameError)} aria-describedby={renameError ? renameErrorId : undefined} status={renameError ? "error" : undefined} disabled={renaming} value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => { setRenameError(""); setEditingTitle(event.target.value); }} onBlur={() => void saveTitle()} onKeyDown={(event) => {
                        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stopEditing(); }
                        if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void saveTitle(); }
                    }} autoFocus />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="truncate text-base font-semibold">{display(project.title)}</h2>
                        {project.persistenceConflict ? <Tag color="warning">{t("冲突副本 · 原版本已保留")}</Tag> : null}
                        <p className="mt-1 text-[13px] leading-6" style={{ color: theme.node.muted }}>
                            {t("{nodes} 个节点 · {connections} 条连线", { nodes: project.nodeCount, connections: project.connectionCount })}</p>
                    </button>
                )}
            </div>
            {renameError ? <p id={renameErrorId} role="alert" className="mt-2 text-[13px]" style={{ color: theme.node.danger }}>{display(renameError)}</p> : null}
            {project.persistenceConflict ? <div className="mt-3 flex gap-2" onClick={event => event.stopPropagation()}>
                <Button size="small" loading={busy} onClick={() => void act(async () => { const copy = await loaded(); const original = copy.persistenceConflict ? await loadCanvasProject(copy.persistenceConflict.projectId) : null; setComparison({ original, copy }); })}>{t("对比版本")}</Button>
                <Tooltip title={busy ? t("正在处理图片或项目，请稍候…") : undefined}><Button size="small" disabled={busy} onClick={() => void act(keepCopy)}>{t("保留此版本")}</Button></Tooltip>
            </div> : null}
            <div className="mt-4 flex items-center justify-between gap-2">
                <Tooltip title={new Date(project.updatedAt).toLocaleString(locale)}><p className="min-w-0 text-xs" style={{ color: theme.node.muted }}>{t("更新于 {time}", { time: formatCanvasProjectTime(project.updatedAt, locale) })}</p></Tooltip>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" loading={renaming} icon={<Check className="size-4" />} onMouseDown={event => event.preventDefault()} onClick={() => void saveTitle()} aria-label={t("保存名称")} />
                            <Tooltip title={renaming ? t("正在保存…") : t("取消重命名")}><Button type="text" size="small" shape="circle" disabled={renaming} icon={<X className="size-4" />} onMouseDown={event => event.preventDefault()} onClick={stopEditing} aria-label={t("取消重命名")} /></Tooltip>
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" loading={exporting} icon={<Download className="size-4" />} onClick={() => void exportProjects([project.id], project.title || t("自由画布"))} aria-label={t("导出")} />
                            <Tooltip title={busy ? t("正在处理图片或项目，请稍候…") : t("创建副本")}><Button type="text" size="small" shape="circle" disabled={busy} icon={<Copy className="size-4" />} onClick={() => void act(async () => { await loaded(); if (!useCanvasStore.getState().duplicateProject(project.id)) throw new Error(t("画布已不存在，请刷新后重试。")); setActionNotice(t("已创建副本，原画布未修改")); })} aria-label={t("创建副本")} /></Tooltip>
                            <Tooltip title={busy ? t("正在处理图片或项目，请稍候…") : t("设置封面")}><Button type="text" size="small" shape="circle" disabled={busy} icon={<Image className="size-4" />} onClick={() => void act(async () => setCoverProject(await loaded()))} aria-label={t("设置封面")} /></Tooltip>
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label={t("重命名")} />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label={t("删除")} />
                        </>
                    )}
                </div>
            </div>
            {actionError ? <p role="alert" className="mt-2 text-[13px]" style={{ color: theme.node.danger }}>{display(actionError)}</p> : null}
            {actionNotice ? <p role="status" className="mt-2 text-[13px]" style={{ color: theme.node.muted }}>{display(actionNotice)}</p> : null}
            </div>
            <div onClick={event => event.stopPropagation()}>
                {coverProject ? <CanvasProjectCoverDialog project={coverProject} onClose={() => setCoverProject(null)} /> : null}
                {comparison ? <CanvasConflictCompareDialog {...comparison} onClose={() => setComparison(null)} onKeep={async () => { try { await keepCopy(); } catch (error) { message.error(<DisplayText text={error instanceof Error ? error.message : t("保存失败，请重试")} />); throw error; } }} /> : null}
            </div>
        </article>
    );
});
