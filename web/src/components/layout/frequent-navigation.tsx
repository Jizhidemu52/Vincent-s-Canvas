import { uiText, useUiLocale } from "@/lib/i18n";
import { Star } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { usageDestinations, usageBoardAvailable, usageBoardForLocation } from "@/lib/usage-navigation";
import { useNavigationPreferences } from "@/hooks/use-navigation-preferences";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUsageStore } from "@/stores/use-usage-store";
import { useUserStore } from "@/stores/use-user-store";

export function FrequentNavigation({ onNavigate }: { onNavigate?: () => void }) {
    useUiLocale();
    const { pinned } = useNavigationPreferences();
    const user = useUserStore(state => state.user), status = useUserStore(state => state.status);
    const flags = useModuleStore(state => state.flags), moduleStatus = useModuleStore(state => state.status);
    const tools = useBusinessConfigStore(state => state.tools);
    const location = useLocation();
    if ((deploymentFeatures.authenticationEnabled && (status !== "authenticated" || user?.status !== "active")) || moduleStatus !== "ready") return null;
    const items = pinned.map(key => usageDestinations.find(item => item.key === key)).filter((item): item is typeof usageDestinations[number] => Boolean(item && usageBoardAvailable(item.key, flags, tools)));
    if (!items.length) return null;
    const board = usageBoardForLocation(location.pathname, location.search);
    return <section className="space-y-1.5" aria-label={uiText("固定入口")} data-usage-control="favorite">
        <div className="flex h-8 items-center gap-2 px-2 text-xs font-semibold text-stone-500"><Star className="size-3.5" />{uiText("固定入口")}</div>
        {items.map(item => <Link key={item.key} to={item.path} onClick={onNavigate} aria-label={uiText("{label}（常用）", { label: uiText(item.label) })} aria-current={board === item.key ? "page" : undefined} className="wb-nav-link flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{uiText(item.label)}</span>
        </Link>)}
    </section>;
}

export function UsageCollectionNotice({ compact = false }: { compact?: boolean }) {
    useUiLocale();
    const user = useUserStore(state => state.user), status = useUserStore(state => state.status);
    const unavailable = useUsageStore(state => state.storageUnavailable);
    if (status !== "authenticated" || user?.status !== "active") return null;
    const text = deploymentFeatures.authenticationEnabled
        ? uiText("记录业务访问、控件操作和受限参数；不录屏、不采集键入内容或密钥。正式提交的提示词由业务服务保存。仅超级管理员可查看明细。")
        : uiText("免登录试用：固定入口保存在本浏览器，不上报人员操作记录。");
    return <p data-usage-ignore className={compact ? "max-w-64 text-xs leading-4 text-stone-500" : "px-2 text-xs leading-4 text-stone-500"} title={text}>{text}{unavailable ? uiText(" 本地存储不可用，部分记录可能无法保留。") : ""}</p>;
}
