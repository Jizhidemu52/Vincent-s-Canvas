import { expect, test } from "@playwright/test";
import { MockCanvasApi } from "./fixtures";
import type { ImageModelDefaults } from "../../shared/image-generation-defaults";

test("admin can select a default model and save a separate model's background", async ({ page }, info) => {
    const api = new MockCanvasApi(info.project.use.baseURL);
    api.role = "super_admin";
    await api.attach(page.context());
    const flare = "10000000-0000-4000-8000-000000000001", qwen = "10000000-0000-4000-8000-000000000002";
    const data = {
        defaultModelConfigId: null as string | null, effectiveModelConfigId: flare, systemDefaultModelConfigId: flare,
        modelOptions: {} as Record<string, ImageModelDefaults>,
        models: [
            { id: flare, modelId: flare, name: "GPT Image 2.6 Flare", imageParameterProfile: "quality-resolution-v2", imageDefaultBackground: "opaque" },
            { id: qwen, modelId: qwen, name: "Qwen Image 3.0", imageParameterProfile: "qwen-image" },
        ],
    };
    await page.route("**/api/admin/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/image-defaults")) {
            if (route.request().method() === "PUT") {
                const change = route.request().postDataJSON();
                if ("defaultModelConfigId" in change) data.defaultModelConfigId = change.defaultModelConfigId;
                data.effectiveModelConfigId = data.defaultModelConfigId ?? flare;
                if (change.options) data.modelOptions[change.modelConfigId] = change.options;
            }
            return route.fulfill({ json: { code: 0, data, msg: "" } });
        }
        return route.fulfill({ json: { tools: [], workflows: [], models: [], providers: [], users: [], departments: [], history: [], auditLogs: [] } });
    });
    const open = async () => {
        await page.goto("/admin?tab=api");
        await page.getByRole("tab", { name: "默认图片模型", exact: true }).click();
    };
    const select = async (field: string, label: string) => {
        const combo = page.getByRole("combobox", { name: field, exact: true });
        await combo.click();
        const listId = await combo.getAttribute("aria-controls");
        await page.locator(".ant-select-dropdown").filter({ has: page.locator(`[id="${listId}"]`) }).getByText(label, { exact: true }).click();
    };
    await open();
    await expect(page.getByText("模型默认（不透明）", { exact: true })).toBeVisible();
    await select("全局默认图片模型", "Qwen Image 3.0");
    await expect(page.getByRole("combobox", { name: "背景", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "排除内容" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("qwen-parameters.png") });
    expect(data.defaultModelConfigId).toBeNull();
    await select("全局默认图片模型", "跟随系统默认（GPT Image 2.6 Flare）");
    await select("背景", "不透明");
    await page.getByRole("button", { name: "保存默认配置" }).click();
    await expect(page.getByText("已保存默认图片配置")).toBeVisible();
    expect(data.modelOptions[flare]).toEqual({ background: "opaque" });
    expect(data.defaultModelConfigId).toBeNull();
    await select("全局默认图片模型", "GPT Image 2.6 Flare");
    await page.getByRole("button", { name: "保存默认配置" }).click();
    await expect.poll(() => data.defaultModelConfigId).toBe(flare);
    await open();
    await expect(page.getByText("不透明", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("image-defaults.png") });
});
