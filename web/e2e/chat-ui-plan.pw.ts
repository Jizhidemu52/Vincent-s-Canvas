import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";

const output = resolve(import.meta.dirname, "../../output/ui-plan-20261112/chat");
const input = (page: Page) => page.getByRole("textbox", { name: "对话内容", exact: true });
const conversation = (page: Page, id: string) => page.locator(`[data-chat-session="${id}"]`).locator("button").first();
const currentId = (page: Page) => page.locator("[data-chat-session]:has([aria-current=true])").getAttribute("data-chat-session");
const imageDecision = (name: string) => ({ content: `${name} 图片说明`, toolCalls: [{ id: name, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: `${name} 独立图`, edit_spec: { changes: [`${name} 独立图`] } }) } }] });

async function setup(page: Page, held: Map<string, Route>, claude = false) {
    await page.route("**/api/models", route => route.fulfill({ json: { models: [
        { id: "chat", modelId: claude ? "claude-sonnet-5-5" : "gpt-6-astra", name: "隔离对话", capabilities: ["chat", "vision"] },
        { id: "image", modelId: "gpt-image-2", name: "隔离图片", imageParameterProfile: "standard", imageSupportsMask: true, capabilities: ["generate", "edit"] },
    ], prices: [], tools: [{ toolKey: "gpt-chat", enabled: true, modelConfigId: "chat", configurationVersion: 1 }, { toolKey: "gpt-chat-image", enabled: true, modelConfigId: "image", configurationVersion: 1 }] } }));
    await page.route("**/api/chat/responses", route => { held.set(route.request().postDataJSON().profileContext.currentUserText, route); });
    await page.goto("/chat"); await expect(input(page)).toBeEnabled();
}
async function send(page: Page, value: string) { await input(page).fill(value); await page.getByRole("button", { name: "发送", exact: true }).click(); }
async function savedSessions(page: Page) {
    return page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        return chatSessionStorage.load(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, () => null) as Promise<any[]>;
    });
}

test("text A and B continue independently across new/switch and reverse completion", async ({ page, api }) => {
    const held = new Map<string, Route>(); await setup(page, held);
    await send(page, "A 对话"); const idA = (await currentId(page))!;
    await expect.poll(() => held.has("A 对话")).toBe(true);
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    await send(page, "B 对话"); const idB = (await currentId(page))!;
    await expect.poll(() => held.has("B 对话")).toBe(true);
    await conversation(page, idA).click(); await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
    await held.get("B 对话")!.fulfill({ json: { content: "B 独立回复", toolCalls: [] } });
    await expect(page.getByText("B 独立回复", { exact: true })).toHaveCount(0);
    await held.get("A 对话")!.fulfill({ json: { content: "A 独立回复", toolCalls: [] } });
    await expect(page.getByText("A 独立回复", { exact: true })).toBeVisible();
    await conversation(page, idB).click(); await expect(page.getByText("B 独立回复", { exact: true })).toBeVisible();
    await expect(page.getByText("A 独立回复", { exact: true })).toHaveCount(0);
    await page.locator('[data-message-role="assistant"]').getByRole("button", { name: "复制消息", exact: true }).click();
    await expect(page.locator('[data-message-role="assistant"]').getByRole("button", { name: "复制消息", exact: true })).toHaveText("已复制 ✓");
    expect(api.submissions).toHaveLength(0); expect(held.size).toBe(2);
    await page.reload();
    const saved = await savedSessions(page);
    expect(saved.find(item => item.id === idA).messages.map((item: any) => item.content)).toEqual(["A 对话", "A 独立回复"]);
    expect(saved.find(item => item.id === idB).messages.map((item: any) => item.content)).toEqual(["B 对话", "B 独立回复"]);
});

test("late image planning and task completion stay in A while B generates and keeps its draft", async ({ page, api }) => {
    const held = new Map<string, Route>(); api.taskStatus = "processing"; await setup(page, held);
    await send(page, "A 图片"); const idA = (await currentId(page))!;
    await expect.poll(() => held.has("A 图片")).toBe(true);
    await page.getByRole("button", { name: "新对话", exact: true }).click(); await send(page, "B 图片"); const idB = (await currentId(page))!;
    await expect.poll(() => held.has("B 图片")).toBe(true);
    await held.get("B 图片")!.fulfill({ json: imageDecision("B") }); await expect.poll(() => api.submissions.length).toBe(1);
    const taskB = [...api.tasks.values()][0]!; taskB.status = "success"; taskB.resultUrls = [`/api/assets/${taskB.id}/content`];
    await expect(page.locator('[data-message-role="assistant"] .group\\/image')).toHaveCount(1);
    await input(page).fill("B 下一轮未发送草稿");
    await held.get("A 图片")!.fulfill({ json: imageDecision("A") }); await expect.poll(() => api.submissions.length).toBe(2);
    const taskA = [...api.tasks.values()][1]!; taskA.status = "success"; taskA.resultUrls = [`/api/assets/${taskA.id}/content`];
    await expect.poll(async () => (await savedSessions(page)).find(item => item.id === idA)?.messages.some((item: any) => item.generatedImages?.length)).toBe(true);
    await expect(input(page)).toHaveValue("B 下一轮未发送草稿"); await expect(page.locator('[data-message-role="assistant"] .group\\/image')).toHaveCount(1);
    expect(await currentId(page)).toBe(idB);
    await conversation(page, idA).click(); await expect(page.locator('[data-message-role="assistant"] .group\\/image')).toHaveCount(1);
    const sessions = await savedSessions(page);
    expect(sessions.find(item => item.id === idA).messages.flatMap((item: any) => item.generatedImages || []).map((image: any) => image.sourceTaskId)).toEqual([taskA.id]);
    expect(sessions.find(item => item.id === idB).messages.flatMap((item: any) => item.generatedImages || []).map((image: any) => image.sourceTaskId)).toEqual([taskB.id]);
    expect(api.submissions).toHaveLength(2); expect(held.size).toBe(2);
});

test("a held durable save does not lock navigation or erase the next conversation draft", async ({ page, api }) => {
    const held = new Map<string, Route>(); await setup(page, held);
    await page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts"); const original = chatSessionStorage.save.bind(chatSessionStorage);
        let captured = false;
        chatSessionStorage.save = async (key, sessions) => {
            if (!captured && sessions.some(session => session.messages.some(item => item.content === "DELAY_A"))) {
                captured = true; (window as any).__saveHeld = true;
                await new Promise<void>(resolve => { (window as any).__releaseSave = resolve; });
            }
            return original(key, sessions);
        };
    });
    await send(page, "DELAY_A"); await expect.poll(() => page.evaluate(() => Boolean((window as any).__saveHeld))).toBe(true);
    await page.getByRole("button", { name: "新对话", exact: true }).click(); const idB = await currentId(page);
    await input(page).fill("B 草稿保留");
    await page.evaluate(() => (window as any).__releaseSave());
    await expect.poll(() => held.has("DELAY_A")).toBe(true);
    await held.get("DELAY_A")!.fulfill({ json: { content: "A 保存后回复", toolCalls: [] } });
    await expect.poll(async () => (await savedSessions(page)).some(item => item.messages.some((message: any) => message.content === "A 保存后回复"))).toBe(true);
    await expect(input(page)).toHaveValue("B 草稿保留"); expect(await currentId(page)).toBe(idB); expect(api.submissions).toHaveLength(0);
    const idA = (await savedSessions(page)).find(item => item.messages.some((message: any) => message.content === "DELAY_A")).id;
    await conversation(page, idA).click(); await expect(input(page)).toHaveValue("");
    await conversation(page, idB!).click(); await expect(input(page)).toHaveValue("B 草稿保留");
});

test("unsent text and attachment drafts survive A to B and back without submitting", async ({ page, api }) => {
    const held = new Map<string, Route>(); await setup(page, held);
    const idA = (await currentId(page))!;
    await input(page).fill("A 图片草稿");
    await page.locator('input[type="file"]').setInputFiles({ name: "draft-A.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 draft-A.png", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新对话", exact: true }).click(); const idB = (await currentId(page))!;
    await expect(input(page)).toHaveValue(""); await expect(page.getByRole("button", { name: "移除 draft-A.png", exact: true })).toHaveCount(0);
    await input(page).fill("B 文本草稿");
    await conversation(page, idA).click(); await expect(input(page)).toHaveValue("A 图片草稿");
    await expect(page.getByRole("button", { name: "移除 draft-A.png", exact: true })).toBeVisible();
    await conversation(page, idB).click(); await expect(input(page)).toHaveValue("B 文本草稿");
    expect(held.size).toBe(0); expect(api.submissions).toHaveLength(0);
});

test("a failed A pre-save restores A text and original attachment while B keeps its own input", async ({ page, api }) => {
    const held = new Map<string, Route>(); await setup(page, held);
    const idA = (await currentId(page))!;
    await page.locator('input[type="file"]').setInputFiles({ name: "failed-A.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 failed-A.png", exact: true })).toBeVisible();
    await page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts"); const original = chatSessionStorage.save.bind(chatSessionStorage);
        let captured = false;
        chatSessionStorage.save = async (key, sessions) => {
            if (!captured && sessions.some(session => session.messages.some(item => item.content === "FAILED_A"))) {
                captured = true; (window as any).__saveHeld = true;
                await new Promise<void>(resolve => { (window as any).__releaseSave = resolve; });
                throw new Error("isolated failed write");
            }
            return original(key, sessions);
        };
    });
    await send(page, "FAILED_A"); await expect.poll(() => page.evaluate(() => Boolean((window as any).__saveHeld))).toBe(true);
    await page.getByRole("button", { name: "新对话", exact: true }).click(); const idB = (await currentId(page))!;
    await input(page).fill("B 不能被 A 覆盖"); await page.evaluate(() => (window as any).__releaseSave());
    await expect(page.getByText("聊天记录未保存，消息尚未发送；草稿和附件已保留。", { exact: true })).toBeVisible();
    await expect(input(page)).toHaveValue("B 不能被 A 覆盖"); expect(await currentId(page)).toBe(idB);
    await conversation(page, idA).click(); await expect(input(page)).toHaveValue("FAILED_A");
    await expect(page.getByRole("button", { name: "移除 failed-A.png", exact: true })).toBeVisible();
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
    await conversation(page, idB).click(); await expect(input(page)).toHaveValue("B 不能被 A 覆盖");
    expect(held.size).toBe(0); expect(api.submissions).toHaveLength(0);
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) test(`chat compact controls and help at ${viewport.width}x${viewport.height}`, async ({ page, api }) => {
    await mkdir(output, { recursive: true }); await page.setViewportSize(viewport);
    await setup(page, new Map(), true);
    expect((await page.getByTestId("chat-header").boundingBox())!.height).toBe(48);
    await expect(page.getByText("对话保存在当前浏览器。", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "模型设置", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "模型设置", exact: true }).click(); await expect(page.getByRole("combobox", { name: "回复长度", exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "对话改图", exact: true }).click();
    await page.getByRole("button", { name: "对话操作帮助", exact: true }).click(); await expect(page.getByText("处理中可以新建或切换对话，回复会保留在原对话。", { exact: true })).toBeVisible();
    await page.getByRole("heading", { name: "对话改图", exact: true }).click();
    await expect(page.getByText("处理中可以新建或切换对话，回复会保留在原对话。", { exact: true })).not.toBeVisible();
    const sendBox = await page.getByRole("button", { name: "发送", exact: true }).boundingBox(); expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(output, `chat-${viewport.width}x${viewport.height}.png`) });
    expect(api.submissions).toHaveLength(0);
});
