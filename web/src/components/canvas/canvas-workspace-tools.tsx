import { useUiText } from "@/lib/i18n";
import { ArrowUpRight, ChevronRight, Grid2X2, Search, Shapes, Sparkles, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { navigationTools } from "@/constant/navigation-tools";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { canvasWorkspaceTools, filterCanvasWorkspaceTools, type WorkspaceToolEntry } from "./canvas-workspace-tools-model";
import "./canvas-workspace-tools.css";

export type CanvasWorkspaceToolsProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export function CanvasWorkspaceTools({ open, onOpenChange }: CanvasWorkspaceToolsProps) {
    const t = useUiText();
    const navigate = useNavigate();
    const location = useLocation();
    const flags = useModuleStore(state => state.flags);
    const bindings = useBusinessConfigStore(state => state.tools);
    const user = useUserStore(state => state.user);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [query, setQuery] = useState("");
    const [group, setGroup] = useState("全部");
    const searchRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLElement | null>(null);
    const entries = useMemo(() => canvasWorkspaceTools({
        flags, bindings, rolePortalsEnabled: deploymentFeatures.rolePortalsEnabled,
        adminVisible: isAdminRole(user?.role), teamVisible: Boolean(user?.groupId),
    }), [flags, bindings, user?.role, user?.groupId]);
    const groups = ["全部", ...new Set(entries.map(item => item.group))];
    const visible = filterCanvasWorkspaceTools(entries, query, groups.includes(group) ? group : "全部");
    const visibleGroups = [...new Set(visible.map(item => item.group))];
    const currentCanvas = /^\/canvas\/[^/]+/.test(location.pathname);

    useEffect(() => {
        if (!open) { setQuery(""); setGroup("全部"); }
    }, [open]);

    const enter = (item: WorkspaceToolEntry) => {
        onOpenChange(false);
        if (item.moduleKey === "canvas" && currentCanvas) return;
        navigate(item.path);
    };
    const style = {
        "--cwt-panel": theme.node.panel,
        "--cwt-text": theme.node.text,
        "--cwt-muted": theme.node.muted,
        "--cwt-faint": theme.node.faint,
        "--cwt-border": theme.toolbar.border,
        "--cwt-hover": theme.toolbar.itemHover,
        "--cwt-active": theme.toolbar.activeBg,
    } as CSSProperties;

    return <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
            <Dialog.Overlay className="canvas-workspace-tools-overlay" />
            <Dialog.Content className="canvas-workspace-tools" style={style} onOpenAutoFocus={event => {
                event.preventDefault();
                triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                searchRef.current?.focus();
            }} onCloseAutoFocus={event => {
                event.preventDefault();
                triggerRef.current?.focus();
            }}>
                <header className="cwt-header">
                    <div><Dialog.Title>{t("全部工具")}</Dialog.Title><Dialog.Description>{t("原有工作台与工具，都在这里。")}</Dialog.Description></div>
                    <Dialog.Close className="cwt-close" aria-label={t("关闭全部工具")}><X size={19} strokeWidth={1.5} /></Dialog.Close>
                </header>
                <label className="cwt-search"><Search size={18} strokeWidth={1.6} /><input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索工具或工作台")} aria-label={t("搜索工具或工作台")} /><kbd>Esc</kbd></label>
                <nav className="cwt-categories" aria-label={t("工具分类")}>{groups.map(item => <button type="button" key={item} aria-pressed={group === item} onClick={() => setGroup(item)}>{t(item)}</button>)}</nav>
                <div className="cwt-body">
                    {visibleGroups.map(section => <section key={section} className="cwt-section" aria-label={t(section)}>
                        <h3>{t(section)}</h3>
                        <div className="cwt-grid">{visible.filter(item => item.group === section).map(item => {
                            const Icon = navigationTools.find(tool => tool.path === item.path)?.icon ?? (section === "创意工具" ? Shapes : item.id === "home" ? Grid2X2 : Sparkles);
                            const isCanvas = item.moduleKey === "canvas" && currentCanvas;
                            return <button key={item.id} type="button" className="cwt-tool" data-usage-control={`workspace-tool.${item.id}`} onClick={() => enter(item)} aria-label={`${t(item.label)}${isCanvas ? ` (${t("当前画布")})` : ""}`} title={item.capabilities.length ? t("{value1}内：{value2}", { value1: t(item.label), value2: item.capabilities.map(capability => t(capability.label)).join(" / ") }) : t(item.label)}>
                                <span className="cwt-tool-icon"><Icon size={21} strokeWidth={1.4} /></span>
                                <span className="cwt-tool-copy"><strong>{t(item.label)}{isCanvas && <small>{t("当前画布")}</small>}</strong>{item.capabilities.length ? <span>{item.capabilities.map(capability => t(capability.label)).join(" · ")}</span> : null}</span>
                                {isCanvas ? <ChevronRight className="cwt-arrow" size={16} /> : <ArrowUpRight className="cwt-arrow" size={16} />}
                            </button>;
                        })}</div>
                    </section>)}
                    {!visible.length && <div className="cwt-empty"><Search size={25} strokeWidth={1.3} /><strong>{t("没有找到对应工具")}</strong><p>{t("试试其他名称，或切换到全部分类。")}</p><button type="button" onClick={() => { setQuery(""); setGroup("全部"); }}>{t("查看全部工具")}</button></div>}
                </div>
                <footer className="cwt-footer"><span>{visible.length} {t(" 个可用入口")}</span><span>{t("工具按当前权限显示")}</span></footer>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
