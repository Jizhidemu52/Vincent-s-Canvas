import type { Page } from "@playwright/test";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";

async function prepare(page: Page, plans: any[], planner?: (body: any, index: number) => any, imageParameterProfile = "standard") {
    await page.route("**/api/models", route => route.fulfill({ json: {
        models: [
            { id: "fixture-chat", modelId: "gpt-6-astra", name: "隔离对话模型", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
            { id: "fixture-image", modelId: "gpt-image-2", name: "隔离图片模型", imageParameterProfile, imageSupportsMask: true, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
        ], prices: [], tools: [{ toolKey: "gpt-chat", enabled: true, modelConfigId: "fixture-chat", configurationVersion: 1 }, { toolKey: "gpt-chat-image", enabled: true, modelConfigId: "fixture-image", configurationVersion: 1 }],
    } }));
    await page.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); plans.push(body);
        const answer = planner?.(body, plans.length) || { content: "好的，按你的要求调整。", toolCalls: [{ id: "edit-" + plans.length, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: body.profileContext.currentUserText, note_update: "当前设计：" + body.profileContext.currentUserText, keep: ["版型", "白色背景"] }) } }] };
        return route.fulfill({ json: answer });
    });
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
}
async function send(page: Page, content: string) {
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill(content);
    await page.getByRole("button", { name: "发送", exact: true }).click();
}
async function upload(page: Page, name = "原图.png") {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 " + name, exact: true })).toBeVisible();
}
const generated = (page: Page) => page.locator('[data-message-role="assistant"] .group\\/image');
async function complete(api: MockCanvasApi, id: string) { const task = api.tasks.get(id)!; task.status = "success"; task.resultUrls = [`/api/assets/${id}/content`]; }

async function uploadSize(page: Page, width: number, height: number) {
    const png = await page.evaluate(({ width, height }) => { const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#f6edd7"; ctx.fillRect(0, 0, width, height); ctx.fillStyle = "#273e5b"; ctx.fillRect(width / 4, height / 4, width / 2, height / 2); return canvas.toDataURL("image/png").split(",")[1]; }, { width, height });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "画幅底图.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await expect(page.getByRole("button", { name: "移除 画幅底图.png", exact: true })).toBeVisible();
}

async function savedSessions(page: Page) {
    return page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        return chatSessionStorage.load(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, () => null);
    });
}

async function selectImageSize(page: Page, label: string) {
    await page.getByRole("button", { name: "出图设置", exact: true }).click();
    await page.getByRole("combobox", { name: "图片尺寸", exact: true }).click();
    // Ant Design's virtual accessibility options are hidden; use the rendered popup item.
    await page.locator(".ant-select-dropdown:visible").getByText(label, { exact: true }).and(page.locator(".ant-select-item-option-content")).click();
    await page.getByRole("button", { name: "出图设置", exact: true }).click();
}

for (const [width, height] of [[1280, 1707], [1707, 1280], [1254, 1254]] as const) {
    test(`默认改图以自动画幅提交 ${width}x${height} 底图且刷新保留`, async ({ page, api }) => {
        const plans: any[] = [];
        await prepare(page, plans, undefined, "pixel");
        await uploadSize(page, width, height);
        await send(page, "只把衣服改成蓝色，完整保留背景");
        await expect(generated(page)).toHaveCount(1);
        expect(api.submissions).toHaveLength(1);
        expect(api.submissions[0].parameters.size).toBe("auto");
        await expect.poll(async () => (await savedSessions(page))[0]?.messages.findLast((item: any) => item.generatedImages)?.generatedImages[0].size).toBe("auto");
        await page.reload();
        await expect(generated(page)).toHaveCount(1);
        const sessions = await savedSessions(page);
        expect(sessions[0].imageSize).toBeUndefined();
        expect(sessions[0].messages.findLast((item: any) => item.generatedImages).generatedImages[0].size).toBe("auto");
        expect(sessions[0].messages.find((item: any) => item.attachments?.length).attachments[0]).toMatchObject({ width, height });
        expect(api.submissions).toHaveLength(1);
    });
}

test("显式方图优先且刷新保留，恢复默认后的新创作不沿用旧纵图", async ({ page, api }, info) => {
    const plans: any[] = [];
    await prepare(page, plans, undefined, "pixel");
    const globalSize = await page.evaluate(async () => (await import("/src/stores/use-config-store.ts")).useConfigStore.getState().config.size);
    await uploadSize(page, 1500, 2000);
    await selectImageSize(page, "1:1");
    await send(page, "明确生成方图"); await expect(generated(page)).toHaveCount(1);
    expect(api.submissions[0].parameters.size).toBe("1:1");
    await page.reload(); await expect(generated(page)).toHaveCount(1);
    await page.getByRole("button", { name: "出图设置", exact: true }).click();
    await expect(page.getByTestId("chat-image-size")).toContainText("1:1");
    await page.screenshot({ path: info.outputPath("chat-image-size-settings.png"), animations: "disabled" });
    await page.getByRole("button", { name: "出图设置", exact: true }).click();
    await selectImageSize(page, "自动（默认）");
    await page.locator("[data-image-agent-focus]").getByRole("button", { name: "新创作", exact: true }).click();
    await send(page, "新画一顶帽子"); await expect(generated(page)).toHaveCount(2);
    expect(plans.at(-1).profileContext.newCreation).toBe(true);
    expect(api.submissions[1].parameters.size).toBe("auto");
    expect(api.submissions[1].sourceUrls || []).toHaveLength(0);
    expect((await savedSessions(page))[0].imageSize).toBeUndefined();
    expect(await page.evaluate(async () => (await import("/src/stores/use-config-store.ts")).useConfigStore.getState().config.size)).toBe(globalSize);
});

test("连续改图常驻焦点、上传参考、候选版本与新创作保持一致", async ({ page, api }, info) => {
    const plans: any[] = [];
    await prepare(page, plans, body => {
        if (body.profileContext.currentUserText === "请帮我选择") return { content: "你想改图1还是图2？", toolCalls: [] };
        const palette = body.profileContext.imageCatalog.filter((item: any) => item.kind === "upload").at(-1);
        return { content: "已按要求调整。", toolCalls: [{ id: "edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: body.profileContext.currentUserText, ...(body.profileContext.currentUserText === "按上传配色" ? { references: [palette.id] } : {}), note_update: "浅蓝色V领上衣", keep: ["版型", "白底"] }) } }] };
    });
    await send(page, "画一件T恤"); await expect(generated(page)).toHaveCount(1);
    const focus = page.locator("[data-image-agent-focus]");
    const first = [...api.tasks.keys()][0]!;
    await expect(focus).toHaveAttribute("data-focus-id", first + ":0");
    await send(page, "颜色再浅点"); await expect(generated(page)).toHaveCount(2);
    const second = [...api.tasks.keys()][1]!;
    expect(plans[1].profileContext.focusImageId).toBe(first + ":0");
    expect(plans[1].profileContext.previewImageIds).toContain(first + ":0");
    await expect(focus).toHaveAttribute("data-focus-id", second + ":0");
    await upload(page, "配色.png");
    await expect(focus).toHaveAttribute("data-focus-id", second + ":0");
    await expect(focus).toContainText("参考图 1");
    await send(page, "按上传配色"); await expect(generated(page)).toHaveCount(3);
    expect(plans[2].profileContext.focusImageId).toBe(second + ":0");
    expect(api.submissions[2].sourceUrls).toHaveLength(2);
    await focus.getByRole("button", { name: "上一版", exact: true }).click();
    await expect(focus).toHaveAttribute("data-focus-id", second + ":0");
    await expect(focus).toContainText("底图已锁定");
    await send(page, "请帮我选择");
    const candidates = page.getByRole("group", { name: "选择要修改的图片", exact: true });
    await expect(candidates.getByRole("button")).toHaveCount(2);
    await candidates.getByRole("button").first().click();
    await expect(focus).toHaveAttribute("data-focus-id", first + ":0");
    await page.reload(); await expect(focus).toHaveAttribute("data-focus-id", first + ":0");
    await focus.getByRole("button", { name: "选择图片", exact: true }).click();
    await expect(focus.getByRole("group", { name: "作品版本", exact: true }).getByRole("button")).toHaveCount(3);
    await focus.getByRole("button", { name: "新创作", exact: true }).click();
    await send(page, "画一顶帽子"); await expect(generated(page)).toHaveCount(4);
    expect(plans.at(-1).profileContext.newCreation).toBe(true);
    expect(plans.at(-1).profileContext.previewImageIds).toEqual([]);
    await focus.getByRole("button", { name: "选择图片", exact: true }).click();
    await page.getByRole("button", { name: "出图设置", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "出图模型", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("chat-focus-version-settings-light.png"), animations: "disabled" });
    await page.getByRole("button", { name: "出图设置", exact: true }).click();
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.getByRole("button", { name: "切换到浅色主题", exact: true })).toBeVisible();
    await generated(page).last().hover();
    await expect(generated(page).last().getByRole("button", { name: "在此基础上改", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("chat-focus-actions-dark.png"), animations: "disabled" });
    expect(plans).toHaveLength(5); expect(api.submissions).toHaveLength(4);
});

test("生成中的独立任务允许继续聊天，刷新后各自恢复且晚任务不抢焦点", async ({ page, api }, info) => {
    const plans: any[] = [];
    api.taskStatus = "processing";
    await prepare(page, plans, body => body.profileContext.currentUserText === "先讨论颜色" ? { content: "可以先用浅蓝色。", toolCalls: [] } : undefined);
    await send(page, "先画一件外套");
    await expect(page.getByTestId("chat-pending-image-card")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "停止本页等待", exact: true })).toHaveCount(1);
    await send(page, "再画一顶帽子");
    await expect(page.getByTestId("chat-pending-image-card")).toHaveCount(2);
    await send(page, "先讨论颜色");
    await expect(page.getByText("可以先用浅蓝色。", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(2);
    const [first, second] = [...api.tasks.keys()];
    await complete(api, second!);
    await page.reload();
    await expect(generated(page)).toHaveCount(1);
    await expect(page.getByTestId("chat-pending-image-card")).toHaveCount(1);
    const focus = page.locator("[data-image-agent-focus]");
    await expect(focus).toHaveAttribute("data-focus-id", second + ":0");
    await focus.getByRole("button", { name: "新创作", exact: true }).click();
    await complete(api, first!);
    await page.getByTestId("chat-image-recovery-action").click();
    await expect(generated(page)).toHaveCount(2);
    await expect(page.getByTestId("chat-pending-image-card")).toHaveCount(0);
    await expect(focus).toContainText("不沿用当前图片");
    expect(api.submissions).toHaveLength(2);
    expect(plans).toHaveLength(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("complementary").getByRole("button", { name: "收起会话", exact: true }).click();
    await page.screenshot({ path: info.outputPath("chat-concurrent-restored-mobile.png"), animations: "disabled" });
    expect(await page.locator("main").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("圈选保存真实蒙版，提交时尺寸配对并保留选区外像素", async ({ page, api }, info) => {
    const plans: any[] = [];
    await prepare(page, plans);
    const redPng = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 1024; c.height = 1024; const x = c.getContext("2d")!; x.fillStyle = "#ff0000"; x.fillRect(0, 0, 1024, 1024); return c.toDataURL("image/png").split(",")[1]!; });
    await page.route("**/api/assets/*/content", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3]!;
        return api.tasks.has(id) ? route.fulfill({ contentType: "image/png", body: Buffer.from(redPng, "base64") }) : route.fallback();
    });
    await upload(page); await send(page, "先看看这张图"); await expect(generated(page)).toHaveCount(1);
    // Select the real original upload, not the generated red fixture.
    const uploadCard = page.locator('[data-message-role="user"] .group\\/image').first();
    await uploadCard.hover(); await uploadCard.getByRole("button", { name: "更多图片操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "圈选修改", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
    const paint = dialog.getByLabel("修改区域画布", { exact: true });
    await expect(paint).toBeVisible();
    await paint.click({ trial: true });
    await expect(dialog).not.toHaveClass(/ant-zoom-(?:enter|appear)/);
    await expect(dialog).toHaveCSS("transform", "none");
    const box = (await paint.boundingBox())!;
    expect(box.width).toBeGreaterThan(200); expect(box.height).toBeGreaterThan(200);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    await page.screenshot({ path: info.outputPath("chat-region-selection.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "保存选区", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(page.getByText("已圈选局部区域，仅修改选区内", { exact: true })).toBeVisible();
    await selectImageSize(page, "1536 × 1024");
    await send(page, "把这里改成红色"); await expect(generated(page)).toHaveCount(2);
    const submitted = api.submissions.at(-1)!;
    expect(submitted.sourceUrls).toHaveLength(2);
    expect(submitted.parameters.inputArchive.maskReferenceIndex).toBe(1);
    expect(submitted.parameters.size).toBe("1024x1024");
    await expect.poll(async () => (await savedSessions(page))[0]?.messages.findLast((item: any) => item.generatedImages)?.generatedImages[0].size).toBe("1024x1024");
    expect((await savedSessions(page))[0].imageSize).toBe("1536x1024");
    const pixelResult = await generated(page).last().locator("img").evaluate(async image => {
        const original = document.querySelector('[data-message-role="user"] .group\\/image img') as HTMLImageElement;
        const pixels = async (src: string) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext("2d")!; x.drawImage(img, 0, 0); return { width: c.width, height: c.height, edge: [...x.getImageData(1, 1, 1, 1).data], center: [...x.getImageData(128, 128, 1, 1).data] }; };
        return { original: await pixels(original.src), edited: await pixels((image as HTMLImageElement).src) };
    });
    expect(pixelResult.edited.width).toBe(256); expect(pixelResult.edited.height).toBe(256);
    expect(pixelResult.edited.edge).toEqual(pixelResult.original.edge);
    expect(pixelResult.edited.center).toEqual([255, 0, 0, 255]);
    await expect(page.getByText("已圈选局部区域，仅修改选区内", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("chat-mask-result.png"), animations: "disabled" });
});
