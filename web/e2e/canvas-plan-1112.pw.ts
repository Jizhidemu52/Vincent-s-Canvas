import { readFile } from "node:fs/promises";
import { test, expect, newCanvas, uploadImage, IMAGE } from "./fixtures";

for (const reduced of [false, true]) test(`canvas shared motion curve and library card entrance honor reduced-motion=${reduced}`, async ({ page, api }) => {
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-left-generator-rail");
    const prompt = page.getByRole("textbox", { name: "描述图像", exact: true });
    const motion = await panel.evaluate(element => {
        const panelStyle = getComputedStyle(element);
        const promptStyle = getComputedStyle(element.querySelector(".cw-prompt")!);
        return { name: panelStyle.animationName, duration: panelStyle.animationDuration, curve: panelStyle.animationTimingFunction, promptDuration: promptStyle.transitionDuration, promptCurve: promptStyle.transitionTimingFunction };
    });
    if (reduced) {
        expect(motion.name).toBe("none");
        expect(motion.promptDuration).toBe("0s");
    } else {
        expect(motion).toEqual({ name: "cw-panel-reveal", duration: "0.24s", curve: "cubic-bezier(0.2, 0.7, 0.2, 1)", promptDuration: "0.12s, 0.12s", promptCurve: "cubic-bezier(0.2, 0.7, 0.2, 1), cubic-bezier(0.2, 0.7, 0.2, 1)" });
        await panel.evaluate(element => (element as HTMLElement).style.setProperty("--motion-ease", "linear"));
        expect(await panel.evaluate(element => getComputedStyle(element).animationTimingFunction)).toBe("linear");
        expect(await prompt.evaluate(element => getComputedStyle(element).transitionTimingFunction)).toBe("linear, linear");
    }
    await page.addStyleTag({ content: ".wb-list-card { animation-play-state: paused !important; }" });
    await page.getByRole("button", { name: "返回画布列表", exact: true }).click();
    const card = page.locator(`[data-canvas-project-id="${id}"]`);
    await expect(card).toHaveCount(1);
    const entrance = await card.evaluate(element => {
        const style = getComputedStyle(element);
        const animation = element.getAnimations().find(item => (item as CSSAnimation).animationName === "wb-card-enter");
        return { name: style.animationName, duration: style.animationDuration, curve: style.animationTimingFunction, keyframes: (animation?.effect as KeyframeEffect | null)?.getKeyframes().map(frame => ({ opacity: frame.opacity, translate: frame.translate })) };
    });
    expect(entrance.name).toBe("wb-card-enter");
    expect(entrance.curve).toBe("cubic-bezier(0.2, 0.7, 0.2, 1)");
    expect(Number.parseFloat(entrance.duration)).toBe(reduced ? .00001 : .18);
    expect(entrance.keyframes).toEqual([{ opacity: "0", translate: "0px 8px" }, { opacity: "1", translate: "0px" }]);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("overview renderer loads only at far zoom and restores detailed nodes without changing content", async ({ page, api }) => {
    const overviewLoads: string[] = [];
    page.on("request", request => { if (request.url().includes("canvas-overview-layer")) overviewLoads.push(request.url()); });
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.keyboard.press("Escape");
    await page.mouse.click(1100, 550);
    const original = structuredClone(api.document(id)!.nodes);
    const node = page.locator(`[data-node-id="${original[0].id}"]`);
    await expect(node).toBeVisible();
    await expect(page.getByTestId("canvas-overview-layer")).toHaveCount(0);
    expect(overviewLoads).toHaveLength(0);
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await page.getByRole("button", { name: "25%", exact: true }).click();
    const overview = page.getByTestId("canvas-overview-layer");
    await expect(overview).toBeVisible();
    expect(overviewLoads.length).toBeGreaterThan(0);
    await expect.poll(() => overview.evaluate((element: HTMLCanvasElement) => {
        const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
        return pixels.some((value, index) => index % 4 === 3 && value > 0);
    })).toBe(true);
    await expect(node).toHaveCount(0);
    await page.getByRole("button", { name: "回到 100%", exact: true }).click();
    await expect(overview).toHaveCount(0);
    await expect(node).toBeVisible();
    expect(api.document(id)!.nodes).toEqual(original);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("canvas tooltips retain disabled guidance and Radix parameter triggers", async ({ page, api }) => {
    await newCanvas(page);
    const createTab = page.getByRole("tab", { name: "创建", exact: true });
    await createTab.hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "直接填写提示词和参考图，创建生成任务" })).toBeVisible();
    expect(await createTab.getAttribute("title")).toBeNull();
    await createTab.click();
    const generate = page.locator(".cw-generate-button");
    await expect(generate).toBeDisabled();
    await generate.locator("..").hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "Enter 生成，Shift+Enter 换行" })).toBeVisible();
    const sizeControl = page.getByRole("button", { name: "调整面板大小", exact: true });
    await sizeControl.click();
    await expect(page.locator(".cw-panel-size-popover")).toBeVisible();
    await page.getByRole("button", { name: "关闭面板大小设置", exact: true }).click();
    await page.getByRole("button", { name: "宽高比", exact: true }).click();
    await expect(page.locator(".cw-parameter-popover-size")).toBeVisible();
    await page.locator(".cw-parameter-popover-size").getByRole("button", { name: "返回创建面板", exact: true }).click();
    await page.getByRole("button", { name: "参考图说明", exact: true }).click();
    await expect(page.locator(".cw-reference-hint-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    const selection = page.getByRole("button", { name: /缩放到选中/ });
    await expect(selection).toBeDisabled();
    await selection.locator("..").hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "请先选择节点" })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

for (const reduced of [false, true]) test(`panel close is inert, rapid reopen preserves drafts and reduced-motion=${reduced}`, async ({ page, context, api }) => {
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const prompt = page.getByRole("textbox", { name: "描述图像", exact: true });
    await prompt.fill("收起和重开保留的未发送草稿");
    const creation = await page.evaluate(async reduced => {
        const rail = document.querySelector<HTMLElement>('[data-testid="canvas-left-generator-rail"]')!;
        rail.querySelector<HTMLButtonElement>('.cw-tabs-actions button[aria-expanded="true"]')!.click();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const exiting = document.querySelector<HTMLElement>('[data-testid="canvas-quick-generate-panel"]');
        const observation = { retained: Boolean(exiting), inert: Boolean(exiting?.inert), disabled: Boolean(exiting?.querySelector<HTMLButtonElement>(".cw-generate-button")?.disabled), duration: getComputedStyle(rail).animationDuration, focusedInside: Boolean(exiting?.contains(document.activeElement)) };
        document.querySelector<HTMLButtonElement>('.cw-dock [data-usage-control="canvas-tool.generate"]')!.click();
        await new Promise(resolve => setTimeout(resolve, 300));
        return { ...observation, reopened: Boolean(document.querySelector('[data-testid="canvas-quick-generate-panel"]:not([inert])')), reduced };
    }, reduced);
    expect(creation.retained).toBe(!reduced);
    if (!reduced) { expect(creation.inert).toBe(true); expect(creation.disabled).toBe(true); expect(creation.duration).toBe("0.24s"); }
    expect(creation.focusedInside).toBe(false);
    expect(creation.reopened).toBe(true);
    await expect(prompt).toHaveValue("收起和重开保留的未发送草稿");
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toHaveCount(0);

    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const chat = page.locator(".cw-agent-panel");
    const draft = chat.getByRole("textbox", { name: "理解画布、修改图片或批量编排…", exact: true });
    await draft.fill("对话收起时不丢草稿");
    const assistant = await page.evaluate(async () => {
        const panel = document.querySelector<HTMLElement>(".cw-agent-panel")!;
        panel.querySelector<HTMLButtonElement>('.cw-tabs button[role="tab"]')!.click();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const style = getComputedStyle(panel);
        const observation = { inert: panel.inert, hidden: style.display === "none", duration: style.animationDuration, focusedInside: panel.contains(document.activeElement) };
        document.querySelector<HTMLButtonElement>('.cw-create-panel [role="tab"]:nth-child(2)')!.click();
        await new Promise(resolve => setTimeout(resolve, 300));
        return { ...observation, reopened: !panel.inert && getComputedStyle(panel).display !== "none" };
    });
    expect(assistant.inert).toBe(true);
    expect(assistant.focusedInside).toBe(false);
    if (!reduced) { expect(assistant.hidden).toBe(false); expect(assistant.duration).toBe("0.24s"); }
    expect(assistant.reopened).toBe(true);
    await expect(draft).toHaveValue("对话收起时不丢草稿");
    await chat.getByRole("tab", { name: "创建", exact: true }).click();
    await expect(chat).toBeHidden();
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("new imports do not overlap; More and right-click share grouped image actions", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await newCanvas(page);
    for (const name of ["first.png", "second.png", "third.png"]) {
        await uploadImage(page, name);
        await expect.poll(() => api.document(id)?.nodes.length).toBe(["first.png", "second.png", "third.png"].indexOf(name) + 1);
    }
    const nodes = api.document(id)!.nodes;
    for (let index = 1; index < nodes.length; index++) expect(nodes[index].position.x).toBeGreaterThan(nodes[index - 1].position.x + nodes[index - 1].width);
    await page.keyboard.press("Escape"); await page.keyboard.press("Shift+1");
    const node = page.locator(`[data-node-id="${nodes[2].id}"]`);
    await node.click({ position: { x: 30, y: 40 } });
    await expect(page.locator("[data-inline-image-compare]")).toHaveCount(0);
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    const more = page.locator(".ant-dropdown:visible");
    for (const group of ["AI 改图", "本地编辑", "流程", "素材与信息", "排列与管理"]) await expect(more.getByText(group, { exact: true })).toBeVisible();
    const moreActions = await more.getByRole("menuitem").allTextContents();
    expect(moreActions).not.toContain("超分");
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await node.click({ button: "right", position: { x: 30, y: 40 } });
    const context = page.locator("[data-canvas-image-context]");
    await expect(context).toBeVisible();
    expect(await context.getByRole("menuitem").allTextContents()).toEqual(moreActions);
    const box = await context.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(8);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900 - 7);
    await context.getByRole("menuitem", { name: "裁剪", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "裁剪图片", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "画布缩放与视图", exact: true }).click();
    await expect(page.getByRole("button", { name: /显示全部/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /缩放到选中/ })).toBeEnabled();
    await page.getByRole("button", { name: /显示全部/ }).click();
    await page.keyboard.press("Escape");
    await page.reload();
    for (const item of nodes) {
        const bounds = (await page.locator(`[data-node-id="${item.id}"]`).boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440); expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.keyboard.press("Shift+1");
    await page.screenshot({ path: info.outputPath("canvas-wide.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});

test("queued generations release the composer, permit a new canvas and retain original task ownership", async ({ page, api }) => {
    api.taskStatus = "queued";
    const first = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    const prompt = panel.getByRole("textbox", { name: "描述图像", exact: true });
    for (const text of ["蓝色围巾 A", "红色包款 B"]) {
        await expect(prompt).toBeEnabled();
        await prompt.fill(text);
        await panel.locator("button.cw-generate-button").click();
        await expect.poll(() => api.submissions.length).toBe(text.endsWith("A") ? 1 : 2);
    }
    await expect(prompt).toBeEnabled();
    expect([...api.tasks.values()].every(task => task.status === "queued")).toBe(true);
    await expect.poll(() => api.document(first)?.nodes.length).toBe(2);
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建画布", exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/canvas/${first}$`));
    const second = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(second)?.nodes.length).toBe(1);
    const untouched = structuredClone(api.document(second)!.nodes);
    for (const task of [...api.tasks.values()].reverse()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await page.goto(`/canvas/${first}`);
    await expect.poll(() => api.document(first)?.nodes.filter((node: any) => node.metadata?.status === "success").length).toBe(2);
    expect(api.document(first)!.nodes.map((node: any) => node.metadata.generationRecord.prompt).sort()).toEqual(["红色包款 B", "蓝色围巾 A"]);
    expect(api.document(second)!.nodes).toEqual(untouched);
    expect(api.submissions).toHaveLength(2);
});

test("download is one-step original bytes with optional remembered format conversion", async ({ page, api }) => {
    const id = await newCanvas(page); await uploadImage(page, "source-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    await page.locator(`[data-node-id="${original.id}"]`).click({ position: { x: 30, y: 40 } });
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载图片", exact: true }).click();
    const downloaded = await downloadEvent;
    expect(await readFile((await downloaded.path())!)).toEqual(IMAGE);
    await expect(page.getByRole("dialog", { name: "下载图片", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "更多下载格式", exact: true }).click();
    const convertedEvent = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "另存为 JPG（白底）", exact: true }).click();
    const converted = await convertedEvent;
    const convertedBytes = await readFile((await converted.path())!);
    expect(convertedBytes.subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
    expect(await page.evaluate(() => localStorage.getItem("canvas-image-download-format-v1"))).toBe("jpg");
    expect(api.document(id)!.nodes[0]).toEqual(original);
    expect(api.submissions).toHaveLength(0);
});

test("flat file header, local copy feedback, visible AI entry, grouped commands and responsive dark UI", async ({ page, api }, info) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await newCanvas(page);
    await expect(page.getByRole("button", { name: "返回画布列表", exact: true })).toBeVisible();
    await expect(page.locator('.cw-dock [data-usage-control="canvas-tool.generate"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "全部工具", exact: true })).toContainText("全部工具");
    await expect(page.getByRole("button", { name: "我的素材", exact: true })).toContainText("我的素材");
    await expect(page.getByRole("button", { name: "设计工具", exact: true })).toContainText("设计工具");
    await page.getByRole("button", { name: "复制链接", exact: true }).click();
    await expect(page.locator(".cw-share")).toContainText("已复制");
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "新手引导", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "上传素材", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    const command = page.getByRole("dialog", { name: "命令与搜索", exact: true });
    await expect(command.locator(".cw-command-group-heading").filter({ hasText: /^命令$/ })).toHaveCount(1);
    await expect(command.locator("[role=option] small")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.locator('.cw-dock [data-usage-control="canvas-tool.generate"]').click();
    const prompt = page.getByRole("textbox", { name: "描述图像", exact: true });
    await expect(prompt).toBeVisible();
    expect(await prompt.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.screenshot({ path: info.outputPath("canvas-laptop-create.png"), animations: "disabled" });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.locator(".cw-workspace")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: info.outputPath("canvas-dark.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "打开画布菜单", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("canvas-narrow-dark.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});
