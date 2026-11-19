import { createServer, type ServerResponse } from "node:http";
import type { Page } from "@playwright/test";
import { startChatResultWait } from "../../server/src/chat-result-wait";
import { test, expect, IMAGE } from "./fixtures";

const generated = (page: Page) => page.locator('[data-message-role="assistant"] .group\\/image');
const answer = (prompt: string) => ({ content: "将保留当前版型继续修改。", toolCalls: [{ id: "edit-current", type: "function" as const, function: { name: "edit_image", arguments: JSON.stringify({ base: "focus", prompt, edit_spec: { changes: [prompt], acceptance: ["原版型保持不变"] } }) } }] });

async function waitingServer() {
    let elapsed = 0, heartbeat = () => {}, response: ServerResponse | undefined;
    let stream: ReturnType<typeof startChatResultWait> | undefined;
    let requests = 0, closed = false;
    const server = createServer((request, currentResponse) => {
        requests++;
        response = currentResponse;
        currentResponse.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": request.headers.origin || "http://127.0.0.1:5366", "Access-Control-Allow-Credentials": "true",
        });
        stream = startChatResultWait(value => currentResponse.write(value), { now: () => elapsed, every: callback => { heartbeat = callback; return () => { heartbeat = () => {}; }; } });
        currentResponse.on("close", () => { closed = true; stream?.close(); });
        request.resume();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server address missing");
    return {
        url: `http://127.0.0.1:${address.port}/api/chat/responses`,
        get requests() { return requests; },
        get closed() { return closed; },
        advance(milliseconds: number) { elapsed = milliseconds; heartbeat(); },
        complete(prompt: string) { stream!.complete(answer(prompt)); response!.end(); },
        fail() { stream!.fail({ code: "CHAT_REQUEST_TIMEOUT", message: "对话模型请求在 600 秒内未完成，已超时；本轮对话未完成，不会自动重新提交。" }); response!.end(); },
        async close() { stream?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
    };
}

async function prepare(page: Page, stream: Awaited<ReturnType<typeof waitingServer>>) {
    const plans: any[] = [];
    await page.route("**/api/models", route => route.fulfill({ json: { models: [
        { id: "chat", modelId: "gemini-4-carbon", name: "隔离对话", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 },
        { id: "image", modelId: "gpt-image-2", name: "隔离图片", imageParameterProfile: "standard", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    ], prices: [], tools: [{ toolKey: "gpt-chat", enabled: true, modelConfigId: "chat", configurationVersion: 1 }, { toolKey: "gpt-chat-image", enabled: true, modelConfigId: "image", configurationVersion: 1 }] } }));
    await page.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON();
        plans.push(body);
        expect(route.request().headers().accept).toBe("text/event-stream");
        return plans.length === 1 ? route.fulfill({ json: answer(body.profileContext.currentUserText) }) : route.continue({ url: stream.url });
    });
    await page.goto("/chat");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "原版.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 原版.png", exact: true })).toBeVisible();
    await send(page, "衣身改为灰蓝色，保留版型和拉链");
    await expect(generated(page)).toHaveCount(1);
    await send(page, "继续修改，改为白底平铺，衣身改米白，版型和拉链保持不变");
    await expect.poll(() => stream.requests).toBe(1);
    await expect(page.getByText("正在等待模型完成当前请求，不会重复提交。", { exact: true })).toBeVisible();
    return plans;
}

async function send(page: Page, text: string) {
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
}

async function session(page: Page) {
    return page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        const sessions = await chatSessionStorage.load(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, () => null) as any[];
        return sessions[0];
    });
}

test("第二轮超过原180秒边界仍等待同一请求，收到完整结果后只改当前图一次", async ({ page, api }, info) => {
    const stream = await waitingServer();
    try {
        const plans = await prepare(page, stream);
        const first = (await session(page)).messages.flatMap((message: any) => message.generatedImages || [])[0];
        expect(plans[1].profileContext.focusImageId).toBe(first.id);
        expect(plans[1].profileContext.previewImageIds).toContain(first.id);
        expect(JSON.stringify(plans[1].input)).toContain("衣身改为灰蓝色");
        expect(api.submissions).toHaveLength(1);
        stream.advance(195_000);
        await expect(page.getByText("模型仍在处理原请求，已超过 180 秒；正在继续等待同一请求，不会重新提交。", { exact: true })).toBeVisible();
        await page.getByTestId("chat-message-list").evaluate(element => { element.scrollTop = 0; });
        const phase = page.getByTestId("chat-send-phase");
        await expect(phase).toBeInViewport();
        expect(await phase.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
        })).toBe(true);
        expect(plans).toHaveLength(2);
        expect(stream.requests).toBe(1);
        expect(api.submissions).toHaveLength(1);
        await page.mouse.move(10, 10);
        await page.screenshot({ path: info.outputPath("second-turn-waiting.png"), animations: "disabled" });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator("aside").getByRole("button", { name: "收起会话", exact: true }).click();
        await expect(phase).toBeInViewport();
        expect(await phase.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
        })).toBe(true);
        await expect(page.getByRole("button", { name: "停止", exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath("second-turn-waiting-mobile.png"), animations: "disabled" });
        await page.setViewportSize({ width: 1440, height: 1000 });
        stream.complete(plans[1].profileContext.currentUserText);
        await expect(generated(page)).toHaveCount(2);
        await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
        const saved = await session(page);
        const images = saved.messages.flatMap((message: any) => message.generatedImages || []);
        expect(images[1].parentId).toBe(first.id);
        expect(api.submissions[1].parameters.inputArchive.references.map((item: any) => item.id)).toEqual([first.id]);
        expect(JSON.stringify(saved.messages)).not.toContain("超过 180 秒");
        expect(api.submissions).toHaveLength(2);
        await page.screenshot({ path: info.outputPath("second-turn-complete.png"), animations: "disabled" });
        await page.reload();
        await expect(generated(page)).toHaveCount(2);
        expect(plans).toHaveLength(2);
        expect(api.submissions).toHaveLength(2);
    } finally { await stream.close(); }
});

test("第二轮等待时停止不会提交图像或自动重发，已有首轮结果保留", async ({ page, api }) => {
    const stream = await waitingServer();
    try {
        const plans = await prepare(page, stream);
        await page.getByRole("button", { name: "停止", exact: true }).click();
        await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
        await expect.poll(() => stream.closed).toBe(true);
        await expect(generated(page)).toHaveCount(1);
        await page.reload();
        await expect(generated(page)).toHaveCount(1);
        expect(plans).toHaveLength(2);
        expect(stream.requests).toBe(1);
        expect(api.submissions).toHaveLength(1);
    } finally { await stream.close(); }
});

test("第二轮等待终结失败不把心跳当作回答且不出图或重发", async ({ page, api }) => {
    const stream = await waitingServer();
    try {
        const plans = await prepare(page, stream);
        stream.fail();
        await expect(page.getByRole("alert")).toHaveText("对话模型请求在 600 秒内未完成，已超时；本轮对话未完成，不会自动重新提交。");
        await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
        await expect(generated(page)).toHaveCount(1);
        const savedMessages = JSON.stringify((await session(page)).messages);
        expect(savedMessages).not.toContain("正在等待模型完成");
        expect(savedMessages).toContain("对话模型请求在 600 秒内未完成");
        expect(plans).toHaveLength(2);
        expect(stream.requests).toBe(1);
        expect(api.submissions).toHaveLength(1);
    } finally { await stream.close(); }
});

for (const scenario of [
    { id: "uncertain", status: 502, code: "UPSTREAM_REQUEST_FAILED", message: "对话服务未完成此请求；请求可能已发出，结果待核查，不会自动重新提交。请联系管理员核查上游记录后，再决定是否重新发送。" },
    { id: "not-sent", status: 502, code: "UPSTREAM_REQUEST_FAILED", message: "连接对话模型服务失败，模型业务请求尚未发送。请联系管理员检查服务端网络、代理或运行环境后再试。" },
    { id: "timeout", status: 504, code: "CHAT_REQUEST_TIMEOUT", message: "对话模型请求在 600 秒内未完成，已超时；本轮对话未完成，不会自动重新提交。" },
]) {
    test(`聊天错误 ${scenario.id} 保留原始安全提示、复制和窄屏全文，不自动重发`, async ({ page, context, api }, info) => {
        let chatRequests = 0;
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(info.project.use.baseURL!).origin });
        await page.route("**/api/models", route => route.fulfill({ json: {
            models: [{ id: "error-chat", modelId: "gpt-6-astra", name: "隔离错误显示模型", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }],
            prices: [], tools: [{ toolKey: "gpt-chat", enabled: true, modelConfigId: "error-chat", configurationVersion: 1 }],
        } }));
        await page.route("**/api/chat/responses", route => {
            chatRequests++;
            return route.fulfill({ status: scenario.status, json: { error: scenario.code, message: scenario.message } });
        });
        await page.goto("/chat");
        await send(page, "请继续解释当前设计，不生成图片。");
        const card = page.locator('[data-message-role="error"]'), alert = card.getByRole("alert");
        await expect(alert).toHaveText(scenario.message);
        await expect(card.getByRole("button", { name: "重新生成", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
        expect(chatRequests).toBe(1);
        expect(api.submissions).toHaveLength(0);
        await card.getByRole("button", { name: "复制诊断信息", exact: true }).click();
        const composer = page.getByRole("textbox", { name: "对话内容", exact: true });
        await composer.focus();
        await composer.press("Control+V");
        await expect(composer).toHaveValue(scenario.message);
        await composer.fill("");
        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            const close = page.locator("aside").getByRole("button", { name: "收起会话", exact: true });
            if (await close.isVisible()) await close.click();
            await card.scrollIntoViewIfNeeded();
            await expect(alert).toBeInViewport();
            await expect(alert).toHaveCSS("-webkit-line-clamp", "none");
            expect(await alert.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.screenshot({ path: info.outputPath(`chat-error-${scenario.id}-${width}.png`), animations: "disabled" });
        }
        await page.reload();
        await expect(alert).toHaveText(scenario.message);
        expect(chatRequests).toBe(1);
        expect(api.submissions).toHaveLength(0);
        await info.attach("chat-error-proof.json", { contentType: "application/json", body: Buffer.from(JSON.stringify({ scenario: scenario.id, display: scenario.message, exactClipboardPaste: true, narrowWidths: [390, 320], stubbedChatRequests: chatRequests, imageTaskRequests: api.submissions.length, actualModelCalls: 0, reloadDidNotResubmit: true })) });
    });
}
