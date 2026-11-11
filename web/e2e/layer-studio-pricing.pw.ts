import { expect, test, type Page, type Route } from "@playwright/test";
import { MockCanvasApi } from "./fixtures";

const root = "/api/admin/model-configuration/layer-studio-pricing";
const provider = { id: "p-a", name: "隔离图层服务", protocol: "apimart", baseUrl: "https://fixture.invalid/v1", enabled: true, hasCredentials: true };
const modelA = { id: "m-a", providerId: provider.id, providerName: provider.name, workflowConfigId: null, workflowName: null, name: "费用模型 A", modelId: "seedream-5-5", capabilities: ["generate"], creditCost: 0, rmbCost: 0, concurrencyLimit: 1, enabled: true };
const modelB = { ...modelA, id: "m-b", name: "费用模型 B" };
const existing = { modelConfigId: modelA.id, inputRmb: 0.031, lowOutputRmb: 0.11, highOutputRmb: 0.22, sourceNote: "仅供隔离测试的已确认依据", version: 3, updatedAt: "2026-11-11T00:00:00Z" };

async function setup(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL); api.role = "super_admin";
    await api.attach(page.context());
    const rates: Array<typeof existing> = [];
    const writes: Array<{ method: string; path: string; input: any }> = [];
    const held: Array<{ route: Route; price: typeof existing }> = [];
    const flags = { hold: false, abortAfterSave: false, failSave: false, failLoad: false };
    await page.context().route("**/api/**", async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false });
        if (!path.startsWith("/api/admin/")) return route.fallback();
        if (path === root && request.method() === "GET") return flags.failLoad ? json({ message: "unavailable" }, 503) : json({ prices: rates });
        if (path.startsWith(`${root}/`) && request.method() === "PUT") {
            const input = request.postDataJSON(); writes.push({ method: request.method(), path, input });
            if (flags.failSave) return json({ message: "invalid fixture" }, 400);
            const modelConfigId = path.split("/").at(-1)!;
            const previous = rates.find(item => item.modelConfigId === modelConfigId);
            const price = { ...input, modelConfigId, version: (previous?.version || 0) + 1, updatedAt: new Date().toISOString() };
            rates.splice(0, rates.length, ...rates.filter(item => item.modelConfigId !== modelConfigId), price);
            if (flags.hold) { held.push({ route, price }); return; }
            if (flags.abortAfterSave) return route.abort("connectionreset");
            return json({ price });
        }
        if (request.method() !== "GET") { api.unexpected.push(`${request.method()} ${path}`); return json({ error: "UNEXPECTED_WRITE" }, 501); }
        if (path === "/api/admin/accounts") return json({ users: [], totalUsedCredits: 0 });
        if (path === "/api/admin/departments") return json({ departments: [] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], total: 0, totalRmbCost: 0, nextCursor: null });
        if (path.endsWith("/providers")) return json({ providers: [provider, { ...provider, id: "p-b", name: "非适用协议", protocol: "openai" }] });
        if (path.endsWith("/models")) return json({ models: [modelA, modelB, { ...modelA, id: "m-c", name: "不应可选协议", providerId: "p-b" }, { ...modelA, id: "m-d", name: "不应可选工作流", workflowConfigId: "workflow" }] });
        if (path.endsWith("/prices")) return json({ prices: [] });
        if (path.endsWith("/workflows")) return json({ workflows: [] });
        if (path.endsWith("/tool-configurations")) return json({ tools: [] });
        api.unexpected.push(`${request.method()} ${path}`); return json({ error: "UNEXPECTED_READ" }, 501);
    });
    return { api, rates, writes, flags, async release() { for (const item of held.splice(0)) await item.route.fulfill({ json: { price: item.price } }); } };
}
const panel = (page: Page) => page.getByRole("region", { name: "图层专用费用配置", exact: true });
const input = (page: Page) => panel(page).getByRole("spinbutton", { name: /输入图单价/ });
const low = (page: Page) => panel(page).getByRole("spinbutton", { name: /低档输出单价/ });
const high = (page: Page) => panel(page).getByRole("spinbutton", { name: /高档输出单价/ });
const source = (page: Page) => panel(page).getByRole("textbox", { name: /费率确认依据/ });
// Ant Design's leaving loading icon can temporarily prefix the accessible name.
const save = (page: Page) => panel(page).getByRole("button", { name: /保存专用费率$/ });
async function open(page: Page) {
    await page.goto("/admin?tab=api");
    await page.getByRole("tab", { name: "模型（高级）", exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await expect(input(page)).toBeEnabled();
}
function clean(fixture: Awaited<ReturnType<typeof setup>>) { expect(fixture.api.blocked).toEqual([]); expect(fixture.api.unexpected).toEqual([]); expect(fixture.api.pageErrors).toEqual([]); }

test("unconfigured rates stay blank; explicit zero and double submission produce one PUT", async ({ page }) => {
    const fixture = await setup(page); fixture.flags.hold = true;
    await open(page);
    await expect(panel(page).getByText("未配置", { exact: true })).toBeVisible();
    for (const field of [input(page), low(page), high(page), source(page)]) await expect(field).toHaveValue("");
    await low(page).fill("0.1"); await high(page).fill("0.2"); await source(page).fill("隔离测试明确依据");
    await save(page).click();
    await expect(panel(page).getByText("请明确填写输入图单价，不默认免费。", { exact: true })).toBeVisible();
    expect(fixture.writes).toHaveLength(0);
    await input(page).fill("0");
    await panel(page).locator("form").evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
    await expect.poll(() => fixture.writes.length).toBe(1);
    await expect(panel(page).getByRole("combobox", { name: "费用配置模型", exact: true })).toBeDisabled();
    expect(fixture.writes[0]).toEqual({ method: "PUT", path: `${root}/m-a`, input: { inputRmb: 0, lowOutputRmb: 0.1, highOutputRmb: 0.2, sourceNote: "隔离测试明确依据" } });
    await fixture.release();
    await expect(panel(page).getByText("已配置 · 版本 1", { exact: true })).toBeVisible();
    await expect(save(page)).toBeDisabled(); clean(fixture);
});

test("reads all existing rates and failed save preserves values; invalid amounts never submit", async ({ page }) => {
    const fixture = await setup(page); fixture.rates.push({ ...existing }); fixture.flags.failSave = true;
    await open(page);
    await expect(input(page)).toHaveValue("0.031"); await expect(low(page)).toHaveValue("0.11"); await expect(high(page)).toHaveValue("0.22");
    await expect(source(page)).toHaveValue(existing.sourceNote);
    await high(page).fill("0.01"); await save(page).click();
    await expect(panel(page).getByText(/高档必须大于 0，且不能低于低档/)).toBeVisible(); expect(fixture.writes).toHaveLength(0);
    await high(page).fill("0.3"); await input(page).fill("0.0000001"); await save(page).click();
    await expect(panel(page).getByText(/费率最多支持 6 位小数/)).toBeVisible(); expect(fixture.writes).toHaveLength(0);
    await input(page).fill("0.04"); await save(page).click();
    await expect.poll(() => fixture.writes.length).toBe(1);
    await expect(panel(page).getByText(/费率或模型条件不符合要求/)).toBeVisible();
    await expect(input(page)).toHaveValue("0.04"); await expect(high(page)).toHaveValue("0.3");
    await expect(source(page)).toHaveValue(existing.sourceNote); clean(fixture);
});

test("model switch and navigation guard keep drafts; ineligible models cannot be selected", async ({ page }) => {
    const fixture = await setup(page); fixture.rates.push({ ...existing });
    await open(page);
    await input(page).fill("0.05");
    await panel(page).getByRole("combobox", { name: "费用配置模型", exact: true }).click();
    await expect(page.getByRole("option", { name: /不应可选/ })).toHaveCount(0);
    await page.getByText("费用模型 B · 隔离图层服务 · seedream-5-5", { exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("图层专用费率尚未保存");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(input(page)).toHaveValue("0.05");
    await page.getByRole("tab", { name: "工作流（高级）", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("图层专用费率尚未保存");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(input(page)).toHaveValue("0.05");
    await panel(page).getByRole("combobox", { name: "费用配置模型", exact: true }).click();
    await page.getByText("费用模型 B · 隔离图层服务 · seedream-5-5", { exact: true }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    for (const field of [input(page), low(page), high(page), source(page)]) await expect(field).toHaveValue("");
    expect(fixture.writes).toHaveLength(0); clean(fixture);
});

test("uncertain write requires a GET check, retains edits and never repeats PUT", async ({ page }) => {
    const fixture = await setup(page); fixture.rates.push({ ...existing }); fixture.flags.abortAfterSave = true;
    await open(page); await input(page).fill("0.04"); await save(page).click();
    await expect(panel(page).getByText(/保存结果待核对；编辑内容已保留/)).toBeVisible();
    await expect(save(page)).toBeDisabled(); await expect(input(page)).toHaveValue("0.04");
    expect(fixture.writes).toHaveLength(1);
    await panel(page).getByRole("button", { name: "读取服务端配置", exact: true }).click();
    await expect(panel(page).getByText("已配置 · 版本 4", { exact: true })).toBeVisible();
    await expect(save(page)).toBeDisabled(); await expect(input(page)).toHaveValue("0.04");
    expect(fixture.writes).toHaveLength(1);
    await panel(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "../output/seedream55-integration/pricing-desktop.png", fullPage: true });
    clean(fixture);
});

test("narrow pricing panel stays within viewport and failed read does not discard edits", async ({ page }) => {
    const fixture = await setup(page); fixture.rates.push({ ...existing });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page); await input(page).fill("0.07"); fixture.flags.failLoad = true;
    await panel(page).getByRole("button", { name: "读取服务端配置", exact: true }).click();
    await expect(panel(page).getByText("费率暂时无法读取。", { exact: true })).toBeVisible();
    await expect(input(page)).toHaveValue("0.07"); expect(fixture.writes).toHaveLength(0);
    await panel(page).scrollIntoViewIfNeeded();
    expect(await panel(page).evaluate(element => element.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: "../output/seedream55-integration/pricing-mobile.png", fullPage: true });
    clean(fixture);
});
