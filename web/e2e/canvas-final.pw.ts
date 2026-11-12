import { test, expect, newCanvas, IMAGE } from "./fixtures";

for (const dark of [false, true]) test(`canvas final theme, disabled reasons and settings at laptop size dark=${dark}`, async ({ page, api }, info) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await newCanvas(page);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("button", { name: "画布与图片已保存至服务器", exact: true })).toBeVisible();
    if (dark) await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    const workspace = page.locator(".cw-workspace");
    await expect(workspace).toHaveAttribute("data-theme", dark ? "dark" : "light");
    for (const [label, reason] of [["撤销", "还没有可撤销的操作"], ["重做", "还没有可重做的操作"]]) {
        const button = page.getByRole("button", { name: label, exact: true });
        await expect(button).toBeDisabled();
        await button.locator("..").hover();
        await expect(page.getByRole("tooltip", { name: reason, exact: true })).toBeVisible();
        expect(await button.evaluate(element => getComputedStyle(element).opacity)).toBe("0.4");
    }
    const create = page.getByRole("button", { name: "展开创建面板", exact: true });
    await create.click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    const draft = "只检查界面，不提交生成";
    await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill(draft);
    const settings = panel.getByRole("button", { name: "更多设置", exact: true });
    expect(await settings.evaluate(element => ({ size: getComputedStyle(element).fontSize, radius: getComputedStyle(element).borderRadius, height: element.getBoundingClientRect().height }))).toEqual({ size: "14px", radius: "8px", height: 36 });
    await settings.click();
    const dialog = page.getByRole("dialog", { name: "图像高级设置", exact: true });
    await expect(dialog).toBeVisible();
    const styles = await dialog.evaluate(element => {
        const style = getComputedStyle(element);
        const title = getComputedStyle(element.querySelector("h2")!);
        return { radius: style.borderRadius, title: title.fontSize, background: style.backgroundColor, shadow: style.boxShadow, tokenShadow: style.getPropertyValue("--ui-shadow-modal").trim(), rect: element.getBoundingClientRect().toJSON() };
    });
    expect(styles.radius).toBe("12px");
    expect(styles.title).toBe("16px");
    expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.shadow).not.toBe("none");
    expect(styles.tokenShadow).not.toBe("");
    expect(styles.rect.x).toBeGreaterThanOrEqual(12);
    expect(styles.rect.y + styles.rect.height).toBeLessThanOrEqual(768);
    await page.screenshot({ path: info.outputPath(`settings-${dark ? "dark" : "light"}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "完成设置", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "描述图像", exact: true })).toHaveValue(draft);
    const header = page.locator(".cw-project-card");
    expect(await header.evaluate(element => ({ shadow: getComputedStyle(element).boxShadow, border: getComputedStyle(element).borderTopWidth, background: getComputedStyle(element).backgroundColor }))).toEqual({ shadow: "none", border: "0px", background: "rgba(0, 0, 0, 0)" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`canvas-narrow-${dark ? "dark" : "light"}.png`), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("reference order boundaries explain why they are disabled without changing references", async ({ page, api }) => {
    await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await panel.getByRole("button", { name: "添加参考图", exact: true }).evaluate((element, bytes) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([Uint8Array.from(bytes)], "UI-reference.png", { type: "image/png" }));
        element.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
    }, [...IMAGE]);
    const reference = panel.getByRole("button", { name: /参考图 1：UI-reference.png/ });
    await expect(reference).toBeVisible();
    await reference.click();
    for (const [label, reason] of [["参考图前移", "已是第一张参考图"], ["参考图后移", "已是最后一张参考图"]]) {
        const button = panel.getByRole("button", { name: label, exact: true });
        await expect(button).toBeDisabled();
        await button.locator("..").hover();
        await expect(page.getByRole("tooltip", { name: reason, exact: true })).toBeVisible();
    }
    await expect(panel.getByRole("img", { name: "UI-reference.png", exact: true })).toHaveAttribute("data-loaded", "true");
    await expect(reference).toHaveAttribute("aria-pressed", "true");
    expect(api.submissions).toHaveLength(0);
});

test("canvas library has an actionable empty state and inline copy receipt", async ({ page, api }, info) => {
    await page.goto("/canvas");
    const empty = page.locator(".wb-empty");
    await expect(empty.getByRole("heading", { name: "还没有画布", exact: true })).toBeVisible();
    await expect(empty.locator(":scope > svg")).toHaveCount(1);
    await expect(empty.getByRole("button", { name: "新建画布", exact: true })).toBeEnabled();
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "返回画布列表", exact: true }).click();
    const card = page.locator(`[data-canvas-project-id="${id}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "创建副本", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("已创建副本，原画布未修改");
    await expect(page.locator("[data-canvas-project-id]")).toHaveCount(2);
    expect(await card.evaluate(element => getComputedStyle(element).boxShadow)).toBe("none");
    await page.screenshot({ path: info.outputPath("library-inline-feedback.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});
