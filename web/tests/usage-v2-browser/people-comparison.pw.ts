import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { fixture } from "./fixture";
import { peopleComparisonFixture } from "./people-comparison-fixture";
import type { UsagePeopleComparisonRequest } from "../../../shared/usage-people-comparison";
const url = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uTab=people&uFrom=2026-10-01&uTo=2026-10-07";

test("explicit comparison preserves team scope, exports exact workbook and fits narrow dark", async ({ page, context }) => {
    const calls: UsagePeopleComparisonRequest[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const target = new URL(route.request().url()); if (target.hostname !== "127.0.0.1") return route.abort();
        if (!target.pathname.startsWith("/api/")) return route.continue();
        if (target.pathname.endsWith("/people-compare")) {
            const body = route.request().postDataJSON() as UsagePeopleComparisonRequest; calls.push(body);
            return route.fulfill({ json: { code: 0, data: peopleComparisonFixture(body.filters, body.selectedUserIds, ["=公式防护", "比较员工乙"]) } });
        }
        return route.fulfill({ json: { code: 0, data: fixture(target) } });
    });
    await page.goto(`${url}&theme=dark`);
    await page.getByLabel("对比选择 测试设计师甲", { exact: true }).check();
    await page.getByLabel("对比选择 测试设计师乙", { exact: true }).check();
    expect(calls).toHaveLength(0);
    await page.getByRole("button", { name: "读取所选人员对比", exact: true }).click();
    const panel = page.getByTestId("usage-people-comparison"); await expect(panel).toBeVisible();
    expect(calls).toHaveLength(1); expect(calls[0].filters.userIds).toBeUndefined(); expect(calls[0].selectedUserIds).toHaveLength(2);
    await expect(panel).toContainText("范围名册 6 人；本期有记录活跃 4 人");
    await expect(panel).toContainText("非个人均值");
    const saved = page.waitForEvent("download"); await panel.getByRole("button", { name: "导出人员团队对照 Excel" }).click();
    const download = await saved; expect(download.suggestedFilename()).toBe("人员与原范围团队对照.xlsx");
    const book = XLSX.read(await readFile((await download.path())!), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets["当前页明细"]);
    expect(rows).toHaveLength(35); expect(rows.filter(row => row.对象 === "'=公式防护")).toHaveLength(11);
    expect(rows.find(row => row.指标 === "按范围名册人均记账金额")).toMatchObject({ 精确金额: "10.500000", 分母: 6 });
    const notes = JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets["筛选与口径"])); expect(notes).toContain("2026-09-30T16:00:00.000Z"); expect(notes).toContain("混合刷新时点");
    await panel.screenshot({ path: resolve(import.meta.dirname, "../../../output/usage-people-comparison-browser/comparison-wide.png") });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await panel.screenshot({ path: resolve(import.meta.dirname, "../../../output/usage-people-comparison-browser/comparison-narrow.png") });
    await page.getByLabel("分析开始日期").fill("2026-10-02"); await expect(panel).toHaveCount(0); expect(calls).toHaveLength(1); expect(errors).toEqual([]);
});

test("a pending comparison is discarded after clearing selection with no automatic resend", async ({ page, context }) => {
    let finish!: () => void, calls = 0;
    const responseGate = new Promise<void>(resolve => { finish = resolve; });
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const target = new URL(route.request().url()); if (target.hostname !== "127.0.0.1") return route.abort();
        if (!target.pathname.startsWith("/api/")) return route.continue();
        if (target.pathname.endsWith("/people-compare")) {
            calls++; const body = route.request().postDataJSON() as UsagePeopleComparisonRequest;
            await responseGate; await route.fulfill({ json: { code: 0, data: peopleComparisonFixture(body.filters, body.selectedUserIds) } }).catch(() => {}); return;
        }
        return route.fulfill({ json: { code: 0, data: fixture(target) } });
    });
    await page.goto(url); await page.getByLabel("对比选择 测试设计师甲", { exact: true }).check(); await page.getByLabel("对比选择 测试设计师乙", { exact: true }).check();
    await page.getByRole("button", { name: "读取所选人员对比", exact: true }).click(); await expect.poll(() => calls).toBe(1);
    await page.getByRole("button", { name: "清空对比选择", exact: true }).click(); finish();
    await expect(page.getByText("跨页已选 0 / 5 人", { exact: true })).toBeVisible(); await expect(page.getByTestId("usage-people-comparison")).toHaveCount(0); expect(calls).toBe(1);
});
