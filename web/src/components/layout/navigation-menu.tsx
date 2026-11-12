import { ChevronDown, Menu } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { navigationTools, navigationModuleKey, type NavigationToolSlug } from "@/constant/navigation-tools";
import { useNavigationPreferences } from "@/hooks/use-navigation-preferences";
import { deploymentFeatures } from "@/lib/deployment-features";
import { uiText, useUiLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usageBoardForLocation } from "@/lib/usage-navigation";
import { isQuickImageTool } from "@/lib/quick-image-tools";
import { isStandaloneCreativePreset } from "@/lib/creative-presets";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import type { ModuleKey } from "@/services/api/modules";
import { useEffect } from "react";

const sections: { key: string; label: string; slugs: NavigationToolSlug[] }[] = [
    { key: "workspace", label: "工作空间", slugs: ["canvas", "gpt-chat"] },
    { key: "create", label: "创作工具", slugs: ["creative", "local-restyle", "garment-colorway", "back-design", "image", "video"] },
    { key: "image-tools", label: "图像工具", slugs: ["layer-studio", "remove-background", "hd-upscale", "item-extract", "image-edit", "seamless-stitch", "midjourney-blend"] },
    { key: "resources", label: "资源库", slugs: ["assets", "prompts", "design-library"] },
    { key: "collaborate", label: "协作", slugs: ["team"] },
    { key: "manage", label: "管理", slugs: ["admin"] },
];

export function NavigationMenu({ onNavigate }: { onNavigate?: () => void }) {
    useUiLocale();
    const { pathname, search } = useLocation();
    const { collapsed, toggleGroup, openGroup, recordRecent } = useNavigationPreferences();
    const flags = useModuleStore(state => state.flags);
    const bindings = useBusinessConfigStore(state => state.tools);
    const user = useUserStore(state => state.user);
    const routeTool = pathname === "/image" ? new URLSearchParams(search).get("tool") : pathname.slice(1);
    const quickTool = isQuickImageTool(routeTool) ? routeTool : null;
    const active = quickTool || (routeTool && isStandaloneCreativePreset(routeTool) ? routeTool : pathname.startsWith("/creative/") ? "creative" : pathname === "/admin" ? "admin" : pathname === "/team" ? "team" : pathname === "/my-prompts" ? "my-prompts" : usageBoardForLocation(pathname, search));
    useEffect(() => {
        const section = sections.find(item => item.slugs.some(slug => slug === active));
        if (section) openGroup(section.key);
        const board = usageBoardForLocation(pathname, search);
        if (board && board !== "home") recordRecent(board);
        // Open the destination only on navigation, not after a manual collapse.
    }, [pathname, search, user?.id]);
    const available = (slug: NavigationToolSlug) => slug === "admin" ? isAdminRole(user?.role)
        : (slug !== "team" || (deploymentFeatures.rolePortalsEnabled && Boolean(user?.groupId))) && isModuleAvailable(flags, bindings, navigationModuleKey(slug) as ModuleKey);
    return <div className="space-y-4">
        <Link to="/" onClick={onNavigate} aria-current={pathname === "/" ? "page" : undefined} className="wb-nav-link flex h-10 items-center gap-3 rounded-lg px-3"><Menu className="size-4" />{uiText("工作台")}</Link>
        {sections.map(section => {
            const tools = section.slugs.map(slug => navigationTools.find(tool => tool.slug === slug)!).filter(tool => available(tool.slug));
            if (!tools.length) return null;
            const closed = section.key !== "workspace" && collapsed.includes(section.key);
            return <section key={section.key} className="space-y-1.5">
                {section.key === "workspace" ? null : <button type="button" className="flex h-8 w-full items-center justify-between rounded-md px-2 text-xs font-semibold text-muted-foreground hover:bg-muted" aria-expanded={!closed} onClick={() => toggleGroup(section.key)}><span>{uiText(section.label)}</span><ChevronDown className={cn("size-3.5 transition-transform", closed && "-rotate-90")} /></button>}
                {!closed && <div className="space-y-1">{tools.map(tool => {
                    const Icon = tool.icon;
                    return <div key={tool.slug} className="group flex items-center gap-0.5">
                        <Link to={tool.path} onClick={onNavigate} aria-current={tool.slug === active || tool.slug === "prompts" && active === "my-prompts" ? "page" : undefined} className="wb-nav-link flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-3"><Icon className="size-4 shrink-0" /><span className="min-w-0 truncate">{uiText(tool.label)}</span></Link>
                    </div>;
                })}</div>}
            </section>;
        })}
    </div>;
}
