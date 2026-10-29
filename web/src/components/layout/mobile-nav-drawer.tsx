import { uiText, useUiLocale } from "@/lib/i18n";
import { Drawer } from "antd";
import { LanguageSwitch } from "./language-switch";
import { Link } from "react-router-dom";
import { FrequentNavigation, UsageCollectionNotice } from "@/components/layout/frequent-navigation";
import { PersonalSessionActions } from "@/components/layout/personal-session-actions";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";

import { navigationModuleKey, navigationToolBilling, navigationTools, type NavigationGroup, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import type { ModuleKey } from "@/services/api/modules";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

const groupLabels: Record<NavigationGroup, string> = {
    local: "本地功能",
    online: "在线功能",
    admin: "管理中心",
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    useUiLocale();
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const adminVisible = useUserStore((state) => isAdminRole(state.user?.role));
    const teamVisible = useUserStore((state) => Boolean(state.user?.groupId));
    const flags = useModuleStore((state) => state.flags);
    const bindings = useBusinessConfigStore(state => state.tools);
    const getToolBadge = (slug: NavigationToolSlug) => {
        if (!deploymentFeatures.creditsEnabled) return undefined;
        const billing = navigationToolBilling[slug];
        if (billing) {
            const usage = estimate({ ...billing, quantity: 1 });
            return usage.configured ? `${uiText("{count}积分", { count: usage.credits })}${slug === "video" ? uiText("起") : slug === "gpt-chat" ? uiText("/次") : ""}` : uiText("待配置");
        }
        if (slug === "prompts" || slug === "my-prompts" || slug === "assets" || slug === "canvas") return uiText("0积分");
        if (slug === "admin") return uiText("管理员");
        if (slug === "team") return uiText("本组");
        return undefined;
    };

    return (
        <Drawer title={uiText("功能模块")} placement="left" size={300} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-6">
                <Link to="/" onClick={onClose} className="block text-foreground" aria-label={uiText("INCHOICE · 无线画布首页")}><InchoiceBrand /></Link>
                <FrequentNavigation onNavigate={onClose} />
                {(["local", "online", "admin"] as const).map((group) => {
                    const tools = navigationTools.filter((tool) => tool.group === group && (deploymentFeatures.rolePortalsEnabled || tool.group !== "admin" || tool.slug === "admin") && (tool.slug === "admin" || isModuleAvailable(flags, bindings, navigationModuleKey(tool.slug) as ModuleKey)) && (tool.group !== "admin" || (tool.slug === "team" ? teamVisible : adminVisible)));
                    if (!tools.length) return null;

                    return (
                        <section key={group} className="space-y-2">
                            <div className="px-2 text-xs font-semibold text-stone-400">{uiText(groupLabels[group])}</div>
                            {tools.map((tool) => {
                                const Icon = tool.icon;
                                const active = tool.slug === activeToolSlug;
                                const badge = getToolBadge(tool.slug);
                                return (
                                    <Link
                                        key={tool.slug}
                                        to={tool.path}
                                        onClick={onClose}
                                        aria-current={active ? "page" : undefined}
                                        className={cn("flex h-12 items-center gap-3 rounded-2xl px-4 text-sm font-semibold transition", active ? "!bg-black !text-white" : "!text-stone-500 hover:bg-orange-100 hover:!text-orange-950")}
                                    >
                                        <Icon className="size-5" />
                                        <span>{uiText(tool.label)}</span>
                                        {badge ? <span className={cn("ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold", active ? "bg-white/18 text-white" : "bg-orange-50 text-orange-600")}>{badge}</span> : null}
                                    </Link>
                                );
                            })}
                        </section>
                    );
                })}
                <LanguageSwitch />
                <PersonalSessionActions onSignedOut={onClose} />
                <UsageCollectionNotice />
            </div>
        </Drawer>
    );
}
