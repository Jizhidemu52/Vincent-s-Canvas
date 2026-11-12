import { test, expect, newCanvas } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

test("顶栏扁平且改名支持键盘和中文组合输入；面板显示实际宽度", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    const id = await newCanvas(page);
    const title = page.locator(".cw-project-title");
    const original = await title.innerText();
    await title.getByRole("button").focus();
    await page.keyboard.press("Enter");
    const name = page.getByRole("textbox", { name: "画布名称", exact: true });
    await name.fill("中文输入尚未提交");
    await name.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229, bubbles: true });
    await expect(name).toBeVisible();
    await name.press("Escape");
    await expect(title.getByRole("button")).toHaveText(original);
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "修改画布名称", exact: true }).click();
    await name.fill("壳层中文改名已保存"); await name.press("Enter");
    await expect.poll(() => api.document(id)?.title).toBe("壳层中文改名已保存");
    expect(await page.locator(".cw-project-card").evaluate(element => ({ border: getComputedStyle(element).borderWidth, shadow: getComputedStyle(element).boxShadow, background: getComputedStyle(element).backgroundColor }))).toEqual({ border: "0px", shadow: "none", background: "rgba(0, 0, 0, 0)" });
    const open = page.getByRole("button", { name: "展开创建面板", exact: true });
    if (await open.isVisible()) await open.click();
    await page.getByRole("button", { name: "调整面板大小", exact: true }).click();
    await page.getByRole("button", { name: "宽敞", exact: true }).click();
    const panel = page.locator(".cw-create-panel");
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(576);
    await expect(page.locator(".cw-panel-size-popover output").first()).toHaveText("576 px");
    const top = await page.locator(".cw-project-card").boundingBox(), body = await panel.boundingBox();
    expect(Math.abs(top!.width - body!.width)).toBeLessThan(2);
    await page.getByRole("button", { name: "关闭面板大小设置", exact: true }).click();
    await page.screenshot({ path: info.outputPath("shell-laptop-flat.png") });
    expect(api.submissions).toHaveLength(0);
});

test("全部工具方向键选择与回车打开；Esc先清空再关闭", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "全部工具", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "全部工具", exact: true });
    const input = dialog.getByRole("combobox", { name: "搜索工具或工作台", exact: true });
    await input.fill("自由画布");
    await input.press("Escape");
    await expect(input).toHaveValue(""); await expect(dialog).toBeVisible();
    const options = dialog.getByRole("option");
    await input.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await input.fill("自由画布");
    await expect(options).toHaveCount(1);
    await input.press("Enter");
    await expect(dialog).toBeHidden(); await expect(page).toHaveURL(new RegExp(`/canvas/${id}$`));
    await page.getByRole("button", { name: "全部工具", exact: true }).click();
    await dialog.getByRole("combobox").press("Escape");
    await expect(dialog).toBeHidden();
    expect(api.submissions).toHaveLength(0);
});

test("小地图可关闭、键盘平移缩放并处理指针取消；主题不使用截图过渡", async ({ page, api }, info) => {
    await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await page.getByRole("button", { name: "打开小地图", exact: true }).click();
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    const map = page.getByTestId("canvas-mini-map");
    const controller = map.getByRole("application");
    const before = await page.locator("[data-canvas-viewport] > .origin-top-left").getAttribute("style");
    await controller.focus(); await controller.press("ArrowRight");
    await expect.poll(() => page.locator("[data-canvas-viewport] > .origin-top-left").getAttribute("style")).not.toBe(before);
    await controller.press("+");
    await expect(page.getByRole("button", { name: "画布缩放与视图", exact: true })).toContainText("125%");
    await controller.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse" });
    await map.getByRole("button", { name: "关闭小地图", exact: true }).click();
    await expect(map).toBeHidden();
    await page.evaluate(() => { (window as any).__shellTransitions = 0; document.startViewTransition = (() => { (window as any).__shellTransitions++; throw new Error("Canvas should not use screenshot transitions"); }) as any; });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.locator(".cw-workspace")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => (window as any).__shellTransitions)).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("shell-mobile-dark.png") });
    expect(api.submissions).toHaveLength(0);
});

test("体验数据按Esc或外部点击关闭，普通员工不显示入口", async ({ page, api }) => {
    api.role = "super_admin";
    await newCanvas(page);
    const trigger = page.getByLabel("本页体验数据", { exact: true });
    await trigger.click();
    const details = trigger.locator("..");
    await expect(details).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(details).not.toHaveAttribute("open");
    await trigger.click(); await page.mouse.click(700, 280);
    await expect(details).not.toHaveAttribute("open");
    api.role = "designer";
    await page.reload();
    await expect(trigger).toHaveCount(0);
});

test("390px 管理员对话发送按钮不被体验数据遮挡，收起后体验入口仍可用", async ({ page, context, api }) => {
    api.role = "super_admin";
    const models = [
        { id: "shell-image", modelId: "gpt-image-2", name: "隔离图片模型", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 },
        { id: "shell-chat", modelId: "shell-chat", name: "隔离对话模型", protocol: "openai", capabilities: ["chat", "vision", "tools"], creditCost: 0, rmbCost: 0 },
    ];
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? "shell-chat" : "shell-image", configurationVersion: 1 })) } }));
    await context.route("**/api/generation-capabilities?*", route => route.request().method() === "GET" ? route.fulfill({ json: { models: [] } }) : route.fallback());
    await page.setViewportSize({ width: 390, height: 844 });
    await newCanvas(page);
    const trigger = page.getByLabel("本页体验数据", { exact: true });
    await expect(trigger).toBeVisible();
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel");
    const send = panel.getByRole("button", { name: "发送", exact: true });
    await panel.getByRole("textbox", { name: "理解画布、修改图片或批量编排…", exact: true }).fill("只检查按钮命中，不发送");
    await expect(send).toBeEnabled();
    // The real canvas shell and diagnostics must participate in hit testing;
    // an isolated composer or bounding boxes alone miss this stacking bug.
    await expect.poll(() => send.evaluate(button => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit === button || Boolean(hit && button.contains(hit));
    })).toBe(true);
    await panel.getByRole("tab", { name: "创建", exact: true }).click();
    await expect(panel).toBeHidden();
    await trigger.click();
    await expect(trigger.locator("..")).toHaveAttribute("open", "");
    await expect(page.getByRole("button", { name: "复制体验报告", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger.locator("..")).not.toHaveAttribute("open");
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
