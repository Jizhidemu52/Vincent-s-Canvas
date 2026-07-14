export type DemoPortal = "designer" | "admin";

export type DemoAccount = {
    id: string;
    identifier: string;
    password: string;
    label: string;
    portal: DemoPortal;
    user: {
        id: string;
        username: string;
        displayName: string;
        email: string | null;
        employeeNo: string | null;
        role: "super_admin" | "department_admin" | "designer";
        status: "active";
        departmentId: string | null;
        departmentName: string | null;
        groupId: string | null;
        groupName: string | null;
        groupRole: "member" | "leader" | null;
        mustChangePassword: false;
        mfaEnabled: boolean;
        creditBalance: number;
        creditLimit: number;
        monthlyCreditLimit: number;
        temporaryCreditAdjustment: number;
        creditPeriodStart: string;
        creditResetAt: string;
    };
};

const period = { creditPeriodStart: "2026-07-01T00:00:00+08:00", creditResetAt: "2026-08-01T00:00:00+08:00" };

export const demoAccounts: DemoAccount[] = [
    {
        id: "00000000-0000-4000-8000-000000000001", identifier: "admin", password: "Canvas2026!#", label: "超级管理员", portal: "admin",
        user: { id: "00000000-0000-4000-8000-000000000001", username: "admin", displayName: "测试超级管理员", email: "admin@canvas.local", employeeNo: "A001", role: "super_admin", status: "active", departmentId: null, departmentName: null, groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: true, creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0, ...period },
    },
    {
        id: "00000000-0000-4000-8000-000000000002", identifier: "leader01", password: "Canvas2026!#", label: "设计组长", portal: "designer",
        user: { id: "00000000-0000-4000-8000-000000000002", username: "leader01", displayName: "测试组长", email: "leader01@canvas.local", employeeNo: "L001", role: "designer", status: "active", departmentId: "10000000-0000-4000-8000-000000000001", departmentName: "设计中心", groupId: "20000000-0000-4000-8000-000000000001", groupName: "视觉一组", groupRole: "leader", mustChangePassword: false, mfaEnabled: false, creditBalance: 1500, creditLimit: 1500, monthlyCreditLimit: 1200, temporaryCreditAdjustment: 300, ...period },
    },
    {
        id: "00000000-0000-4000-8000-000000000003", identifier: "designer01", password: "Canvas2026!#", label: "英文设计师账号", portal: "designer",
        user: { id: "00000000-0000-4000-8000-000000000003", username: "designer01", displayName: "设计师小陈", email: "designer01@canvas.local", employeeNo: "D001", role: "designer", status: "active", departmentId: "10000000-0000-4000-8000-000000000001", departmentName: "设计中心", groupId: "20000000-0000-4000-8000-000000000001", groupName: "视觉一组", groupRole: "member", mustChangePassword: false, mfaEnabled: false, creditBalance: 860, creditLimit: 1000, monthlyCreditLimit: 1000, temporaryCreditAdjustment: 0, ...period },
    },
    {
        id: "00000000-0000-4000-8000-000000000004", identifier: "小林", password: "Canvas2026!#", label: "中文设计师账号", portal: "designer",
        user: { id: "00000000-0000-4000-8000-000000000004", username: "小林", displayName: "设计师小林", email: "xiaolin@canvas.local", employeeNo: "D002", role: "designer", status: "active", departmentId: "10000000-0000-4000-8000-000000000001", departmentName: "设计中心", groupId: "20000000-0000-4000-8000-000000000001", groupName: "视觉一组", groupRole: "member", mustChangePassword: false, mfaEnabled: false, creditBalance: 1000, creditLimit: 1000, monthlyCreditLimit: 1000, temporaryCreditAdjustment: 0, ...period },
    },
];

export function authenticateDemoAccount(identifier: string, password: string, portal: DemoPortal) {
    return demoAccounts.find((account) => account.identifier.toLocaleLowerCase() === identifier.trim().toLocaleLowerCase() && account.password === password && account.portal === portal) || null;
}
