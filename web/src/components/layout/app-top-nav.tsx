import { uiText, useUiLocale } from "@/lib/i18n";
import { ChevronDown, Link2, Menu, Plus } from "lucide-react";
import { LanguageSwitch } from "./language-switch";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";

import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { PersonalSessionActions } from "@/components/layout/personal-session-actions";
import { FrequentNavigation, UsageCollectionNotice } from "@/components/layout/frequent-navigation";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { navigationModuleKey, navigationToolBilling, navigationTools, type NavigationGroup, type NavigationToolSlug } from "@/constant/navigation-tools";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { cn } from "@/lib/utils";
import { standaloneEdition } from "@/lib/standalone-edition";
import { deploymentFeatures } from "@/lib/deployment-features";
import { nextProjectTitle } from "@/lib/project-title";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { isModuleAvailable, useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import type { ModuleKey } from "@/services/api/modules";

const groupLabels: Record<NavigationGroup, string> = {
    local: "本地功能",
    online: "在线功能",
    admin: "管理中心",
};

function BrandMark() {
    useUiLocale();
    return (
        <Link to="/" className="flex h-10 shrink-0 items-center justify-center text-foreground transition hover:opacity-80" aria-label={uiText("INCHOICE · 无线画布首页")}>
            <InchoiceBrand />
        </Link>
    );
}

function SidebarTool({ tool, active, badge }: { tool: (typeof navigationTools)[number]; active: boolean; badge?: string }) {
    useUiLocale();
    const Icon = tool.icon;

    return (
        <Link
            to={tool.path}
            aria-current={active ? "page" : undefined}
            className="wb-nav-link group flex h-10 items-center gap-3 rounded-lg px-3"
        >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{uiText(tool.label)}</span>
            {badge ? <span className={cn("ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold", active ? "bg-white/18 text-white" : "bg-orange-50 text-orange-600")}>{badge}</span> : null}
        </Link>
    );
}

function ToolGroup({ group, activeToolSlug, adminVisible, teamVisible, getToolBadge }: { group: NavigationGroup; activeToolSlug?: NavigationToolSlug; adminVisible: boolean; teamVisible: boolean; getToolBadge: (slug: NavigationToolSlug) => string | undefined }) {
    useUiLocale();
    const flags = useModuleStore((state) => state.flags);
    const bindings = useBusinessConfigStore(state => state.tools);
    const tools = navigationTools.filter((tool) => {
        if (tool.group !== group) return false;
        if (!deploymentFeatures.rolePortalsEnabled && tool.group === "admin" && tool.slug !== "admin") return false;
        return (tool.slug === "admin" || isModuleAvailable(flags, bindings, navigationModuleKey(tool.slug) as ModuleKey))
            && (tool.group !== "admin" || (tool.slug === "team" ? teamVisible : adminVisible));
    });
    if (!tools.length) return null;

    return (
        <section className="space-y-1.5">
            <div className="flex h-8 items-center justify-between px-2 text-[12px] font-semibold uppercase tracking-normal !text-stone-500">
                <span>{uiText(groupLabels[group])}</span>
                <ChevronDown className="size-3.5" />
            </div>
            <div className="space-y-1">
                {tools.map((tool) => (
                    <SidebarTool key={tool.slug} tool={tool} active={tool.slug === activeToolSlug} badge={getToolBadge(tool.slug)} />
                ))}
            </div>
        </section>
    );
}

function SidebarFooter({ adminVisible }: { adminVisible: boolean }) {
    useUiLocale();
    const navigate = useNavigate();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const buttonClass = "wb-nav-link flex h-10 w-full items-center gap-2 rounded-lg px-3";

    return (
        <div className="space-y-1 border-t border-border pt-3">
            {adminVisible && deploymentFeatures.rolePortalsEnabled ? (
                <button type="button" className={buttonClass} onClick={() => navigate("/admin?tab=api")}>
                    <Link2 className="size-4 text-stone-400" />
                    {uiText("API 设置")}</button>
            ) : null}
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={buttonClass} aria-label={theme === "dark" ? uiText("切换到浅色主题") : uiText("切换到深色主题")} title={theme === "dark" ? uiText("切换到浅色主题") : uiText("切换到深色主题")}>
                <span>{theme === "dark" ? uiText("黑夜模式") : uiText("白天模式")}</span>
            </AnimatedThemeToggler>
            <LanguageSwitch className={buttonClass} />
            <PersonalSessionActions />
        </div>
    );
}

function getActiveToolSlug(pathname: string, search: string): NavigationToolSlug | undefined {
    if (pathname.startsWith("/creative/")) return "creative";
    const currentParams = new URLSearchParams(search);
    const exact = navigationTools.find((tool) => {
        const [toolPathname, toolSearch = ""] = tool.path.split("?");
        if (toolPathname !== pathname || !toolSearch) return false;
        const toolParams = new URLSearchParams(toolSearch);
        return Array.from(toolParams.entries()).every(([key, value]) => currentParams.get(key) === value);
    });
    if (exact) return exact.slug;

    const samePage = navigationTools.find((tool) => !tool.path.includes("?") && tool.path === pathname);
    return samePage?.slug;
}

export function AppTopNav() {
    useUiLocale();
    const { pathname, search } = useLocation();
    const navigate = useNavigate();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const hideShell = /^\/canvas\/[^/]+/.test(pathname) || pathname === "/login" || pathname === "/admin/login";
    const activeToolSlug = getActiveToolSlug(pathname, search);
    const createProject = useCanvasStore((state) => state.createProject);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const canvasEnabled = useModuleEnabled("canvas");
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const businessConfigStatus = useBusinessConfigStore((state) => state.status);
    const configVisible = useCanManageConfig();
    const currentRole = useUserStore((state) => state.user?.role);
    const adminVisible = isAdminRole(currentRole);
    const teamVisible = useUserStore((state) => Boolean(state.user?.groupId));

    const getToolBadge = (slug: NavigationToolSlug) => {
        if (!deploymentFeatures.creditsEnabled) return undefined;
        const billing = navigationToolBilling[slug];
        if (billing) {
            if (businessConfigStatus === "idle" || businessConfigStatus === "loading") return uiText("同步中");
            const usage = estimate({ ...billing, quantity: 1 });
            return usage.configured ? `${uiText("{count}积分", { count: usage.credits })}${slug === "video" ? uiText("起") : slug === "gpt-chat" ? uiText("/次") : ""}` : uiText("待配置");
        }
        if (slug === "prompts" || slug === "my-prompts" || slug === "assets" || slug === "canvas") return uiText("0积分");
        if (slug === "admin") return uiText("管理员");
        if (slug === "team") return uiText("本组");
        return undefined;
    };

    const createAndEnter = () => {
        const current = useCanvasStore.getState();
        if (!current.hydrated || !canvasEnabled) return;
        const id = createProject(nextProjectTitle(current.projects));
        navigate(`/canvas/${id}`);
    };

    return (
        <>
            {!hideShell ? (
                <>
                    <aside className="wb-sidebar hidden h-dvh w-[216px] shrink-0 flex-col px-4 py-5 md:flex">
                        <div className="flex flex-col gap-3">
                            <BrandMark />
                            {canvasEnabled && <button type="button" disabled={!hydrated} onClick={createAndEnter} className="inchoice-new-project inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-foreground px-3 text-[12px] font-bold shadow-sm transition hover:opacity-85 disabled:cursor-wait disabled:opacity-50">
                                <Plus className="size-3.5" />
                                {uiText("新建项目")}</button>}
                        </div>
                        <nav className="hide-scrollbar mt-6 min-h-0 flex-1 space-y-5 overflow-y-auto pb-6">
                            <FrequentNavigation />
                            <Link
                                to="/"
                                aria-current={pathname === "/" ? "page" : undefined}
                                className="wb-nav-link flex h-10 items-center gap-3 rounded-lg px-3"
                            >
                                <Menu className="size-4 text-stone-400" />
                                {uiText("工作台")}</Link>
                            <ToolGroup group="local" activeToolSlug={activeToolSlug} adminVisible={adminVisible} teamVisible={teamVisible} getToolBadge={getToolBadge} />
                            <ToolGroup group="online" activeToolSlug={activeToolSlug} adminVisible={adminVisible} teamVisible={teamVisible} getToolBadge={getToolBadge} />
                            <ToolGroup group="admin" activeToolSlug={activeToolSlug} adminVisible={adminVisible} teamVisible={teamVisible} getToolBadge={getToolBadge} />
                        </nav>
                        <SidebarFooter adminVisible={configVisible} />
                        <UsageCollectionNotice />
                    </aside>

                    <header className="wb-sidebar fixed inset-x-0 top-0 z-20 flex h-14 items-center justify-between border-b px-4 md:hidden">
                        <Link to="/" className="flex min-w-0 items-center text-foreground" aria-label={uiText("INCHOICE · 无线画布首页")}>
                            <InchoiceBrand className="!w-[144px]" />
                        </Link>
                        <div className="flex items-center gap-2">
                            {canvasEnabled && <button type="button" disabled={!hydrated} className="inchoice-new-project inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-bold disabled:cursor-wait disabled:opacity-50" onClick={createAndEnter}>
                                <Plus className="size-4" />
                                {uiText("新建")}</button>}
                            <button type="button" className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-card text-foreground" onClick={() => setMobileNavOpen(true)} aria-label={uiText("打开导航菜单")} title={uiText("导航菜单")}>
                                <Menu className="size-5" />
                            </button>
                        </div>
                    </header>
                </>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
        </>
    );
}
