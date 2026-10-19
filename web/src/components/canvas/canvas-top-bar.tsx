import { memo, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronDown, Download, Globe, Home, Images, Info, LayoutGrid, Plus, Redo2, Trash2, Undo2, Upload } from "lucide-react";
import { Dropdown, Modal, Popover } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { UsageCollectionNotice } from "@/components/layout/frequent-navigation";
import { CanvasSaveStatus } from "@/components/canvas/canvas-save-status";
import { canvasTopBarPropsEqual, type CanvasTopBarRenderState } from "@/lib/canvas/canvas-top-bar-render-stability";

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
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
}: CanvasTopBarRenderState) {
    const navigate = useNavigate();
    const { id: canvasId } = useParams<{ id: string }>();
    const canImportReferences = useModuleEnabled("reference-import");
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const userName = useUserStore((state) => state.user?.displayName || state.user?.username || "本地工作区");

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
                        { key: "home", icon: <Home className="size-4" />, label: "主页", onClick: onHome },
                        { key: "projects", icon: <Images className="size-4" />, label: "我的画布", onClick: onProjects },
                        { key: "new", icon: <Plus className="size-4" />, label: "新建画布", onClick: onCreateProject },
                        { key: "tools", icon: <LayoutGrid className="size-4" />, label: "全部工具与板块", onClick: onOpenTools },
                        { type: "divider" },
                        { key: "import", icon: <Upload className="size-4" />, label: "导入素材", onClick: onImportImage },
                        ...(canImportReferences ? [{ key: "web-import", icon: <Globe className="size-4" />, label: "网页参考图采集", onClick: () => navigate(`/reference-import${canvasId ? `?returnTo=${encodeURIComponent(`/canvas/${canvasId}`)}` : ""}`) }] : []),
                        { key: "export", icon: <Download className="size-4" />, label: "导出画布", onClick: onExport },
                        { key: "export-images", icon: <Images className="size-4" />, label: "导出图片集 / PDF", onClick: onExportImages },
                        { type: "divider" },
                        { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text="撤销" shortcut="Ctrl Z" />, onClick: onUndo },
                        { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text="重做" shortcut="Ctrl Shift Z" />, onClick: onRedo },
                        { key: "shortcuts", label: "快捷键", onClick: () => setShortcutsOpen(true) },
                        { type: "divider" },
                        { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: "删除当前画布", onClick: onDeleteProject },
                    ] }}>
                        <button type="button" className="cw-icon cw-brand" aria-label="打开画布菜单"><span>V</span><ChevronDown className="size-3" /></button>
                    </Dropdown>
                    <div ref={titleRef} className="cw-project-title">
                        {isTitleEditing ? (
                            <input autoFocus value={titleDraft} onChange={(event) => onTitleDraftChange(event.target.value)} onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => { if (event.key === "Enter") onFinishTitleEditing(); if (event.key === "Escape") onCancelTitleEditing(); }} aria-label="画布名称" />
                        ) : (
                            <button type="button" onDoubleClick={onStartTitleEditing} title="双击修改画布名称">{title}</button>
                        )}
                    </div>
                    <CanvasSaveStatus compact />
                    <button type="button" className="cw-share" title="复制链接；不会公开画布。本机试用跨设备请导出" onClick={onShare}>链接</button>
                </div>
                <div className="cw-account-card cw-surface">
                    <span className="cw-account-avatar" aria-hidden="true">{userName.slice(0, 1)}</span>
                    <span className="cw-account-name" title={userName}>{userName}</span>
                    {compactAgentStatus ? <CompactAgentStatus status={compactAgentStatus} onClick={onToggleAgent} /> : null}
                    <Popover trigger="click" placement="bottomRight" content={<div className="cw-workspace-notice"><strong>工作区与数据</strong><p>{deploymentFeatures.authenticationEnabled ? "画布按当前账号身份保存，链接不等于公开分享。" : "本地试用：画布保存在当前浏览器。更换设备前请导出备份。"}</p><UsageCollectionNotice compact /></div>}><button type="button" className="cw-icon" aria-label="工作区与使用记录说明"><Info size={16} /></button></Popover>
                    <UserStatusActions variant="canvas" />
                </div>
            </div>
            <Modal title="快捷键" open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["手形工具 / 空格 + 拖动"]} value="平移视图" />
                    <Shortcut keys={["滚轮"]} value="缩放画布" />
                    <Shortcut keys={["缩放滑杆"]} value="精确调整缩放" />
                    <Shortcut keys={["选择工具 + 空白处拖动"]} value="框选多个节点" />
                    <Shortcut keys={["Shift / Ctrl / Cmd", "点击"]} value="追加选择节点" />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value="全选节点" />
                    <Shortcut keys={["Ctrl / Cmd", "G"]} value="创建款式组" />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value="复制 / 粘贴节点，或粘贴剪切板文本/图片" />
                    <Shortcut keys={["Ctrl / Cmd", "X"]} value="剪切选中节点" />
                    <Shortcut keys={["Ctrl / Cmd", "D"]} value="快速复制选中节点" />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value="撤销" />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value="重做" />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value="重做" />
                    <Shortcut keys={["Delete / Backspace"]} value="删除选中" />
                    <Shortcut keys={["Esc"]} value="取消选择并关闭浮层" />
                    <Shortcut keys={["拖入图片/视频/音频"]} value="上传到画布" />
                </div>
            </Modal>
        </>
    );
}, canvasTopBarPropsEqual);

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function CompactAgentStatus({ status, onClick }: { status: { connected: boolean; enabled: boolean; activity: string }; onClick: () => void }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const label = status.connected ? "已连接到本地 Codex" : status.enabled ? status.activity || "连接中" : "正在连接本地 Codex";
    const dotColor = status.connected ? "#22c55e" : status.enabled ? "#f59e0b" : theme.node.muted;
    return (
        <button
            type="button"
            className="flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium transition hover:opacity-85"
            style={{ background: theme.toolbar.panel, color: theme.node.text, boxShadow: "0 10px 30px rgba(28,25,23,.10)" }}
            onClick={onClick}
            title="打开本地 Codex 面板"
        >
            <span className="size-2 rounded-full" style={{ background: dotColor }} />
            <span className="max-w-[180px] truncate">{label}</span>
        </button>
    );
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-6 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2.5 py-1.5 text-center text-xs font-medium leading-none shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: "rgba(120,113,108,.28)", background: "linear-gradient(#fff, rgba(245,245,244,.92))", color: "rgb(68,64,60)" }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{value}</span>
        </div>
    );
}
