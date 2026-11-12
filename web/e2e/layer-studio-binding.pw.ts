import { expect, test } from "@playwright/test";
import { MockCanvasApi } from "./fixtures";

test("layer studio binding stays explicit and exclusive without financial controls", async ({ page }) => {
    const api = new MockCanvasApi(test.info().project.use.baseURL); api.role = "super_admin";
    await api.attach(page.context());
    const root = "/api/admin/model-configuration";
    const provider = { id: "p-layer", name: "隔离专用服务", protocol: "apimart", baseUrl: "https://fixture.invalid/v1", enabled: true, hasCredentials: true };
    const model = { id: "m-layer", name: "专用图层模型", modelId: "seedream-5-5", providerId: provider.id, providerName: provider.name, workflowConfigId: null, workflowName: null, capabilities: ["generate"], creditCost: 4, rmbCost: 0.4, concurrencyLimit: 1, enabled: true };
    const writes: Array<{ path: string; input: Record<string, unknown> }> = [];
    const configurations: Array<Record<string, unknown>> = [{ toolKey: "layer-studio", enabled: false, modelConfigId: null, creditCostOverride: 0, rmbCostOverride: null }];
    await page.context().route("**/api/**", async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false });
        if (!path.startsWith("/api/admin/")) return route.fallback();
        if (path === `${root}/tool-configurations/layer-studio` && request.method() === "PUT") {
            const input = request.postDataJSON(); writes.push({ path, input });
            const tool = { toolKey: "layer-studio", ...input, modelName: model.name, providerName: provider.name, configurationVersion: 1 };
            configurations.splice(0, configurations.length, tool);
            return json({ tool });
        }
        if (request.method() !== "GET") { api.unexpected.push(`${request.method()} ${path}`); return json({ error: "UNEXPECTED_WRITE" }, 501); }
        if (path === "/api/admin/accounts") return json({ users: [], totalUsedCredits: 0 });
        if (path === "/api/admin/departments") return json({ departments: [] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], total: 0, totalRmbCost: 0, nextCursor: null });
        if (path === `${root}/providers`) return json({ providers: [provider, { ...provider, id: "p-other", protocol: "openai" }] });
        if (path === `${root}/models`) return json({ models: [model,
            { ...model, id: "m-wrong-protocol", name: "不可选协议", providerId: "p-other" },
            { ...model, id: "m-workflow", name: "不可选工作流", workflowConfigId: "flow" },
            { ...model, id: "m-normal", name: "普通图片模型", modelId: "ordinary-image" }] });
        if (path === "/api/admin/workflows") return json({ workflows: [{ id: "flow", enabled: true }] });
        if (path === `${root}/tool-configurations`) return json({ tools: configurations });
        api.unexpected.push(`${request.method()} ${path}`); return json({ error: "UNEXPECTED_READ" }, 501);
    });

    await page.goto("/admin?tab=api");
    const studioCard = page.locator('[data-tool-key="layer-studio"]');
    await expect(studioCard).toContainText("已停用");
    await expect(studioCard).toContainText("未绑定专属模型");
    await expect(studioCard).not.toContainText("继承 / 用户选择");
    await expect(studioCard).not.toContainText(/积分|成本|费率/);
    await studioCard.getByRole("button", { name: "配置本板块", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "配置图层拆分与图片生成", exact: true });
    const binding = dialog.getByRole("combobox", { name: "本板块模型绑定", exact: true });
    await expect(dialog.getByRole("switch", { name: "本板块 API 启用", exact: true })).not.toBeChecked();
    await expect(dialog).toContainText("前台不显示模型名称或选择器");
    await expect(dialog).not.toContainText("由用户选择");
    await expect(dialog.getByRole("spinbutton", { name: "人民币成本总额 / 次（可选）", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "配置图层专用费率", exact: true })).toHaveCount(0);
    await dialog.getByRole("switch", { name: "本板块 API 启用", exact: true }).click();
    await dialog.getByRole("button", { name: "仅保存当前板块并同步", exact: true }).click();
    await expect(dialog.getByText("启用前请选择可用的图层专属模型", { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await binding.click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option")).toHaveAccessibleName("专用图层模型 · 隔离专用服务 · seedream-5-5");
    await page.getByText("专用图层模型 · 隔离专用服务 · seedream-5-5", { exact: true }).click();
    await expect(dialog.getByRole("spinbutton")).toHaveCount(0);
    await dialog.getByRole("button", { name: "仅保存当前板块并同步", exact: true }).click();
    await page.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ path: `${root}/tool-configurations/layer-studio`, input: { modelConfigId: "m-layer", enabled: true, creditCostOverride: 0, rmbCostOverride: null } });
    await expect(dialog).toHaveCount(0);
    await expect(studioCard).toContainText("已绑定");
    await expect(studioCard).not.toContainText(/积分|成本|费率/);

    await page.locator('[data-tool-key="image"]').getByRole("button", { name: "配置本板块", exact: true }).click();
    const imageDialog = page.getByRole("dialog", { name: "配置文生图", exact: true });
    await imageDialog.getByRole("combobox", { name: "本板块模型绑定", exact: true }).click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option")).toHaveAccessibleName("普通图片模型 · 隔离专用服务 · ordinary-image");
    expect(writes).toHaveLength(1);
    expect(api.pageErrors).toEqual([]); expect(api.unexpected).toEqual([]); expect(api.blocked).toEqual([]);
});
