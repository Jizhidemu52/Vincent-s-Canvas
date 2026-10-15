import { Star } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { frequentUsageDestinations, usageBoardForLocation } from "@/lib/usage-navigation";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUsageStore } from "@/stores/use-usage-store";
import { useUserStore } from "@/stores/use-user-store";

export function FrequentNavigation({ onNavigate }: { onNavigate?: () => void }) {
    const counts = useUsageStore(state => state.counts), storedOwner = useUsageStore(state => state.owner);
    const user = useUserStore(state => state.user), status = useUserStore(state => state.status);
    const flags = useModuleStore(state => state.flags), moduleStatus = useModuleStore(state => state.status);
    const tools = useBusinessConfigStore(state => state.tools);
    const location = useLocation();
    if (status !== "authenticated" || user?.status !== "active" || storedOwner !== user.id || moduleStatus !== "ready") return null;
    const items = frequentUsageDestinations(counts, flags, tools);
    if (!items.length) return null;
    const board = usageBoardForLocation(location.pathname, location.search);
    return <section className="space-y-1.5" aria-label="常用板块" data-usage-control="favorite">
        <div className="flex h-8 items-center gap-2 px-2 text-[12px] font-semibold text-stone-500"><Star className="size-3.5" />常用板块<span className="ml-auto text-[10px] font-normal">按访问次数</span></div>
        {items.map(item => <Link key={item.key} to={item.path} onClick={onNavigate} aria-label={`${item.label}（常用）`} aria-current={board === item.key ? "page" : undefined} className="wb-nav-link flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{item.label}</span><span className="text-[10px] opacity-60">{item.count}</span>
        </Link>)}
    </section>;
}

export function UsageCollectionNotice({ compact = false }: { compact?: boolean }) {
    const user = useUserStore(state => state.user), status = useUserStore(state => state.status);
    const unavailable = useUsageStore(state => state.storageUnavailable);
    if (status !== "authenticated" || user?.status !== "active") return null;
    const text = deploymentFeatures.oaLoginEnabled
        ? "记录业务访问、控件操作和受限参数；不录屏、不采集键入内容或密钥。正式提交的提示词由业务服务保存。仅超级管理员可查看明细。"
        : "常用板块仅按本账户在此浏览器的访问次数排序；当前试用环境不上报操作记录。";
    return <p data-usage-ignore className={compact ? "max-w-64 text-[10px] leading-4 text-stone-500" : "px-2 text-[10px] leading-4 text-stone-500"} title={text}>{text}{unavailable ? " 本地存储不可用，部分记录可能无法保留。" : ""}</p>;
}
