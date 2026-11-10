import { test, expect, IMAGE } from "./fixtures";
import type { Page } from "@playwright/test";

const optionalImage = Buffer.concat([IMAGE, Buffer.from("optional-reference-original-bytes")]);
const upload = (page: Page, label: string, name: string, buffer = IMAGE) => page.getByLabel(`上传${label}`, { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer });

test("try-on validates a product and adult model description, persists draft, and submits one role only on click", async ({ page, api }, info) => {
    await page.goto("/creative/virtual-try-on");
    await expect(page.getByRole("heading", { name: "虚拟试穿", exact: true })).toBeVisible();
    const submit = page.getByRole("button", { name: /^生成试穿效果/ });
    await expect(submit).toBeDisabled();
    await upload(page, "产品图", "product-original.png");
    await expect(submit).toBeDisabled();
    await page.getByRole("textbox", { name: "成人模特与试穿要求", exact: true }).fill("短发成年女性，全身站姿，简洁黑裤");
    await page.getByRole("textbox", { name: /关键特征保持/ }).fill("保留圆领、六列绞花与罗纹");
    await expect(submit).toBeEnabled();
    expect(api.submissions).toHaveLength(0); expect(api.assets.size).toBe(0);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "成人模特与试穿要求", exact: true })).toHaveValue("短发成年女性，全身站姿，简洁黑裤");
    await expect(page.getByRole("img", { name: "product-original.png", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
    await submit.click();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "creative-virtual-try-on", operationType: "inpaint", promptInput: { scene: "virtual-try-on", mode: "edit", referenceRoles: ["产品图"], fields: { description: "短发成年女性，全身站姿，简洁黑裤", keepDetails: "保留圆领、六列绞花与罗纹" } } });
    expect(api.submissions[0].sourceUrls).toHaveLength(1);
    const sourceId = api.submissions[0].sourceUrls[0].split("/")[3];
    expect(api.assetBytes.get(sourceId)?.equals(IMAGE)).toBe(true);
    await page.screenshot({ path: info.outputPath("virtual-try-on-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("virtual-try-on-mobile.png"), fullPage: true });
});

test("an optional model never replaces the required product and uploaded role bytes stay in fixed order", async ({ page, api }) => {
    await page.goto("/creative/virtual-try-on");
    const submit = page.getByRole("button", { name: /^生成试穿效果/ });
    await upload(page, "模特图", "adult-model.png", optionalImage);
    await expect(submit).toBeDisabled();
    await upload(page, "产品图", "garment.png");
    await expect(submit).toBeEnabled();
    expect(api.submissions).toHaveLength(0);
    await submit.click();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    const submitted = api.submissions[0];
    expect(submitted.promptInput.referenceRoles).toEqual(["产品图", "模特图"]);
    expect(submitted.sourceUrls).toHaveLength(2);
    expect(submitted.sourceUrls.map((url: string) => api.assetBytes.get(url.split("/")[3]))).toEqual([IMAGE, optionalImage]);
});

test("sketch color and fabric are explicit, optional reference is scoped, and employee/scene drafts remain separate", async ({ page, context, api }, info) => {
    await page.goto("/creative/virtual-try-on");
    await page.getByRole("textbox", { name: "成人模特与试穿要求", exact: true }).fill("试穿板块独立草稿");
    await page.goto("/creative/sketch-to-photo");
    await expect(page.getByRole("heading", { name: "线稿转实拍", exact: true })).toBeVisible();
    const submit = page.getByRole("button", { name: /^生成实拍效果/ });
    await upload(page, "线稿图", "original-sketch.png");
    await expect(submit).toBeDisabled();
    await page.getByRole("textbox", { name: "材质方向", exact: true }).fill("羊毛绞花针织");
    await expect(submit).toBeDisabled();
    await page.getByRole("textbox", { name: "颜色方向", exact: true }).fill("淡粉色");
    await page.getByRole("textbox", { name: /关键特征保持/ }).fill("保留六列绞花");
    await upload(page, "材质与配色参考图", "fabric-reference.png", optionalImage);
    await page.getByRole("radio", { name: "白底悬浮", exact: true }).check();
    await expect(submit).toBeEnabled();
    expect(api.submissions).toHaveLength(0); expect(api.assets.size).toBe(0);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "颜色方向", exact: true })).toHaveValue("淡粉色");
    await submit.click();
    await expect(page.getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "creative-sketch-to-photo", operationType: "inpaint", promptInput: { scene: "sketch-to-photo", referenceRoles: ["线稿图", "材质与配色参考图"], fields: { fabric: "羊毛绞花针织", colorDescription: "淡粉色", keepDetails: "保留六列绞花", presentation: "白底悬浮" } } });
    expect(api.submissions[0].sourceUrls.map((url: string) => api.assetBytes.get(url.split("/")[3]))).toEqual([IMAGE, optionalImage]);
    await page.screenshot({ path: info.outputPath("sketch-to-photo-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("sketch-to-photo-mobile.png"), fullPage: true });
    await page.goto("/creative/virtual-try-on");
    await expect(page.getByRole("textbox", { name: "成人模特与试穿要求", exact: true })).toHaveValue("试穿板块独立草稿");
    await context.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }));
    await page.goto("/creative/sketch-to-photo"); await page.reload();
    await expect(page.getByRole("textbox", { name: "颜色方向", exact: true })).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "材质方向", exact: true })).toHaveValue("");
    await expect(page.getByRole("img", { name: "original-sketch.png", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(1);
});

test("a pending try-on request keeps its original receipt on refresh and does not silently submit again", async ({ page, api }) => {
    api.taskStatus = "paused";
    await page.goto("/creative/virtual-try-on");
    await upload(page, "产品图", "pending-product.png");
    await page.getByRole("textbox", { name: "成人模特与试穿要求", exact: true }).fill("成年女性，正面站姿");
    await page.getByRole("button", { name: /^生成试穿效果/ }).click();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeVisible();
    const originalId = api.submissions[0].requestId;
    await page.reload();
    await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1); expect(api.submissions[0].requestId).toBe(originalId);
});
