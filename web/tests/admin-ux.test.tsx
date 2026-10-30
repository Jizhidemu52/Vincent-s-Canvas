import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { creditChangeError, filterAdminAccounts } from "../src/pages/admin/account-ux";
import { AdminDetails, adminLabel } from "../src/pages/admin/admin-labels";
import type { ApiUser } from "../src/services/api/auth";

const account = { id: "one", displayName: "张三", username: "zhangsan", email: "one@example.test", employeeNo: "D001", departmentId: "design", departmentName: "设计部", role: "designer", status: "active", creditBalance: 100 } as ApiUser;

test("credit validation rejects absent targets, zero/noninteger amounts, empty reasons and overdrafts", () => {
    expect(creditChangeError(undefined, 1, "原因")).toContain("明确选择");
    for (const amount of [0, Number.NaN, 0.5, 100001]) expect(creditChangeError(account, amount, "原因")).toContain("非零整数");
    expect(creditChangeError(account, 1, "  ")).toContain("原因");
    expect(creditChangeError(account, -101, "调整")).toContain("余额不能小于");
    expect(creditChangeError(account, -100, "调整")).toBe("");
});

test("account search matches people fields and intersects status/department filters", () => {
    const accounts = [account, { ...account, id: "two", username: "lisi", displayName: "李四", status: "disabled", departmentId: "other" } as ApiUser];
    expect(filterAdminAccounts(accounts, "ZHANG", "active", "design").map(item => item.id)).toEqual(["one"]);
    expect(filterAdminAccounts(accounts, "D001", "disabled", "other").map(item => item.id)).toEqual(["two"]);
    expect(filterAdminAccounts(accounts, "张三", "disabled", "")).toEqual([]);
});

test("semantic labels and nested readable details preserve values and Beijing instants", () => {
    expect(adminLabel("task.admin_cancelled")).toBe("任务：管理员取消");
    expect(adminLabel("image_generation")).toBe("图像生成");
    const html = renderToStaticMarkup(<AdminDetails value={{ credits: 0, enabled: false, createdAt: "2026-10-29T17:02:03Z", before: { status: "active" } }} />);
    for (const value of ["积分", ">0<", "否", "2026-10-30 01:02:03", "北京时间", "修改前", "启用"]) expect(html).toContain(value);
    expect(html).not.toContain("<pre");
});
