import { uiText, useUiLocale } from "@/lib/i18n";
import { lazy, Suspense, memo, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronDown, Download, Globe, Home, Images, Info, LayoutGrid, Plus, Redo2, Trash2, Undo2, Upload } from "lucide-react";
import { Dropdown, Popover } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { UsageCollectionNotice } from "@/components/layout/frequent-navigation";
import { CanvasSaveStatus } from "@/components/canvas/canvas-save-status";
import { canvasActionMenuItem } from "./canvas-action-menu-item";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { canvasTopBarPropsEqual, type CanvasTopBarRenderState } from "@/lib/canvas/canvas-top-bar-render-stability";

const CanvasShortcutsDialog = lazy(() => import("./canvas-shortcuts-dialog").then(module => ({ default: module.CanvasShortcutsDialog })));

export const CanvasTopBar = memo(function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onImportImage,
    onUndo,
    onRedo,
    onExport,
    onExportImages,
    onShare,
    onOpenTools,
    onOpenCommands,
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
}: CanvasTopBarRenderState) {
    useUiLocale();
    const navigate = useNavigate();
    const { id: canvasId } = useParams<{ id: string }>();
    const canImportReferences = useModuleEnabled("reference-import");
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const userName = useUserStore((state) => state.user?.displayName || state.user?.username || uiText("本地工作区"));

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div className="cw-topbar">
                <div className={`cw-project-card cw-surface ${agentOpen ? "is-agent-open" : ""}`}>
                    <Dropdown trigger={["click"]} menu={{ items: [
                        canvasActionMenuItem("home", onHome, <Home className="size-4" />),
                        canvasActionMenuItem("projects", onProjects, <Images className="size-4" />),
                        canvasActionMenuItem("newProject", onCreateProject, <Plus className="size-4" />),
                        canvasActionMenuItem("tools", onOpenTools, <LayoutGrid className="size-4" />),
                        { type: "divider" },
                        canvasActionMenuItem("upload", onImportImage, <Upload className="size-4" />),
                        ...(canImportReferences ? [canvasActionMenuItem("referenceImport", () => navigate(`/reference-import${canvasId ? `?returnTo=${encodeURIComponent(`/canvas/${canvasId}`)}` : ""}`), <Globe className="size-4" />)] : []),
                        canvasActionMenuItem("export", onExport, <Download className="size-4" />),
                        canvasActionMenuItem("exportImages", onExportImages, <Images className="size-4" />),
                        { type: "divider" },
                        canvasActionMenuItem("undo", onUndo, <Undo2 className="size-4" />, !canUndo),
                        canvasActionMenuItem("redo", onRedo, <Redo2 className="size-4" />, !canRedo),
                        canvasActionMenuItem("commands", onOpenCommands),
                        canvasActionMenuItem("shortcuts", () => setShortcutsOpen(true)),
                        { type: "divider" },
                        canvasActionMenuItem("deleteProject", onDeleteProject, <Trash2 className="size-4" />),
                    ] }}>
                        <button type="button" className="cw-icon cw-brand" aria-label={uiText("打开画布菜单")} title={uiText("INCHOICE · 画布菜单")}><InchoiceBrand /><ChevronDown className="size-3 shrink-0" /></button>
                    </Dropdown>
                    <div ref={titleRef} className="cw-project-title">
                        {isTitleEditing ? (
                            <input autoFocus value={titleDraft} onChange={(event) => onTitleDraftChange(event.target.value)} onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => { if (event.key === "Enter") onFinishTitleEditing(); if (event.key === "Escape") onCancelTitleEditing(); }} aria-label={uiText("画布名称")} />
                        ) : (
                            <button type="button" onDoubleClick={onStartTitleEditing} title={uiText("双击修改画布名称")}>{title}</button>
                        )}
                    </div>
                    <CanvasSaveStatus compact />
                    <button type="button" className="cw-share" title={uiText("复制链接；不会公开画布。本机试用跨设备请导出")} onClick={onShare}>{uiText("链接")}</button>
                </div>
                <div className="cw-account-card cw-surface">
                    <LanguageSwitch compact />
                    <span className="cw-account-avatar" aria-hidden="true">{userName.slice(0, 1)}</span>
                    <span className="cw-account-name" title={userName}>{userName}</span>
                    {compactAgentStatus ? <CompactAgentStatus status={compactAgentStatus} onClick={onToggleAgent} /> : null}
                    <Popover trigger="click" placement="bottomRight" content={<div className="cw-workspace-notice"><strong>{uiText("工作区与数据")}</strong><p>{deploymentFeatures.authenticationEnabled ? uiText("画布按当前账号身份保存，链接不等于公开分享。") : uiText("本地试用：画布保存在当前浏览器。更换设备前请导出备份。")}</p><UsageCollectionNotice compact /></div>}><button type="button" className="cw-icon" aria-label={uiText("工作区与使用记录说明")}><Info size={16} /></button></Popover>
                    <UserStatusActions variant="canvas" />
                </div>
            </div>
            {shortcutsOpen ? <Suspense fallback={null}><CanvasShortcutsDialog open onClose={() => setShortcutsOpen(false)} /></Suspense> : null}
        </>
    );
}, canvasTopBarPropsEqual);

function CompactAgentStatus({ status, onClick }: { status: { connected: boolean; enabled: boolean; activity: string }; onClick: () => void }) {
    useUiLocale();
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const label = status.connected ? uiText("已连接到本地 Codex") : status.enabled ? status.activity || uiText("连接中") : uiText("正在连接本地 Codex");
    const dotColor = status.connected ? "#22c55e" : status.enabled ? "#f59e0b" : theme.node.muted;
    return (
        <button
            type="button"
            className="flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium transition hover:opacity-85"
            style={{ background: theme.toolbar.panel, color: theme.node.text, boxShadow: "0 10px 30px rgba(28,25,23,.10)" }}
            onClick={onClick}
            title={uiText("打开本地 Codex 面板")}
        >
            <span className="size-2 rounded-full" style={{ background: dotColor }} />
            <span className="max-w-[180px] truncate">{label}</span>
        </button>
    );
}
