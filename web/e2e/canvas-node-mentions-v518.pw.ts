import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";
import type { BrowserContext } from "@playwright/test";

const project = "node-mentions-v518";
const conversationBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=", "base64");
function seed(api: MockCanvasApi) {
    api.assetBytes.set("canvas-photo", IMAGE);
    api.assetBytes.set("session-a", conversationBytes);
    const now = new Date().toISOString();
    const session = (id: string, name: string) => ({ id, title: name, createdAt: now, updatedAt: now, messages: [{ id: `message-${id}`, role: "user", text: name,
        references: [{ id: `image-${id}`, type: "image", title: name, dataUrl: `/api/assets/${id}/content` }] }] });
    const document = { id: project, title: "节点引用验收", createdAt: now, updatedAt: now, nodes: [
        { id: "config", type: "config", title: "引用配置", position: { x: 650, y: 120 }, width: 480, height: 640, metadata: { generationMode: "image", model: "gpt-image-2", composerContent: "保留原有草稿", configImageInputMode: "combined" } },
        { id: "canvas-photo", type: "image", title: "画布参考原图", position: { x: 1300, y: 160 }, width: 200, height: 200, metadata: { content: "/api/assets/canvas-photo/content" } },
    ], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false,
        chatSessions: [session("session-a", "当前对话原图"), session("session-b", "其他会话保密图")], activeChatId: "session-a" };
    api.documents.set(project, { id: project, revision: 1, deleted: false, document, updatedAt: now });
}

async function auxiliary(context: BrowserContext) {
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0 } }));
}

test("节点 @ 合并当前对话和画布图片，保留草稿、去重、同序编号进入真实请求", async ({ page, context, api }, info) => {
    seed(api); await auxiliary(context); await page.goto(`/canvas/${project}`);
    const panel = page.locator('[data-node-id="config"]');
    const editor = panel.getByRole("textbox", { name: "提示词", exact: true });
    await expect(editor).toContainText("保留原有草稿");
    await editor.click(); await editor.press("End"); await editor.pressSequentially("，参考@");
    const menu = panel.getByRole("listbox", { name: "选择图片引用" });
    await expect(menu.getByRole("option", { name: /当前对话原图/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /画布参考原图/ })).toBeVisible();
    await expect(menu).not.toContainText("其他会话保密图");
    await expect(menu.getByText("画布图片", { exact: true })).toBeVisible();
    await expect(menu.getByText("对话图片", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("node-grouped-image-mentions.png") });
    await editor.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("option", { name: /当前对话原图/ }).click();
    await expect(editor).toContainText("保留原有草稿，参考");
    await expect(editor.locator("[data-reference-label]")).toHaveText(["图1"]);
    await expect.poll(() => api.document(project)?.nodes[0].metadata.manualImageReferences?.length).toBe(1);
    await editor.pressSequentially("再次@");
    await menu.getByRole("option", { name: /当前对话原图/ }).click();
    await expect(editor.locator("[data-reference-label]")).toHaveText(["图1", "图1"]);
    await expect.poll(() => api.document(project)?.nodes[0].metadata.manualImageReferences?.length).toBe(1);
    await editor.pressSequentially("并参考@");
    await menu.getByRole("option", { name: /画布参考原图/ }).click();
    await expect(editor.locator("[data-reference-label]")).toHaveText(["图1", "图1", "图2"]);
    await panel.getByRole("button", { name: "参考图2前移", exact: true }).click();
    await expect(editor.locator("[data-reference-label]")).toHaveText(["图2", "图2", "图1"]);
    await expect.poll(() => api.document(project)?.nodes[0].metadata.manualImageReferences?.length).toBe(2);
    expect(api.document(project)?.nodes).toHaveLength(2);
    expect(api.document(project)?.nodes[0].metadata.composerContent).toContain(":chat-image:message-session-a:reference:0:image-session-a]");
    await page.screenshot({ path: info.outputPath("node-current-chat-references.png") });
    await panel.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].prompt).toContain("保留原有草稿，参考图片2 再次图片2 并参考图片1");
    expect(api.submissions[0].sourceUrls).toHaveLength(2);
    const uploaded = api.submissions[0].sourceUrls.map((url: string) => api.assetBytes.get(url.split("/")[3]!));
    expect(uploaded).toEqual([IMAGE, conversationBytes]);
});

test("切换当前会话更新节点候选，新账号不能继续选择旧账号图片", async ({ page, context, api }, info) => {
    seed(api); await auxiliary(context); await page.goto(`/canvas/${project}`);
    const panel = page.locator('[data-node-id="config"]'), editor = panel.getByRole("textbox", { name: "提示词", exact: true });
    await editor.click(); await editor.press("End"); await editor.pressSequentially("@");
    await expect(panel.getByRole("option", { name: /当前对话原图/ })).toBeVisible();
    await expect(panel.getByRole("option", { name: /其他会话保密图/ })).toHaveCount(0);
    await editor.press("Escape");
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const assistant = page.locator(".cw-agent-panel");
    await assistant.getByRole("button", { name: "对话选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "对话历史", exact: true }).click();
    const row = assistant.locator("div.rounded-lg.border").filter({ has: page.getByRole("button", { name: "其他会话保密图", exact: true }) });
    await row.getByRole("button", { name: /^进\s*入$/ }).click();
    await page.getByRole("tab", { name: "创建", exact: true }).first().click();
    await editor.click(); await editor.press("End"); await editor.pressSequentially(" "); await editor.pressSequentially("@");
    await expect(panel.getByRole("option", { name: /其他会话保密图/ })).toBeVisible();
    await expect(panel.getByRole("option", { name: /当前对话原图/ })).toHaveCount(0);
    await context.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "other", displayName: "隔离账号B", role: "designer", status: "active" } } }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect(api.document(project)?.nodes[0].metadata.manualImageReferences).toBeUndefined();
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("node-reference-owner-boundary.png") });
});
