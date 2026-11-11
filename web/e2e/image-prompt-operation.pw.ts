import type { Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const model = { id: "10000000-0000-4000-8000-000000000001", name: "隔离图片模型", modelId: "gpt-image-2", capabilities: ["generate", "edit", "upscale"], protocol: "openai", creditCost: 0, rmbCost: 0 };
const compilationId = "10000000-0000-4000-8000-000000000099";
const optimized = "A blue linen dress, preserving the reference material and silhouette.";

async function models(page: Page, unbound = false) {
    await page.route("**/api/models", route => route.fulfill({ json: { models: [model, { ...model, id: "10000000-0000-4000-8000-000000000002", modelId: "gpt-image-1", name: "隔离备用图片模型" }], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: unbound ? null : model.id, configurationVersion: 1 })) } }));
}

async function reference(page: Page) {
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).evaluate((element, bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([Uint8Array.from(bytes)], "reference.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...IMAGE]);
    await expect(page.getByRole("img", { name: "reference.png", exact: true })).toBeVisible();
}

async function compiler(page: Page) {
    const submissions: any[] = [];
    await page.route("**/api/prompt-compilations", route => {
        const input = route.request().postDataJSON();
        submissions.push(input);
        return route.fulfill({ json: { compilation: { id: compilationId, requestId: input.requestId, status: "success", prompt: optimized, optimized: true } } });
    });
    return submissions;
}

for (const mode of [
    { query: "", toolKey: "image", operationType: "image_generation", promptMode: "generate", action: "开始生成" },
    { query: "?tool=image-edit", toolKey: "image-edit", operationType: "inpaint", promptMode: "edit", action: "开始编辑" },
]) {
    test(`${mode.toolKey}: optimize and generate use the same explicit operation with a reference`, async ({ page, api }) => {
        await models(page);
        const compilations = await compiler(page);
        await page.goto(`/image${mode.query}`);
        const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
        await prompt.fill("蓝色亚麻连衣裙，保留参考图材质");
        await reference(page);
        await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
        const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
        await expect(preview.locator("pre").nth(1)).toHaveText(optimized);
        await expect(prompt).toHaveValue("蓝色亚麻连衣裙，保留参考图材质");
        expect(api.submissions).toHaveLength(0);
        await preview.getByRole("button", { name: "确认应用", exact: true }).click();
        await expect(preview).toBeHidden();
        await expect(prompt).toHaveValue(optimized);
        expect(compilations).toHaveLength(1);
        expect(compilations[0]).toMatchObject({ toolKey: mode.toolKey, modelConfigId: model.id, promptInput: { scene: "free-optimize", mode: mode.promptMode } });
        expect(compilations[0].sourceUrls).toHaveLength(1);
        expect(api.submissions).toHaveLength(0);
        await page.getByRole("button", { name: mode.action, exact: true }).click();
        await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength(1);
        expect(api.submissions[0]).toMatchObject({ operationType: mode.operationType, toolKey: mode.toolKey, modelConfigId: model.id, promptInput: { mode: mode.promptMode, compilationId }, sourceUrls: compilations[0].sourceUrls });
    });
}

test("hd-upscale submits the managed enhancement without editable prompt optimization", async ({ page, api }) => {
    await models(page);
    const compilations = await compiler(page);
    await page.goto("/hd-upscale");
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "一键优化提示词", exact: true })).toHaveCount(0);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "reference.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("button", { name: "高清放大", exact: true }).click();
    await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
    expect(compilations).toHaveLength(0);
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ operationType: "upscale", toolKey: "detail-enhance", parameters: { quickImageAction: "hd-upscale" } });
    expect(api.submissions[0].prompt).toBeUndefined();
    expect(api.submissions[0].promptInput).toBeUndefined();
});

test("changing the model after optimization invalidates the old compilation without losing its text", async ({ page, api }) => {
    await models(page, true);
    const compilations = await compiler(page);
    await page.goto("/image");
    const prompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await prompt.fill("蓝色亚麻连衣裙");
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
    await expect(preview.locator("pre").nth(1)).toHaveText(optimized);
    await expect(prompt).toHaveValue("蓝色亚麻连衣裙");
    expect(api.submissions).toHaveLength(0);
    await preview.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(prompt).toHaveValue(optimized);
    await page.getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    await page.locator("[data-usage-control=model][role=combobox]").click();
    await page.locator('[role=option][data-usage-value="10000000-0000-4000-8000-000000000002"]').click();
    await page.getByRole("dialog", { name: /^切换生成图片模型/ }).getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await expect(prompt).toHaveValue(optimized);
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
    expect(compilations).toHaveLength(1);
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0].modelConfigId).toBe("10000000-0000-4000-8000-000000000002");
    expect(api.submissions[0].promptInput).toBeUndefined();
});

test("a failed image task exposes both server task and request identifiers", async ({ page, context, api }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await models(page);
    const taskId = "20000000-0000-4000-8000-000000000007";
    let requestId = "", posts = 0;
    await page.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++; requestId = route.request().postDataJSON().requestId;
        return route.fulfill({ json: { task: { id: taskId, requestId, status: "queued", resultUrls: [] } } });
    });
    await page.route(`**/api/tasks/${taskId}`, route => route.fulfill({ json: { task: { id: taskId, requestId, status: "failed", resultUrls: [], failureReason: "原参考文件缺失，请重新导入原图。" } } }));
    await page.goto("/image");
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("一次可诊断的任务");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await page.getByRole("button", { name: "复制诊断信息", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`taskId: ${taskId}`);
    expect(copied).toContain(`requestId: ${requestId}`);
    expect(posts).toBe(1); expect(api.submissions).toHaveLength(0);
});

test("unknown image submission preserves the first diagnostic after missing lookup and reload without reposting", async ({ page, context, api }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await models(page);
    let posts = 0, lookups = 0, requestId = "";
    await page.route("**/api/tasks", route => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++; requestId = route.request().postDataJSON().requestId;
        return route.fulfill({ status: 503, json: { error: "UNKNOWN_SUBMISSION_STATE", message: "original-image-503-diagnostic" } });
    });
    await page.route("**/api/tasks/by-request/**", route => { lookups++; return route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: "later lookup 404" } }); });
    await page.goto("/image");
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("保留原始诊断");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    const copy = page.getByRole("button", { name: "复制诊断信息", exact: true });
    await copy.click();
    const before = await page.evaluate(() => navigator.clipboard.readText());
    expect(before).toContain("original-image-503-diagnostic");
    expect(before).toContain(`requestId: ${requestId}`);
    await page.reload();
    await copy.click();
    const after = await page.evaluate(() => navigator.clipboard.readText());
    expect(after).toContain("original-image-503-diagnostic");
    expect(after).not.toContain("later lookup 404");
    expect(posts).toBe(1); expect(lookups).toBeGreaterThan(0); expect(api.submissions).toHaveLength(0);
});

for (const scene of ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft"]) {
    test(`creative ${scene}: public scene inputs survive the shared image submission path`, async ({ page, api }) => {
        await models(page);
        await page.goto(`/creative/${scene}`);
        await expect(page.locator(".cs-form-body")).toBeVisible();
        await expect(page.getByText("正在恢复场景草稿…", { exact: true })).toHaveCount(0);
        await expect(page.locator(".cs-upload input[type=file]")).toHaveCount(scene === "text-to-style" ? 0 : scene === "accessory-design" ? 2 : 1);
        if (scene === "text-to-style") await page.getByRole("textbox", { name: "款式描述", exact: true }).fill("蓝色亚麻连衣裙");
        for (const input of await page.locator(".cs-upload input[type=file]").all()) {
            await input.setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: IMAGE });
            await expect(input.locator("..").locator("img")).toBeVisible();
        }
        if (scene === "local-restyle") await page.getByRole("textbox", { name: "要改成什么样", exact: true }).fill("小翻领改为圆领");
        await page.locator("button.cs-generate").click();
        await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength(1);
        expect(api.submissions[0]).toMatchObject({ toolKey: `creative-${scene}`, operationType: scene === "text-to-style" ? "image_generation" : "inpaint", promptInput: { scene, mode: scene === "text-to-style" ? "generate" : "edit" } });
        expect(api.submissions[0].sourceUrls).toHaveLength(scene === "text-to-style" ? 0 : scene === "accessory-design" ? 2 : 1);
    });
}
