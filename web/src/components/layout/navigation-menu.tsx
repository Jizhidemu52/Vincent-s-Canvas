import { ChevronDown, Menu, Pin, PinOff } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { navigationTools, navigationModuleKey, navigationToolBilling, type NavigationToolSlug } from "@/constant/navigation-tools";
import { useNavigationPreferences } from "@/hooks/use-navigation-preferences";
import { deploymentFeatures } from "@/lib/deployment-features";
import { uiText, useUiLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usageBoardForLocation } from "@/lib/usage-navigation";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { FrequentNavigation } from "./frequent-navigation";
import type { ModuleKey } from "@/services/api/modules";
import { useEffect } from "react";

const sections: { key: string; label: string; slugs: NavigationToolSlug[] }[] = [
    { key: "create", label: "创作", slugs: ["canvas", "image", "video", "gpt-chat", "creative"] },
    { key: "image-tools", label: "图像工具", slugs: ["detail-enhance", "image-edit", "angle-control", "seamless-stitch", "midjourney-blend"] },
    { key: "resources", label: "资源", slugs: ["assets", "prompts", "my-prompts", "design-library"] },
    { key: "collaborate", label: "协作", slugs: ["team"] },
    { key: "manage", label: "管理", slugs: ["admin"] },
];

export function NavigationMenu({ onNavigate }: { onNavigate?: () => void }) {
    useUiLocale();
    const { pathname, search } = useLocation();
    const { pinned, collapsed, togglePin, toggleGroup } = useNavigationPreferences();
    const flags = useModuleStore(state => state.flags);
    const bindings = useBusinessConfigStore(state => state.tools);
    const estimate = useBusinessConfigStore(state => state.estimate);
    const configStatus = useBusinessConfigStore(state => state.status);
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    const active = pathname.startsWith("/creative/") ? "creative" : pathname === "/admin" ? "admin" : pathname === "/team" ? "team" : pathname === "/my-prompts" ? "my-prompts" : usageBoardForLocation(pathname, search);
    const pinsVisible = !deploymentFeatures.authenticationEnabled || (status === "authenticated" && user?.status === "active");
    useEffect(() => {
        const section = sections.find(item => item.slugs.some(slug => slug === active));
        if (section && collapsed.includes(section.key)) toggleGroup(section.key);
        // Open the destination only on navigation, not after a manual collapse.
    }, [pathname, search]);
    const available = (slug: NavigationToolSlug) => slug === "admin" ? isAdminRole(user?.role)
        : (slug !== "team" || (deploymentFeatures.rolePortalsEnabled && Boolean(user?.groupId))) && isModuleAvailable(flags, bindings, navigationModuleKey(slug) as ModuleKey);
    const badge = (slug: NavigationToolSlug) => {
        if (!deploymentFeatures.creditsEnabled || !navigationToolBilling[slug]) return undefined;
        if (configStatus === "idle" || configStatus === "loading") return uiText("同步中");
        const cost = estimate({ ...navigationToolBilling[slug]!, quantity: 1 });
        return cost.configured ? uiText("{count}积分", { count: cost.credits }) : uiText("待配置");
    };
    return <div className="space-y-4">
        <Link to="/" onClick={onNavigate} aria-current={pathname === "/" ? "page" : undefined} className="wb-nav-link flex h-10 items-center gap-3 rounded-lg px-3"><Menu className="size-4" />{uiText("工作台")}</Link>
        <FrequentNavigation onNavigate={onNavigate} />
        {sections.map(section => {
            const tools = section.slugs.map(slug => navigationTools.find(tool => tool.slug === slug)!).filter(tool => available(tool.slug));
            if (!tools.length) return null;
            const closed = collapsed.includes(section.key);
            return <section key={section.key} className="space-y-1.5">
                <button type="button" className="flex h-8 w-full items-center justify-between px-2 text-xs font-semibold text-stone-500" aria-expanded={!closed} onClick={() => toggleGroup(section.key)}><span>{uiText(section.label)}</span><ChevronDown className={cn("size-3.5 transition-transform", closed && "-rotate-90")} /></button>
                {!closed && <div className="space-y-1">{tools.map(tool => {
                    const Icon = tool.icon, cost = badge(tool.slug);
                    const pinKey = navigationModuleKey(tool.slug);
                    const pinnable = !["admin", "team", "my-prompts"].includes(tool.slug);
                    const isPinned = pinnable && pinned.includes(pinKey);
                    return <div key={tool.slug} className="group flex items-center gap-0.5">
                        <Link to={tool.path} onClick={onNavigate} aria-current={tool.slug === active && !(isPinned && pinsVisible) ? "page" : undefined} className="wb-nav-link flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2"><Icon className="size-4 shrink-0" /><span className="min-w-0 truncate">{uiText(tool.label)}</span>{cost && <span className="ml-auto shrink-0 text-xs">{cost}</span>}</Link>
                        {pinnable && <button type="button" className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:opacity-100 focus-visible:outline focus-visible:outline-2" aria-label={uiText(isPinned ? "取消固定{label}" : "固定{label}", { label: uiText(tool.label) })} title={uiText(isPinned ? "取消固定" : "固定到导航顶部")} aria-pressed={isPinned} onClick={() => togglePin(pinKey)}>{isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</button>}
                    </div>;
                })}</div>}
            </section>;
        })}
    </div>;
}
