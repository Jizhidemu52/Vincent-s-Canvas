import type { Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const models = [
    { id: "10000000-0000-4000-8000-000000000026", name: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2" },
    { id: "10000000-0000-4000-8000-000000000025", name: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution" },
].map(model => ({ ...model, modelId: model.id, publicName: model.name, imageSupportsMask: true, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0, isFeatured: true }));

async function setup(page: Page) {
    await page.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    await page.goto("/image");
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("针织帽缓慢转动，纯色背景");
}
async function settings(page: Page) {
    await page.getByRole("button", { name: "调整", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("全部高级参数", { exact: true }).click();
    return dialog;
}

test("GPT2.6 GIF controls reach one request with valid frame parameters and no static resolution", async ({ page, api }, info) => {
    await setup(page);
    const dialog = await settings(page);
    await dialog.getByRole("combobox", { name: "输出格式", exact: true }).selectOption("gif");
    await dialog.getByRole("combobox", { name: "宽高比", exact: true }).selectOption("512x512");
    await dialog.getByRole("spinbutton", { name: "GIF 帧数", exact: true }).fill("12");
    await dialog.getByRole("spinbutton", { name: "GIF 每帧时长（毫秒）", exact: true }).fill("120");
    await dialog.getByRole("combobox", { name: "规划强度", exact: true }).selectOption("high");
    await dialog.getByRole("combobox", { name: "内容审核强度", exact: true }).selectOption("auto");
    await expect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("上传独立透明 PNG 标注层", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("gpt26-gif-controls.png") });
    await dialog.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].parameters).toMatchObject({ size: "512x512", output_format: "gif", frame_count: 12, frame_duration_ms: 120, complexity: "high", moderation: "auto", n: 1, count: 1 });
    for (const key of ["resolution", "output_compression", "markup_url"]) expect(api.submissions[0].parameters).not.toHaveProperty(key);
    expect(api.submissions[0].sourceUrls).toEqual([]);
    expect(api.pageErrors).toEqual([]); expect(api.blocked).toEqual([]);
});

test("GPT2.6 markup uploads separately and model switching removes unsupported options", async ({ page, api }, info) => {
    await setup(page);
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await prompt.evaluate((element, bytes) => {
        const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(bytes)], "source.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...IMAGE]);
    await expect(page.getByRole("img", { name: "source.png", exact: true })).toBeVisible();
    let dialog = await settings(page);
    await dialog.getByLabel("上传独立透明 PNG 标注层", { exact: true }).setInputFiles({ name: "markup.png", mimeType: "image/png", buffer: IMAGE });
    await expect(dialog.getByRole("button", { name: "移除标注层", exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "规划强度", exact: true }).selectOption("medium");
    await page.screenshot({ path: info.outputPath("gpt26-markup-controls.png") });
    await dialog.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const submitted = api.submissions[0];
    expect(submitted.sourceUrls).toHaveLength(2);
    expect(submitted.parameters.inputArchive.markupReferenceIndex).toBe(1);
    expect(submitted.parameters.complexity).toBe("medium");
    for (const key of ["markup_url", "markup_reference"]) expect(submitted.parameters).not.toHaveProperty(key);
    await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
    dialog = await settings(page);
    await dialog.locator('[data-usage-control="model"][role="combobox"]').click();
    await page.locator(`[role="option"][data-usage-value="${models[1]!.id}"]`).click();
    await expect(dialog.getByLabel("上传独立透明 PNG 标注层", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: "规划强度", exact: true })).toHaveCount(0);
    expect(await dialog.getByRole("combobox", { name: "输出格式", exact: true }).locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).not.toContain("gif");
    expect(api.submissions).toHaveLength(1); expect(api.pageErrors).toEqual([]); expect(api.blocked).toEqual([]);
});
