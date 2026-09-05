import { listAccounts, listAuditLogs, listDepartments } from "@/services/api/admin-accounts";
import { listAdminHistory } from "@/services/api/task-history";

const adminTabs = ["accounts", "groups", "performance", "modules", "pricing", "api", "history", "projects", "batch", "audit", "integrations"];

export function resolveAdminTab(value: string | null, isSuperAdmin: boolean, performanceEnabled: boolean) {
    const tab = ["providers", "workflows", "models"].includes(value || "") ? "api" : value || "accounts";
    if (!adminTabs.includes(tab) || (tab === "performance" && !performanceEnabled)) return "accounts";
    return isSuperAdmin || ["accounts", "groups", "performance"].includes(tab) ? tab : "accounts";
}

export async function loadAdminOverview() {
    const [accounts, departments, audit, history] = await Promise.allSettled([listAccounts(), listDepartments(), listAuditLogs(), listAdminHistory({ page: 1, pageSize: 1 })]);
    const errors = [accounts, departments, audit, history].flatMap((result, index) => result.status === "rejected" ? [`${["账号", "部门", "审计", "成本统计"][index]}：${result.reason instanceof Error ? result.reason.message : "加载失败"}`] : []);
    return {
        accounts: accounts.status === "fulfilled" ? accounts.value.users : undefined,
        departments: departments.status === "fulfilled" ? departments.value.departments : undefined,
        auditLogs: audit.status === "fulfilled" ? audit.value.auditLogs : undefined,
        totalCost: history.status === "fulfilled" ? history.value.totalRmbCost : undefined,
        errors,
    };
}
