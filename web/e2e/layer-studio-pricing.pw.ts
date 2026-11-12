import { expect, test, type Page } from "@playwright/test";
import { MockCanvasApi } from "./fixtures";

const root = "/api/admin/model-configuration";
const provider = { id: "p-a", name: "隔离图层服务", protocol: "apimart", baseUrl: "https://fixture.invalid/v1", enabled: true, hasCredentials: true };
const modelA = { id: "m-a", providerId: provider.id, providerName: provider.name, workflowConfigId: null, workflowName: null, name: "专用模型 A", modelId: "seedream-5-5", capabilities: ["generate"], creditCost: 0, rmbCost: 0, concurrencyLimit: 1, enabled: true };
const modelB = { ...modelA, id: "m-b", name: "专用模型 B", creditCost: 7, rmbCost: 0.012345 };
const storedRates = [{ modelConfigId: modelA.id, inputRmb: 0.031, lowOutputRmb: 0.11, highOutputRmb: 0.22, sourceNote: "隔离测试", version: 3 }];

async function setup(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL); api.role = "super_admin";
    await api.attach(page.context());
    const models = [{ ...modelA }, { ...modelB }];
    const writes: Array<{ method: string; path: string; input: any }> = [];
    const priceRequests: string[] = [];
    await page.context().route("**/api/**", async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false });
        if (!path.startsWith("/api/admin/")) return route.fallback();
        if (path.includes("/prices") || path.includes("/layer-studio-pricing")) {
            priceRequests.push(request.method() + " " + path);
            return json({ prices: storedRates });
        }
        if (path.startsWith(root + "/models/") && request.method() === "PATCH") {
            const input = request.postDataJSON(); writes.push({ method: request.method(), path, input });
            const index = models.findIndex(model => model.id === path.split("/").at(-1));
            const model = { ...models[index], ...input }; models[index] = model;
            return json({ model });
        }
        if (path === root + "/models" && request.method() === "POST") {
            const input = request.postDataJSON(); writes.push({ method: request.method(), path, input });
            return json({ model: { ...input, id: "new-model" } });
        }
        if (request.method() !== "GET") { api.unexpected.push(request.method() + " " + path); return json({ error: "UNEXPECTED_WRITE" }, 501); }
        if (path === "/api/admin/accounts") return json({ users: [], totalUsedCredits: 0 });
        if (path === "/api/admin/departments") return json({ departments: [] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], total: 0, totalRmbCost: 0, nextCursor: null });
        if (path.endsWith("/providers")) return json({ providers: [provider] });
        if (path.endsWith("/models")) return json({ models });
        if (path.endsWith("/workflows")) return json({ workflows: [] });
        if (path.endsWith("/tool-configurations")) return json({ tools: [] });
        api.unexpected.push(request.method() + " " + path); return json({ error: "UNEXPECTED_READ" }, 501);
    });
    return { api, writes, priceRequests, models };
}
async function open(page: Page) {
    await page.goto("/admin?tab=api");
    await page.getByRole("tab", { name: "模型（高级）", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新增模型", exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: /专用模型 A/ })).toBeVisible();
}
function clean(fixture: Awaited<ReturnType<typeof setup>>) {
    expect(fixture.priceRequests).toEqual([]);
    expect(fixture.api.blocked).toEqual([]); expect(fixture.api.unexpected).toEqual([]); expect(fixture.api.pageErrors).toEqual([]);
}

test("model editing hides finance UI and preserves zero and nonzero loaded values", async ({ page }) => {
    const fixture = await setup(page); await open(page);
    await expect(page.getByRole("region", { name: "图层专用费用配置", exact: true })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: /积分|成本/ })).toHaveCount(0);
    await expect(page.getByRole("spinbutton", { name: /积分|人民币|成本|单价/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /保存专用费率|发布价格/ })).toHaveCount(0);
    for (const [index, model] of [modelA, modelB].entries()) {
        await page.getByRole("row", { name: new RegExp(model.name) }).getByRole("button", { name: /^编\s*辑$/ }).click();
        await page.getByRole("spinbutton", { name: "并发", exact: true }).fill(String(index + 3));
        await page.getByRole("button", { name: "保存到服务端", exact: true }).click();
        await expect.poll(() => fixture.writes.length).toBe(index + 1);
        expect(fixture.writes[index]).toMatchObject({ method: "PATCH", path: root + "/models/" + model.id,
            input: { creditCost: model.creditCost, rmbCost: model.rmbCost, concurrencyLimit: index + 3, modelId: model.modelId } });
        await expect(page.getByRole("heading", { name: "新增模型", exact: true })).toBeVisible();
    }
    clean(fixture);
});

test("new model keeps prior defaults with no financial inputs or rate reads", async ({ page }) => {
    const fixture = await setup(page); await open(page);
    await page.getByRole("combobox", { name: /Provider$/ }).click();
    await page.getByText(provider.name, { exact: true }).last().click();
    await page.getByRole("textbox", { name: /管理员模型名称$/ }).fill("新建隔离模型");
    await page.getByRole("textbox", { name: /模型 ID$/ }).fill("seedream-5-5");
    await page.getByRole("button", { name: "保存到服务端", exact: true }).click();
    await expect.poll(() => fixture.writes.length).toBe(1);
    expect(fixture.writes[0]).toMatchObject({ method: "POST", path: root + "/models", input: { creditCost: 4, rmbCost: 0.4, concurrencyLimit: 5, enabled: true } });
    clean(fixture);
});

test("model controls fit narrow screens and the retired pricing deep link exposes no finance", async ({ page }) => {
    const fixture = await setup(page); await page.setViewportSize({ width: 390, height: 844 }); await open(page);
    const form = page.getByRole("heading", { name: "新增模型", exact: true }).locator("..");
    await form.scrollIntoViewIfNeeded();
    expect(await form.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
    await expect(form.getByRole("spinbutton")).toHaveCount(1);
    await page.goto("/admin?tab=prices");
    await expect(page.getByRole("tab", { name: /积分与价格|费用配置/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /保存专用费率|发布价格|保存草稿/ })).toHaveCount(0);
    expect(fixture.writes).toEqual([]); clean(fixture);
});
