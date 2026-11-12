import { test, expect } from "./fixtures";

const moved = [
    { id: "local-restyle", title: "局部改款" },
    { id: "garment-colorway", title: "服装配色" },
    { id: "back-design", title: "背面设计" },
];

test("only requested boards disappear; creation tools retain their fixed desktop and narrow navigation", async ({ page, context, api }, info) => {
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 4 } }));
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "主导航" });
    const creationPaths = ["/creative", ...moved.map(item => `/${item.id}`), "/image", "/video"];
    const create = nav.locator("section").filter({ has: page.getByRole("button", { name: "创作工具", exact: true }) });
    await expect(create.getByRole("link")).toHaveCount(creationPaths.length);
    for (const [index, path] of creationPaths.entries()) await expect(create.getByRole("link").nth(index)).toHaveAttribute("href", path);
    for (const item of moved) await expect(create.getByRole("link", { name: item.title, exact: true })).toHaveAttribute("href", `/${item.id}`);
    await nav.getByRole("button", { name: "图像工具", exact: true }).click();
    await expect(nav.getByRole("link", { name: "高清放大", exact: true })).toHaveAttribute("href", "/hd-upscale");
    for (const title of ["细节增强", "角度控制", "系列配方"]) await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);
    const allTools = page.getByRole("region", { name: "全部工具", exact: true });
    for (const item of moved) await expect(allTools.getByRole("link", { name: item.title, exact: true })).toHaveAttribute("href", `/${item.id}`);
    await page.screenshot({ path: info.outputPath("navigation-desktop.png") });
    await page.goto("/creative");
    for (const item of moved) await expect(page.locator("main.creative-page").getByRole("heading", { name: item.title, exact: true })).toHaveCount(0);
    await expect(page.locator("main.creative-page").getByText("系列配方", { exact: true })).toHaveCount(0);
    await page.goto("/creative/style-to-sketch");
    const switcher = page.getByRole("combobox", { name: "切换设计场景", exact: true });
    await switcher.click();
    const sceneOptions = page.locator(".ant-select-dropdown:visible");
    await expect(sceneOptions).toBeVisible();
    for (const item of moved) await expect(sceneOptions.getByText(item.title, { exact: true })).toHaveCount(0);
    await switcher.press("Escape");
    await expect(sceneOptions).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "功能模块", exact: true });
    const drawerCreate = drawer.locator("section").filter({ has: page.getByRole("button", { name: "创作工具", exact: true }) });
    await expect(drawerCreate.getByRole("link")).toHaveCount(creationPaths.length);
    for (const [index, path] of creationPaths.entries()) await expect(drawerCreate.getByRole("link").nth(index)).toHaveAttribute("href", path);
    await drawer.screenshot({ path: info.outputPath("navigation-narrow.png") });
    await drawer.getByRole("link", { name: "局部改款", exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(page).toHaveURL(/\/local-restyle$/);
    await expect(page.getByRole("heading", { name: "局部改款", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "切换设计场景", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("restyle-narrow.png") });
    expect(api.submissions).toHaveLength(0);
});

test("old creative links preserve query/hash and reuse the same saved workflow draft", async ({ page, api }) => {
    for (const item of moved) {
        await page.goto(`/creative/${item.id}?entry=saved#draft`);
        await expect(page).toHaveURL(new RegExp(`/${item.id}\\?entry=saved#draft$`));
        await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
        const target = page.getByRole("textbox", { name: /要处理的产品/ });
        await target.fill(`保留原有 ${item.id} 草稿`);
        await page.reload();
        await expect(target).toHaveValue(`保留原有 ${item.id} 草稿`);
        await page.goto(`/creative/${item.id}`);
        await expect(page).toHaveURL(new RegExp(`/${item.id}$`));
        await expect(target).toHaveValue(`保留原有 ${item.id} 草稿`);
    }
    expect(api.submissions).toHaveLength(0);
});

test("retired direct URLs cannot mount their old editors while hd-upscale remains usable", async ({ page, api }) => {
    for (const [url, title] of [["/image?tool=detail-enhance", "细节增强"], ["/image?tool=angle-control", "角度控制"], ["/creative/series-recipe", "系列配方"]]) {
        await page.goto(url);
        await expect(page.getByRole("heading", { name: `${title}已下线`, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "返回工作台", exact: true })).toHaveAttribute("href", "/");
        await expect(page.locator("main input[type=file], main textarea")).toHaveCount(0);
    }
    await page.goto("/hd-upscale");
    await expect(page.getByRole("heading", { name: "高清放大", exact: true })).toBeVisible();
    await expect(page.getByText("此板块已移除。已有素材、任务和历史记录未删除，其他功能仍可正常使用。", { exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});
