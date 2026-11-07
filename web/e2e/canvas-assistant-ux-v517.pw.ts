import type { BrowserContext, Route } from "@playwright/test";
import { test, expect, fixturePng, newCanvas, uploadImage } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

async function chatFixture(context: BrowserContext) {
    const requests: any[] = [];
    let response: (route: Route) => Promise<void> = route => route.fulfill({ json: { content: "已收到", toolCalls: [] } });
    const models = [
        { id: "ux-image", modelId: "gpt-image-2", name: "隔离图片模型", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 },
        { id: "ux-chat", modelId: "ux-chat", name: "隔离对话模型", protocol: "openai", capabilities: ["chat", "vision", "tools"], creditCost: 0, rmbCost: 0 },
    ];
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? "ux-chat" : "ux-image", configurationVersion: 1 })) } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await context.route("**/api/chat/responses", route => { requests.push(route.request().postDataJSON()); return response(route); });
    return { requests, reply: (next: typeof response) => { response = next; } };
}

const promptPlaceholder = "理解画布、修改图片或批量编排…";

test("创建面板的 @ 添加画布图片并保留草稿，组合回车不触发生成", async ({ page, context, api }) => {
    await chatFixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "quick-mention.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await page.getByRole("tab", { name: "创建", exact: true }).first().click();
    const input = panel.getByRole("textbox", { name: "描述图像", exact: true });
    await input.fill("不要替换这段草稿");
    await page.mouse.click(680, 230);
    await panel.getByRole("button", { name: "清空", exact: true }).click();
    await expect(panel.getByRole("region", { name: "已选参考图" })).toBeHidden();
    await input.fill("不要替换这段草稿，参考@");
    await expect(panel.getByRole("option").first()).toBeVisible();
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true });
    await expect(input).toHaveValue("不要替换这段草稿，参考@");
    await input.press("Enter");
    await expect(input).toHaveValue("不要替换这段草稿，参考@图1 ");
    await expect(panel.getByRole("button", { name: /参考图 1：/ })).toBeVisible();
    await input.fill("不要替换这段草稿，参考@");
    await input.press("Enter");
    await expect(input).toHaveValue("不要替换这段草稿，参考@图1 ");
    await expect(panel.getByRole("button", { name: /移除参考图/ })).toHaveCount(1);
    expect(api.submissions).toHaveLength(0);
});

test("助手草稿和已上传参考图在清空画布选区后保留；自然图号与中文组合回车不选图或误提交", async ({ page, context, api }, info) => {
    const chat = await chatFixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "canvas-selection.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel");
    const input = panel.getByPlaceholder(promptPlaceholder);
    await input.fill("保留这段草稿，参考图片来分析");
    const chooser = page.waitForEvent("filechooser");
    await panel.getByRole("button", { name: "上传设计文件或参考图", exact: true }).click();
    await (await chooser).setFiles({ name: "assistant-reference.png", mimeType: "image/png", buffer: fixturePng(200) });
    await expect(panel.getByRole("button", { name: /参考图 \d：assistant-reference\.png/ })).toBeVisible();
    await page.locator(`[data-node-id="${nodeId}"]`).click();
    await expect(input).toHaveValue("保留这段草稿，参考图片来分析");
    const nodeBounds = await page.locator(`[data-node-id="${nodeId}"]`).boundingBox();
    await page.mouse.click(nodeBounds!.x + nodeBounds!.width + 120, nodeBounds!.y + nodeBounds!.height / 2);
    await expect(page.locator(`[data-node-id="${nodeId}"]`)).not.toHaveAttribute("aria-label", /已选择/);
    await expect(input).toHaveValue("保留这段草稿，参考图片来分析");
    await expect(panel.getByRole("button", { name: "参考图 1：assistant-reference.png，点击调整顺序", exact: true })).toBeVisible();
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true });
    expect(chat.requests).toHaveLength(0);
    await input.fill("参考@");
    await expect(panel.getByRole("listbox", { name: "选择图片引用" })).toHaveCount(0);
    await expect(input).not.toHaveAttribute("aria-autocomplete", "list");
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true });
    await expect(input).toHaveValue("参考@");
    expect(chat.requests).toHaveLength(0);
    await input.press("Escape");
    await input.fill("");
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await expect(panel.getByText("请写下希望如何处理这些图片", { exact: true })).toBeVisible();
    const analysisPrompt = "只分析图1，不生成；备注@只是普通文字";
    await input.fill(analysisPrompt);
    await input.press("Enter");
    await expect(panel.getByText("已收到", { exact: true })).toBeVisible();
    expect(chat.requests).toHaveLength(1);
    expect(chat.requests[0].profileContext.currentUserText).toBe(analysisPrompt);
    expect(chat.requests[0].profileContext.imageCatalog).toHaveLength(1);
    expect(chat.requests[0].profileContext.imageCatalog[0]).toMatchObject({ label: "图1", name: "assistant-reference.png" });
    expect(chat.requests[0].profileContext.previewImageIds).toEqual([chat.requests[0].profileContext.imageCatalog[0].id]);
    await expect.poll(() => api.document(id)?.chatSessions?.flatMap((s: any) => s.messages).filter((m: any) => m.role === "user").length).toBe(1);
    const userMessage = api.document(id)!.chatSessions.flatMap((s: any) => s.messages).find((m: any) => m.role === "user");
    expect(userMessage.references).toHaveLength(1);
    expect(userMessage.references[0].title).toBe("assistant-reference.png");
    expect(Boolean(userMessage.references[0].storageKey) || /^\/api\/assets\/[^/]+\/content/.test(userMessage.references[0].dataUrl || "")).toBe(true);
    expect(userMessage.references[0].dataUrl || "").not.toContain("base64");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
    await expect(input).toBeVisible();
    await page.screenshot({ path: info.outputPath("assistant-narrow-dark.png") });
    expect(api.submissions).toHaveLength(0);
});

test("助手收起不中止回复，完整提示词与 Markdown 可见，向上阅读时显示新消息", async ({ page, context, api }, info) => {
    const chat = await chatFixture(context);
    await newCanvas(page);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel");
    const input = panel.getByPlaceholder(promptPlaceholder);
    let held: Route | undefined;
    chat.reply(async route => { held = route; });
    await input.fill("写三条提示词，保留完整列表");
    await input.press("Enter");
    await expect.poll(() => chat.requests.length).toBe(1);
    await page.getByRole("tab", { name: "创建", exact: true }).first().click();
    await expect(panel).toBeHidden();
    await held!.fulfill({ json: { content: "**提示词：**\n\n1. 第一条海报\n2. 第二条海报\n3. 第三条海报\n\n" + Array.from({ length: 42 }, (_, i) => `第 ${i + 1} 段设计说明。`).join("\n\n"), toolCalls: [] } });
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(panel.getByText("第三条海报", { exact: true })).toBeAttached();
    await expect(panel.locator("strong").filter({ hasText: "提示词：" })).toHaveCount(1);
    const list = panel.getByTestId("canvas-agent-message-list");
    await expect.poll(() => list.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(82);
    await input.fill("继续，只新增一条说明");
    await input.press("Enter");
    await expect.poll(() => chat.requests.length).toBe(2);
    await list.hover();
    await page.mouse.wheel(0, -8000);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeLessThan(20);
    await held!.fulfill({ json: { content: "新增说明必须保留阅读位置", toolCalls: [] } });
    await expect(panel.getByText("新增说明必须保留阅读位置", { exact: true })).toBeAttached();
    await expect(panel.getByRole("button", { name: "↓ 新消息", exact: true })).toBeVisible();
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeLessThan(20);
    await panel.getByRole("button", { name: "↓ 新消息", exact: true }).click();
    await expect(panel.getByText("新增说明必须保留阅读位置", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "↓ 新消息", exact: true })).toBeHidden();
    await page.screenshot({ path: info.outputPath("assistant-follow-and-markdown.png") });
    expect(api.submissions).toHaveLength(0);
});

test("常规确认收起后仍须明确批准删除；刷新使旧确认过期且不会重复提交", async ({ page, context, api }) => {
    const chat = await chatFixture(context);
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel");
    await expect(panel.getByRole("switch")).toHaveCount(0);
    chat.reply(route => route.fulfill({ json: { content: "", toolCalls: [{ id: "delete-one", type: "function", function: { name: "canvas_delete_nodes", arguments: JSON.stringify({ ids: [nodeId] }) } }] } }));
    await panel.getByPlaceholder(promptPlaceholder).fill("删除刚才的文字节点");
    await panel.getByPlaceholder(promptPlaceholder).press("Enter");
    await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toBeVisible();
    await expect(panel.getByText("将删除 1 个对象", { exact: true })).toBeVisible();
    expect(api.document(id)?.nodes).toHaveLength(1);
    await expect.poll(() => api.document(id)?.chatSessions?.flatMap((s: any) => s.messages).some((m: any) => m.detail?.status === "pending")).toBe(true);
    await page.reload();
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    // The clean conversation view hides internal tool titles, but must keep
    // the expiration explanation and recovery action visible.
    await expect(panel.getByText("该操作的执行上下文已失效，尚未重新提交。请恢复原问题到输入框，核对后再发送。", { exact: true })).toBeVisible();
    await expect.poll(() => api.document(id)?.chatSessions?.flatMap((s: any) => s.messages).some((m: any) => m.role === "tool" && m.detail?.status === "expired")).toBe(true);
    await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toBeHidden();
    await panel.getByRole("button", { name: "恢复原问题，核对后重发", exact: true }).click();
    await expect(panel.getByPlaceholder(promptPlaceholder)).toHaveValue("删除刚才的文字节点");
    expect(chat.requests).toHaveLength(1);
    expect(api.document(id)?.nodes).toHaveLength(1);
    expect(api.submissions).toHaveLength(0);
});
