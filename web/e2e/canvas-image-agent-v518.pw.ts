import type { BrowserContext, Route } from "@playwright/test";
import { test, expect, newCanvas, uploadImage } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const placeholder = "理解画布、修改图片或批量编排；输入 @ 引用图片…";
async function fixture(context: BrowserContext, supportsMask = true) {
    const requests: any[] = [];
    let reply: (route: Route, request: any) => Promise<void> = (route, input) => route.fulfill({ json: { content: "准备修改当前图", toolCalls: [{ id: `edit-${requests.length}`, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: input.profileContext.currentUserText, note_update: input.profileContext.currentUserText }) } }] } });
    const models = [
        { id: "test-image", modelId: "gpt-image-2", name: "隔离图片", protocol: "openai", imageParameterProfile: "standard", imageSupportsMask: supportsMask, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 },
        { id: "test-chat", modelId: "test-chat", name: "隔离对话", protocol: "openai", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
    ];
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? "test-chat" : "test-image", configurationVersion: 1 })) } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await context.route("**/api/chat/responses", route => { const input = route.request().postDataJSON(); requests.push(input); return reply(route, input); });
    return { requests, setReply: (next: typeof reply) => { reply = next; } };
}

// Department admins have no canvas workspace access; their component guard is
// covered by the unit test without bypassing the production route restriction.
for (const role of ["designer", "super_admin"] as const) {
    test(`developer controls default hidden and deletion still confirms for ${role}`, async ({ page, context, api }, info) => {
        api.role = role;
        const chat = await fixture(context);
        const id = await newCanvas(page);
        await page.getByRole("tab", { name: "对话", exact: true }).first().click();
        const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
        await panel.getByRole("button", { name: "对话选项", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: /^开发者选项/ })).toHaveCount(role === "super_admin" ? 1 : 0);
        await page.keyboard.press("Escape");
        // The read step also exercises confirmation decisions in the continuation path.
        chat.setReply(route => route.fulfill({ json: { content: "", toolCalls: [{ id: `write-${chat.requests.length}`, type: "function", function: chat.requests.length === 1
            ? { name: "canvas_get_state", arguments: "{}" }
            : { name: "canvas_create_text_node", arguments: JSON.stringify({ text: "保留中文说明", title: "待确认的说明" }) } }] } }));
        await input.fill("读取画布并创建文字说明"); await input.press("Enter");
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toHaveCount(0);
        expect(chat.requests).toHaveLength(2);
        const node = api.document(id)!.nodes[0];
        chat.setReply(route => route.fulfill({ json: { content: "", toolCalls: [{ id: "delete-test", type: "function", function: { name: "canvas_delete_nodes", arguments: JSON.stringify({ ids: [node.id] }) } }] } }));
        await input.fill("删除刚才的说明节点"); await input.press("Enter");
        await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toBeVisible();
        await expect(panel.getByText("将删除 1 个对象", { exact: true })).toBeVisible();
        await expect(panel.getByText(node.title, { exact: true })).toBeVisible();
        await expect(panel.locator("pre, details")).toHaveCount(0);
        expect(api.document(id)?.nodes).toHaveLength(1);
        await page.screenshot({ path: info.outputPath(`${role}-deletion-default.png`), animations: "disabled" });
        await panel.getByRole("button", { name: "批准执行", exact: true }).click();
        await expect.poll(() => api.document(id)?.nodes.length).toBe(0);
        expect(api.submissions).toHaveLength(0);
    });
}

test("developer detail opt-in and extra confirmation are separate administrator controls", async ({ page, context, api }, info) => {
    api.role = "super_admin";
    const chat = await fixture(context), id = await newCanvas(page);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    const developerOption = async (label: string) => {
        await panel.getByRole("button", { name: "对话选项", exact: true }).click();
        await page.getByRole("menuitem", { name: /^开发者选项/ }).hover();
        await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    await developerOption("开启非删除操作确认");
    chat.setReply(route => route.fulfill({ json: { content: "", toolCalls: [{ id: "create-confirmed", type: "function", function: { name: "canvas_create_text_node", arguments: JSON.stringify({ text: "需管理员确认", title: "调试说明" }) } }] } }));
    await input.fill("创建文字说明"); await input.press("Enter");
    await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toBeVisible();
    await expect(panel.getByTestId("canvas-agent-tool-detail")).toHaveCount(0);
    await expect(panel.locator("details")).toHaveCount(0);
    expect(api.document(id)?.nodes || []).toHaveLength(0);
    await developerOption("显示工具详情");
    await expect(panel.locator("details")).toHaveCount(1);
    await panel.locator("summary").click();
    await expect(panel.getByTestId("canvas-agent-tool-detail")).toBeVisible();
    await expect(panel.getByTestId("canvas-agent-tool-detail")).toContainText('"status": "pending"');
    await page.screenshot({ path: info.outputPath("admin-developer-details-enabled.png"), animations: "disabled" });
    await developerOption("隐藏工具详情");
    await expect(panel.locator("pre, details")).toHaveCount(0);
    await panel.getByRole("button", { name: "拒绝执行", exact: true }).click();
    await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toHaveCount(0);
    expect(api.document(id)?.nodes || []).toHaveLength(0);
    expect(api.submissions).toHaveLength(0);
});

test("current image persists through continuous edits, previous/original and selected old branches", async ({ page, context, api }, info) => {
    const chat = await fixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "knitwear.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = api.document(id)!.nodes[0];
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    const send = async (text: string, count: number) => {
        await input.fill(text); await input.press("Enter");
        await expect.poll(() => api.submissions.length).toBe(count);
        await expect.poll(() => api.document(id)?.nodes.filter((node: any) => node.metadata?.imageAgent).length).toBe(count);
        await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    };
    await send("改成V领，保留针织纹理", 1);
    const first = api.document(id)!.nodes.find((node: any) => node.metadata?.imageAgent);
    expect(first.metadata.imageAgent.parentNodeId).toBe(original.id);
    expect(first.position.x).toBeGreaterThan(original.position.x);
    expect(api.document(id)!.connections.some((edge: any) => edge.fromNodeId === original.id && edge.toNodeId === first.id)).toBe(true);
    await send("颜色再浅一点", 2);
    const outputs = api.document(id)!.nodes.filter((node: any) => node.metadata?.imageAgent);
    const second = outputs.find((node: any) => node.id !== first.id);
    expect(second.metadata.imageAgent.parentNodeId).toBe(first.id);
    expect(chat.requests[1].profileContext.lockedImageId).toBeUndefined();
    expect(chat.requests[1].profileContext.previewImageIds).toContain(chat.requests[1].profileContext.focusImageId);
    expect(chat.requests[1].input.at(-1).content).toContain("颜色再浅一点");
    expect(api.submissions.every(item => item.parameters.imageAgentProfile === "canvas-assistant")).toBe(true);
    await panel.locator("[data-image-agent-focus]").getByRole("button", { name: "上一版", exact: true }).click();
    await send("袖子改短", 3);
    const third = api.document(id)!.nodes.find((node: any) => node.metadata?.imageAgent && !outputs.some((old: any) => old.id === node.id));
    expect(third.metadata.imageAgent.parentNodeId).toBe(first.id);
    await panel.locator("[data-image-agent-focus]").getByRole("button", { name: "原图", exact: true }).click();
    chat.setReply((route, input) => route.fulfill({ json: { content: "准备修改", toolCalls: [{ id: "try-other-base", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ base: "none", prompt: input.profileContext.currentUserText }) } }] } }));
    await send("在原版上加小口袋", 4);
    const fourth = api.document(id)!.nodes.find((node: any) => node.metadata?.imageAgent && node.id !== third.id && !outputs.some((old: any) => old.id === node.id));
    expect(fourth.metadata.imageAgent.parentNodeId).toBe(original.id);
    await page.reload(); await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(panel.locator("[data-image-agent-focus]")).toHaveAttribute("data-focus-id", new RegExp(fourth.id));
    await expect.poll(() => panel.locator("[data-image-agent-focus] img").first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(panel.getByText("工具自动执行完成", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("canvas-focus-version-chain.png"), animations: "disabled" });
});

test("seen thumbnails and clarification candidates select the same locked base as @ mentions", async ({ page, context, api }, info) => {
    const chat = await fixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "original.png");
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("改成蓝色"); await input.press("Enter");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    const original = api.document(id)!.nodes[0];
    const seen = panel.getByRole("group", { name: "本轮助手看到了", exact: true });
    await expect(seen.first().getByRole("button")).toHaveCount(1);
    chat.setReply(route => route.fulfill({ json: { content: "你想改图1还是图2？", toolCalls: [] } }));
    await input.fill("你指的是哪一个"); await input.press("Enter");
    const candidates = panel.getByRole("group", { name: "选择要修改的图片", exact: true });
    await expect(candidates.getByRole("button")).toHaveCount(2);
    await candidates.getByRole("button", { name: "选择 图1 作为编辑目标", exact: true }).click();
    await expect(panel.locator("[data-image-agent-focus]")).toContainText("底图已锁定");
    chat.setReply((route, request) => route.fulfill({ json: { content: "修改选中图", toolCalls: [{ id: "edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ base: "none", prompt: request.profileContext.currentUserText }) } }] } }));
    await input.fill("把袖口改短"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(3);
    expect(api.document(id)!.nodes.at(-1).metadata.imageAgent.parentNodeId).toBe(original.id);
    await input.fill("@");
    const menu = panel.getByRole("listbox", { name: "选择图片引用" });
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: /original/ }).first().click();
    const label = await input.inputValue();
    expect(label).toContain("图1");
    await input.fill(`${label} 再把背景改浅灰`); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(3);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(4);
    const lastPlan = chat.requests.at(-1).profileContext;
    expect(lastPlan.imageCatalog.find((image: any) => image.id === lastPlan.lockedImageId).label).toBe("图1");
    expect(api.document(id)!.nodes.at(-1).metadata.imageAgent.parentNodeId).toBe(original.id);
    await page.screenshot({ path: info.outputPath("canvas-seen-candidates-mention.png") });
});

test("canvas mask UI submits paired mask and preserves original outside pixels", async ({ page, context, api }, info) => {
    await fixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "mask-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = api.document(id)!.nodes[0];
    const redPng = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 1024, 1024); return canvas.toDataURL("image/png").split(",")[1]!; });
    await context.route("**/api/assets/*/content", route => api.tasks.has(new URL(route.request().url()).pathname.split("/")[3]!) ? route.fulfill({ contentType: "image/png", body: Buffer.from(redPng, "base64") }) : route.fallback());
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await panel.locator("[data-image-agent-focus]").getByRole("button", { name: "圈选修改", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
    const paint = dialog.getByLabel("修改区域画布", { exact: true });
    await expect(paint).toBeVisible();
    // Ant Modal's opening scale changes pointer coordinates after visibility.
    // Wait for this square fixture's final display size before sampling a bbox.
    await expect.poll(() => paint.evaluate(canvas => {
        const rect = canvas.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)];
    })).toEqual([460, 460]);
    await expect(dialog).not.toHaveClass(/ant-zoom-(?:enter|appear)/);
    await expect(dialog).toHaveCSS("transform", "none");
    await paint.click({ trial: true });
    const box = (await paint.boundingBox())!;
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 8 }); await page.mouse.up();
    const selectedPixels = await paint.evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d")!;
        return { centerAlpha: context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3], cornerAlpha: context.getImageData(1, 1, 1, 1).data[3] };
    });
    expect(selectedPixels.centerAlpha).toBeGreaterThan(0); expect(selectedPixels.cornerAlpha).toBe(0);
    await page.screenshot({ path: info.outputPath("canvas-mask-selected-center.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "保存选区", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await input.fill("只把选区改红"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(api.submissions[0].parameters.inputArchive.maskReferenceIndex).toBe(1);
    expect(api.submissions[0].sourceUrls).toHaveLength(2);
    const result = api.document(id)!.nodes.find((node: any) => node.id !== original.id);
    const pixels = await page.evaluate(async ({ source, output }) => {
        const read = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); return { width: canvas.width, height: canvas.height, edge: [...ctx.getImageData(1, 1, 1, 1).data], center: [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data] }; };
        return { original: await read(source), result: await read(output) };
    }, { source: original.metadata.content, output: result.metadata.content });
    expect(pixels.result.width).toBe(pixels.original.width); expect(pixels.result.height).toBe(pixels.original.height);
    expect(pixels.result.edge).toEqual(pixels.original.edge); expect(pixels.result.center).toEqual([255, 0, 0, 255]);
    await page.screenshot({ path: info.outputPath("canvas-mask-output.png") });
});

test("unsupported masks and multi-generation plans make no generation submission", async ({ page, context, api }) => {
    const chat = await fixture(context, false);
    const id = await newCanvas(page); await uploadImage(page);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await panel.locator("[data-image-agent-focus]").getByRole("button", { name: "圈选修改", exact: true }).click();
    await expect(panel.getByText("当前模型不支持局部蒙版，请先在出图设置选择支持蒙版的模型。", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
    chat.setReply(route => route.fulfill({ json: { content: "准备两张", toolCalls: ["first", "second"].map(callId => ({ id: callId, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: "修改颜色" }) } })) } }));
    await input.fill("改成绿色"); await input.press("Enter");
    await expect(panel.getByText("单轮只允许提交一个生成任务，本轮没有提交；请分别发送要求。", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0); await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
});

test("pending generation does not block chat and late result cannot steal newer explicit focus", async ({ page, context, api }) => {
    const chat = await fixture(context);
    api.taskStatus = "queued";
    const id = await newCanvas(page);
    await uploadImage(page, "hat.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("帽子改成浅蓝色"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    chat.setReply(route => route.fulfill({ json: { content: "针织帽的浅色更适合春夏，这是文字分析。", toolCalls: [] } }));
    await input.fill("只分析浅色适合什么季节，不生成"); await input.press("Enter");
    await expect(panel.getByText("针织帽的浅色更适合春夏，这是文字分析。", { exact: true })).toBeVisible();
    const focusBefore = await panel.locator("[data-image-agent-focus]").getAttribute("data-focus-id");
    for (const task of api.tasks.values()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await expect.poll(() => api.document(id)?.nodes.length, { timeout: 30_000 }).toBe(2);
    expect(await panel.locator("[data-image-agent-focus]").getAttribute("data-focus-id")).toBe(focusBefore);
    expect(api.submissions).toHaveLength(1);
});

test("accepted task card stops local waiting, ignores a late response and queries the original task without resubmission", async ({ page, context, api }, info) => {
    await fixture(context); api.taskStatus = "queued";
    let heldRead: Route | undefined, holdRead = true;
    await context.route(/\/api\/tasks\/[^/?]+$/, async route => {
        const path = new URL(route.request().url()).pathname, taskId = path.split("/").at(-1)!;
        if (route.request().method() !== "GET" || !api.tasks.has(taskId)) return route.fallback();
        api.taskReads.push(path);
        if (holdRead && !heldRead) { heldRead = route; return; }
        await route.fulfill({ json: { task: api.tasks.get(taskId) } });
    });
    const id = await newCanvas(page); await uploadImage(page, "stop-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("把帽子改为浅蓝色"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    const task = [...api.tasks.values()][0];
    const card = panel.getByText(`原任务：${task.id}`, { exact: true }).locator("..");
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await expect.poll(() => Boolean(heldRead)).toBe(true);
    await card.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(card.getByRole("button", { name: "停止本页等待", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    // Querying a still-queued original task owns a fresh stop target, and cannot
    // start another concurrent query of that same task through the card button.
    await card.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect(card.getByRole("button", { name: "停止本页等待", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await card.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(card.getByRole("button", { name: "停止本页等待", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; holdRead = false;
    // The shared snapshot HTTP read remains alive for other consumers. Stopping
    // this card revokes only its authority to apply the eventual result.
    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${task.id}`);
    await heldRead!.fulfill({ json: { task } }); await (await lateResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(`[data-node-id="agent-${task.id}-0"]`)).toHaveCount(0);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.screenshot({ path: info.outputPath("accepted-task-stopped.png"), animations: "disabled" });
    const readsBeforeQuery = api.taskReads.length;
    await card.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.id === `agent-${task.id}-0`)).toBe(true);
    expect(api.taskReads.slice(readsBeforeQuery)).toContain(`/api/tasks/${task.id}`);
    expect(api.submissions).toHaveLength(1); expect(api.submissions[0].requestId).toBe(task.requestId);
    await expect(panel.getByText("已取回原任务结果并放入画布，没有重新生成。", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("accepted-task-original-query.png"), animations: "disabled" });
});

test("two accepted tasks stop only the chosen card and retain independent original-task recovery", async ({ page, context, api }, info) => {
    await fixture(context); api.taskStatus = "queued";
    const id = await newCanvas(page); await uploadImage(page, "two-tasks-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    for (const [index, text] of ["帽子改为蓝色", "帽子改为绿色"].entries()) {
        await input.fill(text); await input.press("Enter"); await expect.poll(() => api.submissions.length).toBe(index + 1);
        await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    }
    const [first, second] = [...api.tasks.values()];
    const firstCard = panel.getByText(`原任务：${first.id}`, { exact: true }).locator("..");
    const secondCard = panel.getByText(`原任务：${second.id}`, { exact: true }).locator("..");
    await expect(firstCard.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await expect(secondCard.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await firstCard.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(firstCard.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    await expect(firstCard.getByRole("button", { name: "停止本页等待", exact: true })).toHaveCount(0);
    await expect(secondCard.getByRole("button", { name: "停止本页等待", exact: true })).toBeVisible();
    await expect(secondCard.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    for (const task of [first, second]) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.id === `agent-${second.id}-0`), { timeout: 30_000 }).toBe(true);
    expect(api.document(id)!.nodes.some((node: any) => node.id === `agent-${first.id}-0`)).toBe(false);
    expect(api.document(id)!.nodes).toHaveLength(2); expect(api.submissions).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("only-selected-task-stopped.png"), animations: "disabled" });
    await firstCard.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(3);
    expect(api.document(id)!.nodes.some((node: any) => node.id === `agent-${first.id}-0`)).toBe(true);
    expect(api.submissions).toHaveLength(2);
});

test("stopping an accepted card does not cancel another current planning reply", async ({ page, context, api }) => {
    const chat = await fixture(context); api.taskStatus = "queued";
    const id = await newCanvas(page); await uploadImage(page, "planning-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("帽子改成蓝色"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const task = [...api.tasks.values()][0], card = panel.getByText(`原任务：${task.id}`, { exact: true }).locator("..");
    let planning: Route | undefined;
    chat.setReply(async route => { planning = route; });
    await input.fill("只分析这个蓝色适合什么季节，不要生成"); await input.press("Enter");
    await expect.poll(() => Boolean(planning)).toBe(true);
    await card.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    expect(planning!.request().failure()).toBeNull();
    await planning!.fulfill({ json: { content: "这个蓝色适合春夏，本轮仅分析。", toolCalls: [] } });
    await expect(panel.getByText("这个蓝色适合春夏，本轮仅分析。", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1); expect(api.document(id)!.nodes).toHaveLength(1);
});
