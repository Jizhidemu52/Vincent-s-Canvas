import { ChevronDown, CircleDollarSign, Globe2, Link2, LogIn, LogOut, Menu, Plus } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";

import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { navigationModuleKey, navigationToolBilling, navigationTools, type NavigationGroup, type NavigationToolSlug } from "@/constant/navigation-tools";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { cn } from "@/lib/utils";
import { standaloneEdition } from "@/lib/standalone-edition";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { useModuleStore } from "@/stores/use-module-store";
import type { ModuleKey } from "@/services/api/modules";

const groupLabels: Record<NavigationGroup, string> = {
    local: "本地功能",
    online: "在线功能",
    admin: "管理中心",
};

function BrandMark() {
    return (
        <Link to="/" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-black text-white shadow-sm" aria-label="无线画布首页">
            <span
                className="size-5 bg-current"
                style={{
                    mask: "url(/logo.svg) center / contain no-repeat",
                    WebkitMask: "url(/logo.svg) center / contain no-repeat",
                }}
            />
        </Link>
    );
}

function SidebarTool({ tool, active, badge }: { tool: (typeof navigationTools)[number]; active: boolean; badge?: string }) {
    const Icon = tool.icon;

    return (
        <Link
            to={tool.path}
            aria-current={active ? "page" : undefined}
            className="wb-nav-link group flex h-10 items-center gap-3 rounded-lg px-3"
        >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{tool.label}</span>
            {badge ? <span className={cn("ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold", active ? "bg-white/18 text-white" : "bg-orange-50 text-orange-600")}>{badge}</span> : null}
        </Link>
    );
}

function ToolGroup({ group, activeToolSlug, adminVisible, teamVisible, getToolBadge }: { group: NavigationGroup; activeToolSlug?: NavigationToolSlug; adminVisible: boolean; teamVisible: boolean; getToolBadge: (slug: NavigationToolSlug) => string | undefined }) {
    const flags = useModuleStore((state) => state.flags);
    const tools = navigationTools.filter((tool) => {
        if (tool.group !== group) return false;
        if (!deploymentFeatures.rolePortalsEnabled && tool.group === "admin") return false;
        return (tool.slug === "admin" || flags[navigationModuleKey(tool.slug) as ModuleKey])
            && (tool.group !== "admin" || (tool.slug === "team" ? teamVisible : adminVisible));
    });
    if (!tools.length) return null;

    return (
        <section className="space-y-1.5">
            <div className="flex h-8 items-center justify-between px-2 text-[12px] font-semibold uppercase tracking-normal !text-stone-500">
                <span>{groupLabels[group]}</span>
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
    const navigate = useNavigate();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const user = useUserStore((state) => state.user);
    const clearSession = useUserStore((state) => state.clearSession);
    const buttonClass = "wb-nav-link flex h-10 w-full items-center gap-2 rounded-lg px-3";
    const displayName = user?.displayName || (deploymentFeatures.authenticationEnabled ? "未登录" : "我的工作台");
    const roleLabel = user?.role === "super_admin" ? "超级管理员" : user?.role === "department_admin" ? "部门管理员" : user?.role === "designer" ? "设计师" : "登录";
    const credits = user ? `${user.creditBalance}积分 · 月额${user.monthlyCreditLimit}` : "请登录";

    return (
        <div className="space-y-1 border-t border-stone-200 pt-3">
            {adminVisible && deploymentFeatures.rolePortalsEnabled ? (
                <button type="button" className={buttonClass} onClick={() => navigate("/admin?tab=api")}>
                    <Link2 className="size-4 text-stone-400" />
                    API 设置
                </button>
            ) : null}
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={buttonClass} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}>
                <span>{theme === "dark" ? "黑夜模式" : "白天模式"}</span>
            </AnimatedThemeToggler>
            <div className={`${buttonClass} cursor-default`}>
                <Globe2 className="size-4 text-stone-400" />
                中文
            </div>
            {deploymentFeatures.authenticationEnabled ? <button
                type="button"
                className={buttonClass}
                onClick={async () => {
                    if (user) {
                        await clearSession();
                        navigate("/login");
                    } else {
                        navigate("/login");
                    }
                }}
            >
                {user ? <LogOut className="size-4 text-stone-400" /> : <LogIn className="size-4 text-stone-400" />}
                {user ? "退出登录" : "登录入口"}
            </button> : null}
            <div className="wb-account mt-4 flex items-center gap-2 rounded-xl px-3 py-3">
                <div className="flex size-7 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white">{displayName.slice(0, 1).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-stone-700">{displayName}</p>
                    {deploymentFeatures.creditsEnabled ? <p className="flex items-center gap-1 text-[11px] font-semibold text-orange-600">
                        <CircleDollarSign className="size-3" />
                        {deploymentFeatures.rolePortalsEnabled && isAdminRole(user?.role) ? roleLabel : credits}
                    </p> : <p className="text-[11px] text-stone-500">{deploymentFeatures.authenticationEnabled ? "不计积分" : "免登录创作"}</p>}
                </div>
            </div>
        </div>
    );
}

function getActiveToolSlug(pathname: string, search: string): NavigationToolSlug | undefined {
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
    const { pathname, search } = useLocation();
    const navigate = useNavigate();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const hideShell = /^\/canvas\/[^/]+/.test(pathname) || pathname === "/login" || pathname === "/admin/login";
    const activeToolSlug = getActiveToolSlug(pathname, search);
    const createProject = useCanvasStore((state) => state.createProject);
    const projectsLength = useCanvasStore((state) => state.projects.length);
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
            if (businessConfigStatus === "idle" || businessConfigStatus === "loading") return "同步中";
            const usage = estimate({ ...billing, quantity: 1 });
            return usage.configured ? `${usage.credits}积分${slug === "video" ? "起" : ""}` : "待配置";
        }
        if (slug === "prompts" || slug === "my-prompts" || slug === "assets" || slug === "canvas" || slug === "gpt-chat") return "0积分";
        if (slug === "admin") return "管理员";
        if (slug === "team") return "本组";
        return undefined;
    };

    const createAndEnter = () => {
        const id = createProject(`无线画布 ${projectsLength + 1}`);
        navigate(`/canvas/${id}`);
    };

    return (
        <>
            {!hideShell ? (
                <>
                    <aside className="wb-sidebar hidden h-dvh w-[216px] shrink-0 flex-col px-4 py-5 md:flex">
                        <div className="flex items-center gap-2">
                            <BrandMark />
                            <button type="button" onClick={createAndEnter} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md !bg-black px-3 text-[12px] font-bold !text-white shadow-sm transition hover:!bg-stone-800">
                                <Plus className="size-3.5 !text-white" />
                                新建项目
                            </button>
                        </div>
                        <nav className="hide-scrollbar mt-6 min-h-0 flex-1 space-y-5 overflow-y-auto pb-6">
                            <Link
                                to="/"
                                aria-current={pathname === "/" ? "page" : undefined}
                                className="wb-nav-link flex h-10 items-center gap-3 rounded-lg px-3"
                            >
                                <Menu className="size-4 text-stone-400" />
                                工作台
                            </Link>
                            <ToolGroup group="local" activeToolSlug={activeToolSlug} adminVisible={adminVisible} teamVisible={teamVisible} getToolBadge={getToolBadge} />
                            <ToolGroup group="online" activeToolSlug={activeToolSlug} adminVisible={adminVisible} teamVisible={teamVisible} getToolBadge={getToolBadge} />
                            <ToolGroup group="admin" activeToolSlug={activeToolSlug} adminVisible={adminVisible} teamVisible={teamVisible} getToolBadge={getToolBadge} />
                        </nav>
                        <SidebarFooter adminVisible={configVisible} />
                    </aside>

                    <header className="wb-sidebar fixed inset-x-0 top-0 z-20 flex h-14 items-center justify-between border-b px-4 md:hidden">
                        <Link to="/" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                            <span
                                className="size-6 bg-current"
                                style={{
                                    mask: "url(/logo.svg) center / contain no-repeat",
                                    WebkitMask: "url(/logo.svg) center / contain no-repeat",
                                }}
                            />
                            无线画布
                        </Link>
                        <div className="flex items-center gap-2">
                            <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-black px-3 text-xs font-bold text-white" onClick={createAndEnter}>
                                <Plus className="size-4" />
                                新建
                            </button>
                            <button type="button" className="inline-flex size-9 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-950" onClick={() => setMobileNavOpen(true)} aria-label="打开导航菜单" title="导航菜单">
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
