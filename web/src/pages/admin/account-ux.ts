import type { ApiUser } from "@/services/api/auth";

export function filterAdminAccounts(accounts: ApiUser[], search: string, status: string, department: string) {
    const keyword = search.trim().toLocaleLowerCase();
    return accounts.filter((account) => (!keyword || [account.displayName, account.username, account.email, account.employeeNo, account.departmentName].some((value) => value?.toLocaleLowerCase().includes(keyword)))
        && (!status || account.status === status) && (!department || account.departmentId === department));
}

export function creditChangeError(account: ApiUser | undefined, amount: number, reason: string) {
    if (!account || account.role !== "designer") return "请明确选择需要调整的设计师";
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000) return "请输入非零整数积分，范围为 -100000 至 100000";
    if (!reason.trim()) return "请填写本次积分调整的原因";
    if (account.creditBalance + amount < 0) return "扣除后余额不能小于 0，请减少扣除积分";
    return "";
}
