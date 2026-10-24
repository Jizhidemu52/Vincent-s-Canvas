import { test, expect } from "./fixtures";

test("无缝历史支持平铺检查，反复打开不重复保存本地原图", async ({ page, api }, testInfo) => {
    const id = "70000000-0000-4000-8000-000000000001";
    api.tasks.set(id, { id, requestId: "seamless-history", operationType: "seamless_stitch", status: "success", resultUrls: [`/api/assets/${id}/content`], createdAt: new Date().toISOString() });
    await page.addInitScript(() => {
        const state = window as typeof window & { historyImageWrites?: number };
        state.historyImageWrites = 0;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
            if (this.name === "image_files") state.historyImageWrites! += 1;
            return put.apply(this, args);
        };
    });
    await page.goto("/image?tool=seamless-stitch");
    await expect(page.getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    await page.getByText("2×2 平铺", { exact: true }).click();
    const repeat = page.getByRole("img", { name: "无缝拼接结果 2×2 平铺预览" });
    await expect(repeat).toBeVisible();
    await expect(repeat).toHaveCSS("background-size", "50% 50%");
    await expect(repeat).toHaveCSS("background-repeat", "repeat");
    await expect(repeat).toHaveCSS("aspect-ratio", "256 / 256");
    await page.getByRole("button", { name: "查看", exact: true }).click();
    await expect(repeat).toBeVisible();
    expect(await page.evaluate(() => (window as typeof window & { historyImageWrites?: number }).historyImageWrites)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("seamless-repeat.png") });
    await page.reload();
    await expect(page.getByRole("img", { name: "无缝拼接结果", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as typeof window & { historyImageWrites?: number }).historyImageWrites)).toBe(0);
    expect(api.submissions).toEqual([]);
    expect(api.assets.size).toBe(0);
});
