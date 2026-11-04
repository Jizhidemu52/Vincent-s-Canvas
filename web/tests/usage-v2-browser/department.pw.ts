import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { fixture } from "./fixture";
import type { UsageV2Overview } from "../../../shared/usage-analytics-v2";

test("department A/B uses current scope, downloads real safe workbook and fits narrow screen", async ({ page, context }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname.endsWith("analysis-models")) return route.fulfill({ json: { code: 0, data: { models: [] }, msg: "ok" } });
        const data = fixture(url);
        if (url.pathname.endsWith("/overview")) {
            const overview = data as UsageV2Overview;
            const a = overview.departments[0];
            a.label = "设计甲部";
            overview.departments = [a, { ...a, key: "other", label: "设计乙部", metrics: { ...a.metrics, activePeople: { ...a.metrics.activePeople, value: 4 } } }, { ...a, key: "third", label: "=部门公式防护" }];
        }
        return route.fulfill({ json: { code: 0, data, msg: "ok" } });
    });
    await page.goto("/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07");
    const panel = page.getByTestId("usage-department-comparison");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("columnheader", { name: "A · 设计甲部", exact: true })).toBeVisible();
    await expect(panel.getByText("+¥3.150000；相对 B +100.0%", { exact: true })).toBeVisible();
    await page.getByLabel("对照部门 B").click();
    await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter({ hasText: "B · =部门公式防护" }).click();
    await expect(panel.getByRole("columnheader", { name: "B · =部门公式防护", exact: true })).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await panel.getByRole("button", { name: "导出部门对照 Excel" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("部门同周期对照.xlsx");
    const workbook = XLSX.read(await readFile((await download.path())!), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]]);
    expect(rows).toHaveLength(11);
    expect(rows.every((row) => row.B部门 === "'=部门公式防护")).toBe(true);
    const notes = JSON.stringify(XLSX.utils.sheet_to_json(workbook.Sheets["筛选与口径"]));
    expect(notes).toContain("2026-09-30T16:00:00.000Z");
    expect(notes).toContain("分子分母");
    await panel.screenshot({ path: resolve(import.meta.dirname, "../../../output/usage-department-browser/department-wide.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByRole("heading", { name: "部门 A/B 同周期对照" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await panel.screenshot({ path: resolve(import.meta.dirname, "../../../output/usage-department-browser/department-narrow.png") });
    expect(errors).toEqual([]);
});
