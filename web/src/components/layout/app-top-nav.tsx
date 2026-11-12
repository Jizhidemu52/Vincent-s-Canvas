import { uiText, useUiLocale } from "@/lib/i18n";
import { Menu, Plus } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import { Tooltip } from "antd";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { NavigationMenu } from "@/components/layout/navigation-menu";
import { NavigationFooter } from "@/components/layout/navigation-footer";
import { nextProjectTitle } from "@/lib/project-title";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useModuleEnabled } from "@/stores/use-module-store";

export function AppTopNav() {
    useUiLocale();
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const hideShell = /^\/canvas\/[^/]+/.test(pathname) || pathname === "/login" || pathname === "/admin/login";
    const createProject = useCanvasStore(state => state.createProject);
    const hydrated = useCanvasStore(state => state.hydrated);
    const canvasEnabled = useModuleEnabled("canvas");
    const createAndEnter = () => {
        const current = useCanvasStore.getState();
        if (!current.hydrated || !canvasEnabled) return;
        navigate("/canvas/" + createProject(nextProjectTitle(canvasLibrarySummaries(current.projects, current.unloadedProjects))));
    };
    return <>
        {!hideShell && <>
            <aside className="wb-sidebar hidden h-dvh w-[216px] shrink-0 flex-col px-4 py-5 md:flex">
                <div className="flex flex-col gap-3">
                    <Link to="/" className="flex h-10 shrink-0 items-center justify-center text-foreground transition hover:opacity-80" aria-label={uiText("TruCreate · 首页")}><InchoiceBrand /></Link>
                    {canvasEnabled && <Tooltip title={!hydrated ? uiText("正在读取画布，请稍候") : undefined}><button type="button" disabled={!hydrated} onClick={createAndEnter} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-input bg-card px-3 text-sm font-medium hover:bg-muted"><Plus className="size-4" />{uiText("新建画布")}</button></Tooltip>}
                </div>
                <nav aria-label={uiText("主导航")} className="mt-6 min-h-0 flex-1 overflow-y-auto pb-6"><NavigationMenu /></nav>
                <NavigationFooter />
            </aside>
            <header className="wb-sidebar fixed inset-x-0 top-0 z-20 flex h-14 items-center justify-between border-b px-4 md:hidden">
                <Link to="/" className="flex min-w-0 items-center text-foreground" aria-label={uiText("TruCreate · 首页")}><InchoiceBrand className="!w-[144px]" /></Link>
                <div className="flex items-center gap-2">
                    {canvasEnabled && <Tooltip title={!hydrated ? uiText("正在读取画布，请稍候") : undefined}><button type="button" disabled={!hydrated} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-card px-3 text-sm font-medium disabled:opacity-40" onClick={createAndEnter}><Plus className="size-4" />{uiText("新建")}</button></Tooltip>}
                    <Tooltip title={uiText("导航菜单")}><button type="button" className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-card text-foreground" onClick={() => setMobileNavOpen(true)} aria-label={uiText("打开导航菜单")}><Menu className="size-5" /></button></Tooltip>
                </div>
            </header>
        </>}
        <MobileNavDrawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
    </>;
}
