import type { Locator } from "@playwright/test";
import { test, expect, IMAGE, ORIGIN } from "./fixtures";

async function pasteFiles(composer: Locator, names: string[], bytes = [...IMAGE]) {
    // Browser integration for multi-file clipboard payloads (native clipboard APIs
    // expose only one PNG on Chromium). No application stores are injected.
    await composer.evaluate((element, input) => {
        const clipboardData = new DataTransfer();
        for (const name of input.names) clipboardData.items.add(new File([new Uint8Array(input.bytes)], name, { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, { names, bytes });
}

test("独立对话支持真实 Ctrl+V 图片，并保留普通文字粘贴", async ({ page, context, api }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    await page.goto("/chat");
    const composer = page.getByRole("textbox", { name: "对话内容", exact: true });
    await expect(composer).toBeEnabled();
    await composer.fill("保留我的改图说明");
    const clipboardBytes = await page.evaluate(async bytes => {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) })]);
        const [item] = await navigator.clipboard.read();
        return Array.from(new Uint8Array(await (await item.getType("image/png")).arrayBuffer()));
    }, [...IMAGE]);
    await composer.focus();
    await page.keyboard.press("Control+V");
    const remove = page.getByRole("button", { name: /^移除 / });
    await expect(remove).toHaveCount(1);
    await expect(composer).toHaveValue("保留我的改图说明");
    const attachment = remove.locator("..").locator("img");
    await expect(attachment).toBeVisible();
    const savedBytes = await attachment.evaluate(async image => Array.from(new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())));
    expect(savedBytes).toEqual(clipboardBytes);
    await page.evaluate(() => navigator.clipboard.writeText("，把颜色改成蓝色"));
    await composer.focus();
    await composer.press("End");
    await page.keyboard.press("Control+V");
    await expect(composer).toHaveValue("保留我的改图说明，把颜色改成蓝色");
    await expect(remove).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("chat-image-paste.png") });
    await remove.click();
    await expect(remove).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});

test("粘贴图片遵守附件上限，发送携图且刷新后原图可恢复", async ({ page, api }, testInfo) => {
    const requests: unknown[] = [];
    await page.route("**/api/models", route => route.fulfill({ json: {
        models: [{ id: "chat-paste-model", modelId: "chat-paste-model", name: "隔离对话模型", protocol: "openai", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }],
        prices: [], tools: [{ toolKey: "gpt-chat", enabled: true, modelConfigId: "chat-paste-model", configurationVersion: 1 }],
    } }));
    await page.route("**/api/chat/responses", route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { content: "已收到测试图片，可继续调整。", toolCalls: [] } });
    });
    await page.goto("/chat");
    const composer = page.getByRole("textbox", { name: "对话内容", exact: true });
    await expect(composer).toBeEnabled();
    await pasteFiles(composer, ["原图1.png", "原图2.png", "原图3.png", "原图4.png", "原图5.png", "超出的图片.png"]);
    await expect(page.getByRole("button", { name: /^移除 / })).toHaveCount(5);
    await expect(page.getByText("每次最多添加 5 个附件，超出的图片或文件未添加", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "移除 超出的图片.png", exact: true })).toHaveCount(0);
    await composer.fill("请查看这五张测试图片");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("已收到测试图片，可继续调整。", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("data:image/jpeg;base64,");
    const images = page.locator('[data-message-role="user"] img');
    await expect(images).toHaveCount(5);
    await page.reload();
    await expect(images).toHaveCount(5);
    for (const image of await images.all()) {
        await expect(image).toBeVisible();
        const savedBytes = await image.evaluate(async element => Array.from(new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())));
        expect(savedBytes).toEqual([...IMAGE]);
    }
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    await pasteFiles(page.getByRole("textbox", { name: "编辑消息", exact: true }), ["不能替换历史附件.png"]);
    await expect(page.getByText("编辑历史消息时保留原附件，请取消编辑后再粘贴新图片", { exact: true })).toBeVisible();
    await expect(images).toHaveCount(5);
    await page.screenshot({ path: testInfo.outputPath("chat-pasted-images-restored.png") });
    expect(api.submissions).toHaveLength(0);
    expect(requests).toHaveLength(1);
});
