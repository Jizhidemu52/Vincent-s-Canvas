import type { Page } from "@playwright/test";
import { test, expect, IMAGE, newCanvas } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { chooseAntSelect } from "./antd-select-helpers";

const models = [
    { id: "10000000-0000-4000-8000-000000000026", name: "aplmart-gpt2.6-flare", imageParameterProfile: "quality-resolution-v2" },
    { id: "10000000-0000-4000-8000-000000000025", name: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution" },
].map(model => ({ ...model, modelId: model.id, publicName: model.name, imageSupportsMask: true, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0, isFeatured: true }));

async function setup(page: Page, workspace: "edit" | "canvas" = "edit") {
    await page.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    if (workspace === "canvas") {
        const id = await newCanvas(page);
        await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
        await page.getByRole("textbox", { name: "描述图像", exact: true }).fill("针织帽缓慢转动，纯色背景");
        return id;
    }
    await page.goto("/image?tool=image-edit");
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("针织帽缓慢转动，纯色背景");
}
async function reference(page: Page) {
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).evaluate((element, bytes) => {
        const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(bytes)], "source.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...IMAGE]);
    await expect(page.getByRole("img", { name: "source.png", exact: true })).toBeVisible();
}
async function settings(page: Page) {
    await page.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^切换生成图片模型/ });
    await dialog.getByText("高级参数", { exact: true }).click();
    return dialog;
}

test("GPT2.6 canvas blocks static 512px but submits valid GIF frames once without static resolution", async ({ page, api }, info) => {
    const id = await setup(page, "canvas");
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await panel.getByRole("button", { name: "更多设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "图像高级设置", exact: true });
    await dialog.getByRole("spinbutton", { name: "自定义宽度", exact: true }).fill("512");
    await dialog.getByRole("spinbutton", { name: "自定义宽度", exact: true }).press("Tab");
    await dialog.getByRole("spinbutton", { name: "自定义高度", exact: true }).fill("512");
    await dialog.getByRole("spinbutton", { name: "自定义高度", exact: true }).press("Tab");
    await dialog.getByRole("button", { name: "返回创建面板", exact: true }).click();
    const submit = panel.getByRole("button", { name: /^生成(?:\s|$)/ });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute("aria-description", /655360–8294400/);
    expect(api.submissions).toHaveLength(0);
    await panel.getByRole("button", { name: "更多设置", exact: true }).click();
    await dialog.getByRole("radiogroup", { name: "输出格式", exact: true }).getByRole("radio", { name: "GIF", exact: true }).check();
    await dialog.getByRole("spinbutton", { name: "GIF 帧数", exact: true }).fill("12");
    await dialog.getByRole("spinbutton", { name: "GIF 每帧时长（毫秒）", exact: true }).fill("120");
    await dialog.getByRole("radiogroup", { name: "规划强度", exact: true }).getByRole("radio", { name: "高", exact: true }).check();
    await dialog.getByRole("radiogroup", { name: "内容审核强度", exact: true }).getByRole("radio", { name: "自动", exact: true }).check();
    await expect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("上传独立透明 PNG 标注层", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("gpt26-gif-controls.png") });
    await dialog.getByRole("button", { name: "返回创建面板", exact: true }).click();
    await panel.getByRole("button", { name: "图片质量", exact: true }).click();
    await expect(page.getByRole("group", { name: "清晰度 / 分辨率", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "返回创建面板", exact: true }).click();
    await panel.getByRole("button", { name: "宽高比", exact: true }).click();
    await page.locator('[data-usage-control="size"][data-usage-value="512x512"]').click();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(() => api.document(id!)?.nodes.some((node: any) => node.metadata?.status === "success")).toBe(true);
    expect(api.submissions[0]).toMatchObject({ operationType: "image_generation", toolKey: "canvas-image", modelConfigId: models[0]!.id });
    expect(api.submissions[0].parameters).toMatchObject({ size: "512x512", output_format: "gif", frame_count: 12, frame_duration_ms: 120, complexity: "high", moderation: "auto", n: 1, count: 1 });
    for (const key of ["resolution", "output_compression", "markup_url"]) expect(api.submissions[0].parameters).not.toHaveProperty(key);
    expect(api.submissions[0].sourceUrls).toEqual([]);
    expect(api.pageErrors).toEqual([]); expect(api.blocked).toEqual([]);
});

test("GPT2.6 markup uploads separately and model switching removes unsupported options", async ({ page, api }, info) => {
    await setup(page);
    await reference(page);
    let dialog = await settings(page);
    await dialog.getByLabel("上传独立透明 PNG 标注层", { exact: true }).setInputFiles({ name: "markup.png", mimeType: "image/png", buffer: IMAGE });
    await expect(dialog.getByRole("button", { name: "移除标注层", exact: true })).toBeVisible();
    await chooseAntSelect(dialog.getByRole("combobox", { name: "规划强度", exact: true }), "中");
    await page.screenshot({ path: info.outputPath("gpt26-markup-controls.png") });
    await dialog.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await page.getByRole("button", { name: "开始编辑", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const submitted = api.submissions[0];
    expect(submitted).toMatchObject({ operationType: "inpaint", toolKey: "image-edit", modelConfigId: models[0]!.id });
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
    await dialog.getByRole("combobox", { name: "输出格式", exact: true }).click();
    const formats = page.locator(".ant-select-dropdown:visible .ant-select-item-option");
    await expect(formats).toHaveCount(4);
    // The popup briefly scales to zero between Antd's appear-prepare and appear-start frames.
    await expect.poll(() => formats.evaluateAll(options => options.map(option => option.getAttribute("title")))).toEqual(["默认", "PNG", "JPEG", "WebP"]);
    await page.keyboard.press("Escape");
    expect(api.submissions).toHaveLength(1); expect(api.pageErrors).toEqual([]); expect(api.blocked).toEqual([]);
});
