import { test, expect, IMAGE } from "./fixtures";

test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

for (const width of [320, 360, 390, 430]) {
    test(`手机 ${width}px 从导航上传原图、放大预览并切换工作区`, async ({ page, context, api }) => {
        await page.setViewportSize({ width, height: width === 360 ? 740 : 844 });
        await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 4 } }));
        await page.goto("/");
        await page.getByRole("button", { name: "打开导航菜单" }).tap();
        await page.getByRole("dialog").getByRole("searchbox").fill("提取");
        await page.getByRole("dialog").getByRole("link", { name: "提取产品图", exact: true }).tap();
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "上传图片", exact: true }).tap();
        await (await chooser).setFiles({ name: "reference.png", mimeType: "image/png", buffer: IMAGE });
        const preview = page.getByRole("button", { name: /查看原图 ·/ });
        await expect(preview.locator("img")).toBeVisible();
        await expect(page.getByRole("button", { name: "提取产品图", exact: true })).toBeInViewport({ ratio: 0.99 });
        await preview.tap();
        await page.getByRole("button", { name: "放大大图" }).tap();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "查看结果", exact: true }).tap();
        await expect(page.getByRole("tab", { name: "本次结果" })).toBeVisible();
        await page.getByRole("button", { name: "创作", exact: true }).tap();
        await expect(preview).toBeVisible();
        expect(api.submissions).toHaveLength(0);
        for (const path of ["/video", "/garment-colorway", "/image?tool=seamless-stitch"]) {
            await page.goto(path);
            await page.getByRole("button", { name: "查看结果", exact: true }).tap();
            const pane = page.locator("[data-mobile-pane]");
            await expect(pane).toHaveAttribute("data-mobile-pane", "results");
            await page.getByRole("button", { name: "创作", exact: true }).tap();
            await expect(pane).toHaveAttribute("data-mobile-pane", "form");
            await expect.poll(() => pane.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        }
    });
}
