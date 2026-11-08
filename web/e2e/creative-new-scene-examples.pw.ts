import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";

async function expectDecodedImage(image: Locator) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true);
}

test("all creative cards load real cover images and the two added cards remain complete at 390px", async ({ page, api }, info) => {
    await page.goto("/creative");
    await expect(page.getByRole("heading", { name: "创意设计", exact: true })).toBeVisible();
    const covers = page.locator(".creative-card .creative-cover > img");
    await expect(covers).toHaveCount(11);
    for (const cover of await covers.all()) await expectDecodedImage(cover);
    for (const [id, label, src] of [
        ["virtual-try-on", "输入示意 · 毛衫产品图", "/design-examples/knit-source.webp"],
        ["sketch-to-photo", "输入示意 · 毛衫结构线稿", "/design-examples/knit-sketch.webp"],
    ]) {
        const card = page.locator(`.creative-card:has(a[href='/creative/${id}'])`);
        await expect(card.locator(".creative-cover > img")).toHaveAttribute("src", src!);
        await expect(card.locator(".creative-cover > img")).toHaveAttribute("alt", label!);
        await expect(card.locator(".creative-cover-flow")).toHaveText(label!);
        await card.screenshot({ path: info.outputPath(`${id}-desktop-card.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ["virtual-try-on", "sketch-to-photo"]) {
        const card = page.locator(`.creative-card:has(a[href='/creative/${id}'])`);
        const image = card.locator(".creative-cover > img");
        await expectDecodedImage(image);
        const size = await image.evaluate((element: HTMLImageElement) => ({ rendered: element.clientWidth / element.clientHeight, original: element.naturalWidth / element.naturalHeight, fit: getComputedStyle(element).objectFit, labelSpace: Number.parseFloat(getComputedStyle(element).paddingBottom) }));
        expect(Math.abs(size.rendered - size.original)).toBeLessThan(0.02);
        expect(size.fit).toBe("contain");
        expect(size.labelSpace).toBeGreaterThanOrEqual(38);
        await card.screenshot({ path: info.outputPath(`${id}-mobile-card.png`) });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

for (const [sceneId, draftLabel, action] of [
    ["virtual-try-on", "成人模特与试穿要求", "生成试穿效果"],
    ["sketch-to-photo", "材质方向", "生成实拍效果"],
]) {
    test(`${sceneId} offers two input-only operation examples without changing the draft or submitting`, async ({ page, context, api }, info) => {
        const writes: string[] = [];
        context.on("request", request => {
            const path = new URL(request.url()).pathname;
            if (path.startsWith("/api/") && !path.startsWith("/api/usage") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${path}`);
        });
        await page.goto(`/creative/${sceneId}`);
        const draft = page.getByRole("textbox", { name: draftLabel!, exact: true });
        await draft.fill("我的未提交草稿，操作示例不能覆盖");
        const records = page.getByTestId("practice-example-record");
        await expect(records).toHaveCount(2);
        await expect(page.getByRole("button", { name: /^最近任务/ })).toHaveText("最近任务");
        for (const record of await records.all()) {
            await record.getByTestId("practice-example-toggle").click();
            const article = record.getByTestId("design-example-article");
            await expect(article).toContainText(action!);
            await expect(article).toContainText("仅为输入示意而非实测结果");
            for (const image of await article.locator("img").all()) await expectDecodedImage(image);
            await article.getByRole("button", { name: "复制示例要求", exact: true }).click();
            await expect(page.getByText("示例要求已复制", { exact: true })).toBeVisible();
            await expect(draft).toHaveValue("我的未提交草稿，操作示例不能覆盖");
        }
        await page.screenshot({ path: info.outputPath(`${sceneId}-examples-desktop.png`), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        for (const image of await page.getByTestId("design-example-article").locator("img").all()) await expectDecodedImage(image);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath(`${sceneId}-examples-mobile.png`), fullPage: true });
        await page.reload();
        await expect(draft).toHaveValue("我的未提交草稿，操作示例不能覆盖");
        await expect(records).toHaveCount(2);
        expect(api.submissions).toHaveLength(0);
        expect(api.batchSubmissions).toHaveLength(0);
        expect(writes).toEqual([]);
    });
}
