import { uiText, useUiLocale } from "@/lib/i18n";
import { lazy, Suspense, memo, useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Check, Download, Images, Info, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Dropdown, Popover, Tooltip } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { UsageCollectionNotice } from "@/components/layout/frequent-navigation";
import { CanvasSaveStatus } from "@/components/canvas/canvas-save-status";
import { canvasActionMenuItem } from "./canvas-action-menu-item";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { canvasTopBarPropsEqual, type CanvasTopBarRenderState } from "@/lib/canvas/canvas-top-bar-render-stability";

const CanvasShortcutsDialog = lazy(() => import("./canvas-shortcuts-dialog").then(module => ({ default: module.CanvasShortcutsDialog })));
const UserStatusActions = lazy(() => import("@/components/layout/user-status-actions").then(module => ({ default: module.UserStatusActions })));
type TopBarProps = Omit<CanvasTopBarRenderState, "onShare"> & { onShare: () => void | boolean | Promise<void | boolean>; onOpenOnboarding?: () => void };

export const CanvasTopBar = memo(function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    onProjects,
    onCreateProject,
    onOpenExamples,
    onDeleteProject,
    onExport,
    onExportImages,
    onShare,
    onOpenCommands,
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
    onOpenOnboarding,
}: TopBarProps) {
    const locale = useUiLocale();
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
    const copyLink = async () => {
        if (await onShare() !== true) return;
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1200);
    };
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
                <div className={`cw-project-card ${agentOpen ? "is-agent-open" : ""}`}>
                    <button type="button" className="cw-icon cw-back" aria-label={uiText("返回画布列表")} onClick={onProjects}><ArrowLeft className="size-4" /></button>
                    <Dropdown trigger={["click"]} styles={{ root: { zIndex: 900 } }} menu={{ items: [
                        canvasActionMenuItem("newProject", onCreateProject, <Plus className="size-4" />),
                        canvasActionMenuItem("renameProject", onStartTitleEditing),
                        canvasActionMenuItem("export", onExport, <Download className="size-4" />),
                        canvasActionMenuItem("exportImages", onExportImages, <Images className="size-4" />),
                        { type: "divider" },
                        canvasActionMenuItem("commands", onOpenCommands),
                        canvasActionMenuItem("shortcuts", () => setShortcutsOpen(true)),
                        ...(onOpenOnboarding ? [{ key: "onboarding", icon: <BookOpen className="size-4" />, label: locale === "en-US" ? "Quick start guide" : "新手引导", onClick: onOpenOnboarding }] : []),
                        ...(onOpenExamples ? [canvasActionMenuItem("examples", onOpenExamples, <BookOpen className="size-4" />)] : []),
                        { type: "divider" },
                        canvasActionMenuItem("deleteProject", onDeleteProject, <Trash2 className="size-4" />),
                    ] }}>
                        <Tooltip title={locale === "en-US" ? "Canvas file and help" : "画布文件与帮助"}><button type="button" className="cw-icon cw-file-menu" aria-label={uiText("打开画布菜单")}><MoreHorizontal className="size-4" /></button></Tooltip>
                    </Dropdown>
                    <div ref={titleRef} className="cw-project-title">
                        {isTitleEditing ? (
                            <input autoFocus value={titleDraft} onChange={(event) => onTitleDraftChange(event.target.value)} onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") onFinishTitleEditing(); if (event.key === "Escape") onCancelTitleEditing(); }} aria-label={uiText("画布名称")} />
                        ) : (
                            <Tooltip title={uiText("点击或按 Enter 修改画布名称")}><button type="button" onClick={onStartTitleEditing} onKeyDown={event => { if (event.key === "F2") { event.preventDefault(); onStartTitleEditing(); } }}><span>{title}</span><Pencil className="cw-title-pencil size-3" aria-hidden /></button></Tooltip>
                        )}
                    </div>
                    <CanvasSaveStatus compact />
                    <Tooltip title={uiText("复制链接；不会公开画布。本机试用跨设备请导出")}><button type="button" className="cw-share" aria-live="polite" onClick={() => void copyLink()}>{copied ? <><Check size={14} />{uiText("已复制")}</> : (locale === "en-US" ? "Copy link" : "复制链接")}</button></Tooltip>
                </div>
                <div className="cw-account-card">
                    <LanguageSwitch compact />
                    <span className="cw-account-avatar" aria-hidden="true">{userName.slice(0, 1)}</span>
                    <Tooltip title={userName}><span className="cw-account-name">{userName}</span></Tooltip>
                    {compactAgentStatus ? <CompactAgentStatus status={compactAgentStatus} onClick={onToggleAgent} /> : null}
                    <Popover trigger="click" placement="bottomRight" content={<div className="cw-workspace-notice"><strong>{uiText("工作区与数据")}</strong><p>{deploymentFeatures.authenticationEnabled ? uiText("画布按当前账号身份保存，链接不等于公开分享。") : uiText("本地试用：画布保存在当前浏览器。更换设备前请导出备份。")}</p><UsageCollectionNotice compact /></div>}><button type="button" className="cw-icon" aria-label={uiText("工作区与使用记录说明")}><Info size={16} /></button></Popover>
                    <Suspense fallback={null}><UserStatusActions variant="canvas" /></Suspense>
                </div>
            </div>
            {shortcutsOpen ? <Suspense fallback={null}><CanvasShortcutsDialog open onClose={() => setShortcutsOpen(false)} /></Suspense> : null}
        </>
    );
}, (previous, next) => canvasTopBarPropsEqual(previous, next) && previous.onOpenOnboarding === next.onOpenOnboarding);

function CompactAgentStatus({ status, onClick }: { status: { connected: boolean; enabled: boolean; activity: string }; onClick: () => void }) {
    useUiLocale();
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const label = status.connected ? uiText("已连接本机助手") : status.enabled ? status.activity || uiText("连接中") : uiText("本机助手未连接");
    const dotColor = status.connected ? theme.node.success : status.enabled ? theme.node.warning : theme.node.muted;
    return (
        <Tooltip title={uiText("打开本机助手面板")}><button
            type="button"
            className="cw-text-button"
            style={{ color: theme.node.text }}
            onClick={onClick}
        >
            <span className="size-2 rounded-full" style={{ background: dotColor }} />
            <span className="max-w-[180px] truncate">{label}</span>
        </button></Tooltip>
    );
}
