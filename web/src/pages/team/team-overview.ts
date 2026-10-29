import { uiText } from "@/lib/i18n";
import { getMyGroupCredits, getTeamGroupCredits } from "@/services/api/group-credits";
import { getTeamAudit, getTeamHistory, getTeamOverview } from "@/services/api/groups";
import { getServerAssetOverview } from "@/services/api/server-assets";

export async function loadTeamOverview(isLeader: boolean) {
    const [mine, overview, history, assets, audit, managed] = await Promise.allSettled([
        getMyGroupCredits(),
        isLeader ? getTeamOverview() : Promise.resolve(undefined),
        isLeader ? getTeamHistory() : Promise.resolve(undefined),
        isLeader ? getServerAssetOverview() : Promise.resolve(undefined),
        isLeader ? getTeamAudit() : Promise.resolve(undefined),
        isLeader ? getTeamGroupCredits() : Promise.resolve(undefined),
    ]);
    const errors = [mine, overview, history, assets, audit, managed].flatMap((result, index) => result.status === "rejected" ? [`${[uiText("我的额度"), uiText("小组概览"), uiText("任务记录"), uiText("最近成果"), uiText("审计记录"), uiText("共享池审批")][index]}：${result.reason instanceof Error ? result.reason.message : uiText("加载失败")}`] : []);
    return {
        myCredits: mine.status === "fulfilled" ? mine.value : undefined,
        overview: overview.status === "fulfilled" ? overview.value : undefined,
        history: history.status === "fulfilled" ? history.value?.history : undefined,
        assets: assets.status === "fulfilled" ? assets.value?.assets : undefined,
        assetTotal: assets.status === "fulfilled" ? assets.value?.total : undefined,
        auditLogs: audit.status === "fulfilled" ? audit.value?.auditLogs : undefined,
        managedCredits: managed.status === "fulfilled" ? managed.value : undefined,
        errors,
    };
}
