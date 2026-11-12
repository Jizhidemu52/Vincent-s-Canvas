import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import Papa from "papaparse";
import { MockCanvasApi } from "./fixtures";
import { chooseAntSelect } from "./antd-select-helpers";

const summary = { visits: 1, interactions: 3, generationRequests: 2, chatRequests: 0, succeeded: 2, failed: 0, pending: 0, totalRmbCost: 7.125, generatedImages: 2 };
const coverage = { collectionStartedAt: "2026-11-01T00:00:00Z", historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, notes: ["完整记录；用户业务文字保持原样。", "生成成本汇总已保存的成功生成历史人民币金额（含图片、视频和音频），不按新单价重算。", "当前筛选中有 2 个成功任务缺少成功结算历史，费用未计入且不补估；已保存的图片结果仍计入张数。"] };
const userId = "20000000-0000-4000-8000-000000000001";
const person = { userId, displayName: "测试设计师", departmentName: "设计部", summary, lastActivityAt: "2026-11-12T03:00:00Z" };
const prompt = '报价99元,"针织纹理"\n第二行😀 rmbCostOverride 是用户文字';
const usageRecord = { id: "generation-1", kind: "generation", userId, displayName: person.displayName, boardKey: "image", boardLabel: "图片生成", action: "generation", controlKey: null, controlLabel: null, modelConfigId: null, modelName: "模型A", status: "success", occurredAt: "2026-11-12T03:00:00Z", updatedAt: "2026-11-12T03:00:00Z", totalRmbCost: 7.125, generatedImages: 2, prompt, promptRedacted: false, parameters: { width: 1024, seed: 0, enabled: false, nested: { rmbCostOverride: 0, creditCostOverride: null, keep: "原值" } } };
const csvHeader = ["时间", "设计师", "部门", "项目", "操作", "模型", "提示词", "积分", "人民币成本", "状态", "失败原因", "原图", "结果图"];
const csvRow = [usageRecord.occurredAt, person.displayName, "设计部", "project-7", "image_generation", "模型A", prompt, "12", "7.125", "success", "", "https://example.invalid/source.png", "https://example.invalid/result.png"];

async function setup(page: Page, incomplete = false) {
    const api = new MockCanvasApi(test.info().project.use.baseURL); api.role = "super_admin";
    await api.attach(page.context());
    const requests: Array<{ path: string; input: Record<string, unknown> }> = [];
    await page.context().route("**/api/**", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        const json = (data: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
        const ok = (data: unknown) => json({ code: 0, data, msg: "ok" });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false, wecomLoginUrl: null });
        if (path === "/api/admin/accounts") return json({ users: [{ id: userId, ...person, username: "fixture", role: "designer", status: "active", creditBalance: 100 }], totalUsedCredits: 12 });
        if (path === "/api/admin/departments") return json({ departments: [] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [
            { id: "audit-tool", action: "tool_api_configuration.updated", targetType: "tool", targetId: "image", result: "success", createdAt: usageRecord.occurredAt, detail: { enabled: false, modelConfigId: "model-1", configurationVersion: 0, creditCostOverride: 12345, rmbCostOverride: 987.65, prompt } },
            { id: "audit-model", action: "model.updated", targetType: "model", targetId: "model-1", result: "success", createdAt: usageRecord.occurredAt, detail: { fields: ["name", "creditCost", "rmbCost", "enabled"] } },
            { id: "audit-credit", action: "credits.policy_changed", targetType: "credit_policy", result: "success", createdAt: usageRecord.occurredAt, detail: { creditsEnabled: true } },
        ] });
        if (path === "/api/admin/history/options") return json({ users: [], models: [], operations: [] });
        if (path === "/api/admin/history") return json({ history: [{ id: "history-1", createdAt: usageRecord.occurredAt, userName: person.displayName, departmentName: "设计部", projectId: "project-7", operationType: "image_generation", modelName: "模型A", prompt, credits: 12, rmbCost: 7.125, status: "success", resultUrls: [] }], total: 1, totalRmbCost: 7.125, nextCursor: null, hasMore: false });
        if (path === "/api/admin/history/export") {
            requests.push({ path, input: Object.fromEntries(url.searchParams) });
            return route.fulfill({ contentType: "text/csv;charset=utf-8", body: "\uFEFF" + Papa.unparse([csvHeader, csvRow, [...csvRow.slice(0, 6), "'=1+1", ...csvRow.slice(7)]], { quotes: true, newline: "\r\n" }) });
        }
        if (!path.startsWith("/api/admin/usage/")) return route.fallback();
        const input = request.method() === "GET" ? Object.fromEntries(url.searchParams) : request.postDataJSON();
        if (path.endsWith("/analysis-models")) return ok({ models: [] });
        if (path.endsWith("/people")) return ok({ people: [person], pagination: { page: 1, pageSize: 20, total: 1 }, summary, breakdowns: { boards: [], models: [], controls: [], daily: [] }, coverage });
        if (path.endsWith("/export")) {
            requests.push({ path, input });
            const rows = [{ type: "manifest", version: 1, filters: input, coverage, exportedAt: usageRecord.occurredAt }, { type: "record", record: usageRecord }, { type: "record", record: { ...usageRecord, id: "generation-2", prompt: "'=1+1" } }, ...(incomplete ? [] : [{ type: "complete", recordCount: 2 }])];
            return route.fulfill({ contentType: "application/x-ndjson", body: rows.map(row => JSON.stringify(row)).join("\n") + "\n" });
        }
        api.unexpected.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "MOCK_BLOCKED", msg: "No live actions allowed" }) });
    });
    return { api, requests };
}

async function openUsageExport(page: Page) {
    await page.goto("/admin?tab=usage-analysis");
    await expect(page.getByRole("heading", { name: "每日趋势", exact: true })).toBeVisible();
    await page.getByLabel("使用分析开始日期", { exact: true }).fill("2026-11-11");
    await page.getByLabel("使用分析结束日期", { exact: true }).fill("2026-11-12");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(page.getByLabel("使用分析已应用范围")).toContainText("2026-11-11 至 2026-11-12");
    await page.getByRole("button", { name: "导出筛选范围完整记录", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "导出完整使用记录" })).toBeVisible();
}

function assertProjectedJsonl(text: string) {
    const rows = text.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.type)).toEqual(["manifest", "record", "record", "complete"]);
    expect(rows[0].filters).toEqual({ from: "2026-11-10T16:00:00.000Z", to: "2026-11-12T16:00:00.000Z" });
    expect(rows[0].coverage.notes).toEqual(["完整记录；用户业务文字保持原样。", "已保存的图片结果仍计入张数。"]);
    expect(rows[1].record).toEqual({ ...usageRecord, totalRmbCost: undefined, parameters: { width: 1024, seed: 0, enabled: false, nested: { keep: "原值" } } });
    expect(rows[2].record.id).toBe("generation-2");
    expect(rows[2].record.prompt).toBe("'=1+1");
    expect(rows[3]).toEqual({ type: "complete", recordCount: 2 });
    expect(text).not.toContain('"totalRmbCost"');
    expect(text).not.toContain('"creditCostOverride"');
    expect(text).not.toContain('"rmbCostOverride"');
}

async function installPicker(page: Page) {
    await page.addInitScript(() => {
        const state = { chunks: [] as string[], closed: false, aborted: false, options: null as unknown };
        Object.assign(window, { financeExportState: state, showSaveFilePicker: async (options: unknown) => {
            state.options = options;
            return { createWritable: async () => ({ write: async (chunk: Uint8Array) => { state.chunks.push(new TextDecoder().decode(chunk)); }, close: async () => { state.closed = true; }, abort: async () => { state.aborted = true; } }) };
        } });
    });
}

test("mounted audit removes override values and financial changed-field labels while retaining ordinary details", async ({ page }) => {
    const { api } = await setup(page);
    await page.goto("/admin?tab=audit");
    const rows = page.getByRole("row");
    const tool = rows.filter({ hasText: "tool_api_configuration.updated" });
    await tool.getByText("查看内容", { exact: true }).click();
    await expect(tool).toContainText(prompt);
    await expect(tool).toContainText("model-1");
    await expect(tool).not.toContainText("12345");
    await expect(tool).not.toContainText("987.65");
    const model = rows.filter({ hasText: "模型：更新" });
    await model.getByText("查看内容", { exact: true }).click();
    await expect(model).toContainText("启用状态");
    await expect(model).not.toContainText("creditCost");
    await expect(model).not.toContainText("人民币成本");
    await expect(page.getByText("credits.policy_changed", { exact: true })).toHaveCount(0);
    expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
});

test("usage browser download contains complete nonfinancial JSONL with original text and scope", async ({ page }) => {
    const { api, requests } = await setup(page);
    await openUsageExport(page);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "开始导出完整记录", exact: true }).click();
    const download = await downloading;
    assertProjectedJsonl(await readFile((await download.path())!, "utf8"));
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual({ from: "2026-11-10T16:00:00.000Z", to: "2026-11-12T16:00:00.000Z" });
    await expect(page.getByText("已完整导出 2 条记录。", { exact: false })).toBeVisible();
    expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
});

test("usage save-location path writes projected lines and closes only after complete count", async ({ page }) => {
    await installPicker(page);
    const { api, requests } = await setup(page);
    await openUsageExport(page);
    await chooseAntSelect(page.getByLabel("使用记录保存方式", { exact: true }), "选择保存位置（可选择桌面，适合大文件）");
    await page.getByRole("button", { name: "开始导出完整记录", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).financeExportState.closed)).toBe(true);
    const state = await page.evaluate(() => (window as any).financeExportState);
    expect(state.aborted).toBe(false);
    expect(state.chunks.length).toBe(4);
    expect(state.options.startIn).toBe("desktop");
    assertProjectedJsonl(state.chunks.join(""));
    expect(requests).toHaveLength(1);
    expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
});

test("incomplete save-location export aborts instead of closing or reporting success", async ({ page }) => {
    await installPicker(page);
    const { api, requests } = await setup(page, true);
    await openUsageExport(page);
    await chooseAntSelect(page.getByLabel("使用记录保存方式", { exact: true }), "选择保存位置（可选择桌面，适合大文件）");
    await page.getByRole("button", { name: "开始导出完整记录", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).financeExportState.aborted)).toBe(true);
    expect(await page.evaluate(() => (window as any).financeExportState.closed)).toBe(false);
    await expect(page.getByRole("dialog")).toContainText("未收到完整结束标记");
    expect(requests).toHaveLength(1);
    expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
});

test("admin history browser CSV download retains prompt quoting, formula guard and filter but no finance columns", async ({ page }) => {
    const { api, requests } = await setup(page);
    await page.goto("/admin?tab=history");
    await page.getByPlaceholder("项目 ID", { exact: true }).fill("project-7");
    await page.getByRole("button", { name: "查询项目", exact: true }).click();
    const button = page.getByRole("button", { name: "导出当前结果", exact: true });
    await expect(button).toBeEnabled();
    const downloading = page.waitForEvent("download");
    await button.click();
    const csv = await readFile((await (await downloading).path())!, "utf8");
    const rows = Papa.parse<string[]>(csv).data;
    expect(rows[0]).toEqual(["时间", "设计师", "部门", "项目", "操作", "模型", "提示词", "状态", "失败原因", "原图", "结果图"]);
    expect(rows[1][6]).toBe(prompt);
    expect(rows[2][6]).toBe("'=1+1");
    expect(rows).toHaveLength(3);
    expect(csv).not.toContain('"人民币成本"');
    expect(csv).not.toContain('"7.125"');
    expect(requests).toEqual([{ path: "/api/admin/history/export", input: { projectId: "project-7" } }]);
    expect(api.unexpected).toEqual([]); expect(api.pageErrors).toEqual([]);
});
