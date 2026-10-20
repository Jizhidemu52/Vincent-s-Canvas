import Papa from "papaparse";
import type { AccountInput, Department } from "@/services/api/admin-accounts";

export function prepareNewAccount(input: AccountInput, wecomEnabled: boolean): AccountInput {
    const { password, ...account } = input;
    account.employeeNo = account.employeeNo?.trim() || null;
    if (account.role === "department_admin" && !account.departmentId) throw new Error("部门管理员必须指定部门");
    if (wecomEnabled && account.role === "designer") {
        if (!account.employeeNo) throw new Error("请输入企业微信成员账号，须与企业微信通讯录中的成员账号一致");
        return account;
    }
    if (!password) throw new Error("请设置初始密码");
    if (password.length < 12 || password.length > 200) throw new Error("初始密码需为 12 至 200 位");
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error("初始密码必须同时包含字母和数字");
    return { ...account, password };
}

export function parseAccountCsv(csv: string, departments: Department[], wecomEnabled: boolean): AccountInput[] {
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const firstError = parsed.errors[0];
    if (firstError) throw new Error(`CSV 第 ${(firstError.row ?? 0) + 2} 行格式错误：${firstError.message}`);
    if (!parsed.data.length || parsed.data.length > 200) throw new Error("每次请导入 1 至 200 个账号");
    return parsed.data.map((row, index) => {
        try {
            const code = row.departmentCode?.trim();
            const department = code ? departments.find((item) => item.code.toLowerCase() === code.toLowerCase()) : undefined;
            if (code && !department) throw new Error("部门编码不存在");
            return prepareNewAccount({
                username: row.username?.trim(), displayName: row.displayName?.trim(), email: row.email?.trim() || null,
                employeeNo: row.employeeNo?.trim() || null, password: row.password,
                role: row.role?.trim() === "department_admin" ? "department_admin" : "designer",
                departmentId: department?.id || null,
                creditBalance: Number(row.creditBalance || 0), creditLimit: Number(row.creditLimit || 0),
            }, wecomEnabled);
        } catch (error) {
            throw new Error(`CSV 第 ${index + 2} 行：${error instanceof Error ? error.message : "账号信息不合法"}`);
        }
    });
}

export function accountTemplateCsv(departments: Department[], wecomEnabled: boolean): string {
    return Papa.unparse([{
        username: "zhangsan", displayName: "张三", email: "zhangsan@company.com",
        employeeNo: wecomEnabled ? "ZhangSan" : "D001",
        ...(!wecomEnabled ? { password: "Canvas2026Start" } : {}),
        role: "designer", departmentCode: departments[0]?.code || "", creditBalance: 500, creditLimit: 500,
    }]);
}
