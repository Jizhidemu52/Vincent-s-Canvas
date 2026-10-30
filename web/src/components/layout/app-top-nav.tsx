import { uiText, useUiLocale } from "@/lib/i18n";
import { Menu, Plus } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { UsageCollectionNotice } from "@/components/layout/frequent-navigation";
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
                    <Link to="/" className="flex h-10 shrink-0 items-center justify-center text-foreground transition hover:opacity-80" aria-label={uiText("INCHOICE · 无限画布首页")}><InchoiceBrand /></Link>
                    {canvasEnabled && <button type="button" disabled={!hydrated} onClick={createAndEnter} className="inchoice-new-project inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-bold shadow-sm transition hover:opacity-85 disabled:cursor-wait disabled:opacity-50"><Plus className="size-3.5" />{uiText("新建画布")}</button>}
                </div>
                <nav aria-label={uiText("主导航")} className="hide-scrollbar mt-6 min-h-0 flex-1 overflow-y-auto pb-6"><NavigationMenu /></nav>
                <NavigationFooter />
                <UsageCollectionNotice />
            </aside>
            <header className="wb-sidebar fixed inset-x-0 top-0 z-20 flex h-14 items-center justify-between border-b px-4 md:hidden">
                <Link to="/" className="flex min-w-0 items-center text-foreground" aria-label={uiText("INCHOICE · 无限画布首页")}><InchoiceBrand className="!w-[144px]" /></Link>
                <div className="flex items-center gap-2">
                    {canvasEnabled && <button type="button" disabled={!hydrated} className="inchoice-new-project inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-bold disabled:cursor-wait disabled:opacity-50" onClick={createAndEnter}><Plus className="size-4" />{uiText("新建")}</button>}
                    <button type="button" className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-card text-foreground" onClick={() => setMobileNavOpen(true)} aria-label={uiText("打开导航菜单")} title={uiText("导航菜单")}><Menu className="size-5" /></button>
                </div>
            </header>
        </>}
        <MobileNavDrawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
    </>;
}
