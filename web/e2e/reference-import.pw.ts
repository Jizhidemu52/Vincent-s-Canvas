import { test, expect, IMAGE } from "./fixtures";

test("先审核全部候选，读取第25张；导入坏项后继续，重试不重复成功项", async ({ context, page, api }) => {
    const imageReads: string[] = [], uploads: string[] = [];
    let failedOnce = false;
    await context.route("**/api/reference-import/*", route => {
        const body = route.request().postDataJSON();
        const isScan = route.request().url().endsWith("/scan");
        if (!isScan) imageReads.push(body.imageId);
        return route.fulfill({ status: 200, json: { code: 0, msg: "", data: isScan ? {
            scanId: "scan-1", pageUrl: "https://example.com/gallery", pageTitle: "候选图片", expiresAt: new Date(Date.now() + 300_000).toISOString(), warnings: [],
            candidates: Array.from({ length: 25 }, (_, index) => ({ id: `item-${index + 1}`, name: `图片${index + 1}.png`, sourceImage: `https://example.com/${index + 1}.png` })),
        } : {
            id: body.imageId, name: body.imageId, mime: "image/png", base64: Buffer.concat([IMAGE, Buffer.from(body.imageId)]).toString("base64"), sourcePage: "https://example.com/gallery", sourceImage: `https://example.com/${body.imageId}.png`, pageTitle: "候选图片",
        } } });
    });
    await context.route("**/api/assets/upload-request", route => {
        const body = route.request().postDataJSON();
        uploads.push(body.filename);
        if (body.filename === "item-2.png" && !failedOnce) {
            failedOnce = true;
            return route.fulfill({ status: 503, json: { message: "单项临时失败" } });
        }
        return route.fallback();
    });
    await page.goto("/reference-import");
    await page.getByLabel("公开网页链接").fill("https://example.com/gallery");
    await page.getByTestId("reference-scan").click();
    const choices = page.getByRole("region", { name: "网页候选图片" });
    await expect(choices).toBeVisible();
    expect(imageReads).toEqual([]);
    await page.getByRole("button", { name: "清空选择", exact: true }).click();
    for (const index of [1, 2, 25]) await choices.getByRole("checkbox", { name: `${index}. 图片${index}.png`, exact: true }).check();
    await page.getByRole("button", { name: "读取所选 3 张图片" }).click();
    await expect(page.getByTestId("reference-draft")).toHaveCount(3);
    expect(imageReads).toEqual(["item-1", "item-2", "item-25"]);
    expect(uploads).toEqual([]);
    await expect(page.getByTestId("reference-confirm")).toBeEnabled();
    await page.getByTestId("reference-confirm").click();
    await expect(page.getByText("已成功 2 张", { exact: true })).toBeVisible();
    await expect(page.getByText("单项临时失败", { exact: true })).toBeVisible();
    expect(uploads.sort()).toEqual(["item-1.png", "item-2.png", "item-25.png"]);
    await page.getByTestId("reference-confirm").click();
    await expect(page.getByText("已成功 3 张", { exact: true })).toBeVisible();
    expect(uploads.filter(name => name === "item-2.png")).toHaveLength(2);
    expect(uploads.filter(name => name === "item-1.png")).toHaveLength(1);
    expect(uploads.filter(name => name === "item-25.png")).toHaveLength(1);
    expect(api.submissions).toEqual([]);
});
