import { test, expect, IMAGE } from "./fixtures";
import type { Locator, Page, Route } from "@playwright/test";
import { toolDefinitions } from "../../shared/feature-catalog";

async function dropFiles(target: Locator, name: string, options: { itemsOnly?: boolean; type?: string; count?: number } = {}) {
    return target.evaluate((element, input) => {
        const data = new DataTransfer();
        for (let index = 0; index < input.count; index += 1) data.items.add(new File([Uint8Array.from(input.bytes)], input.count > 1 ? `${index}-${input.name}` : input.name, { type: input.type }));
        if (input.itemsOnly) Object.defineProperty(data, "files", { value: new DataTransfer().files });
        element.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
        const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, { bytes: [...IMAGE], name, type: options.type ?? "image/png", itemsOnly: options.itemsOnly ?? false, count: options.count ?? 1 });
}

async function dropText(target: Locator, value: string, type = "text/uri-list") {
    return target.evaluate((element, input) => {
        const data = new DataTransfer();
        data.setData(input.type, input.value);
        const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, { type, value });
}

async function readyImage(page: Page) {
    await page.goto("/image");
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toBeVisible();
    await expect(page.getByText("正在恢复草稿…", { exact: true })).toHaveCount(0);
    return page.locator(".generation-form");
}

async function originalBytes(image: Locator) {
    return Buffer.from(await image.evaluate(async element => {
        const response = await fetch((element as HTMLImageElement).src);
        return [...new Uint8Array(await response.arrayBuffer())];
    }));
}

async function heldImage(page: Page, path: string) {
    let held!: Route;
    let release!: () => void;
    const resumed = new Promise<void>(resolve => { release = resolve; });
    await page.context().route(path, async route => {
        held = route;
        await resumed;
        await route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: IMAGE }).catch(() => undefined);
    });
    return { started: () => Boolean(held), release };
}

test("chat main content accepts desktop image drops without sending a request", async ({ page, api }) => {
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    const content = page.getByRole("heading", { name: "对话改图", exact: true }).locator("xpath=ancestor::section[1]");
    expect(await dropFiles(content, "桌面原图.png")).toBe(true);
    await expect(page.getByRole("button", { name: "移除 桌面原图.png", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

test("image form reads items-only WeCom files with empty MIME and preserves original upload bytes", async ({ page, api }) => {
    const form = await readyImage(page);
    expect(await dropFiles(form, "企业微信原图", { itemsOnly: true, type: "" })).toBe(true);
    await expect(page.getByRole("img", { name: "企业微信原图", exact: true })).toBeVisible();
    expect(await originalBytes(page.getByRole("img", { name: "企业微信原图", exact: true }))).toEqual(IMAGE);
    expect(api.submissions).toHaveLength(0);
});

test("ordinary text and internal reference sorting are not captured as external uploads", async ({ page, api }) => {
    const form = await readyImage(page);
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("保留我的提示词");
    expect(await dropText(form, "只是普通文字，不是图片", "text/plain")).toBe(false);
    expect(await form.evaluate((element, bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([Uint8Array.from(bytes)], "内部排序.png", { type: "image/png" }));
        data.setData("application/x-inchoice-reference-sort", "reference-id");
        const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, [...IMAGE])).toBe(false);
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toHaveValue("保留我的提示词");
    await expect(page.getByRole("img", { name: "内部排序.png", exact: true })).toHaveCount(0);
    expect(api.assetBytes.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

test("video form accepts empty-MIME desktop files and retains its existing count limit", async ({ page, api }) => {
    await page.context().route("**/api/models", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [
        { id: "image-model", name: "隔离图像模型", modelId: "gpt-image-2", capabilities: ["generate", "edit"], protocol: "openai", providerName: "隔离测试" },
        { id: "video-model", name: "隔离视频模型", modelId: "MiniMax-H3", capabilities: ["video"], protocol: "apimart", providerName: "隔离测试" },
    ], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: tool.toolKey.includes("video") ? "video-model" : "image-model", configurationVersion: 1 })) }) }));
    await page.goto("/video");
    await expect(page.getByRole("textbox", { name: "视频提示词", exact: true })).toBeVisible();
    await expect(page.getByText("正在恢复草稿…", { exact: true })).toHaveCount(0);
    expect(await dropFiles(page.locator(".generation-form"), "视频首帧原图", { type: "" })).toBe(true);
    await expect(page.getByRole("img", { name: "视频首帧原图", exact: true })).toBeVisible();
    expect(await dropFiles(page.locator(".generation-form"), "超过参考图限制.png", { count: 20 })).toBe(true);
    await expect(page.getByRole("alert")).toContainText("最多使用");
    await expect(page.getByRole("img", { name: "视频首帧原图", exact: true })).toHaveCount(1);
    expect(await originalBytes(page.getByRole("img", { name: "视频首帧原图", exact: true }))).toEqual(IMAGE);
    expect(api.submissions).toHaveLength(0);
});

test("creative drop slots preserve primary versus pattern roles and reject ambiguous multi-file drops", async ({ page, api }) => {
    await page.goto("/creative/accessory-design");
    const primaryInput = page.getByLabel("上传辅料图", { exact: true });
    const patternInput = page.getByLabel("上传图案图", { exact: true });
    await expect(primaryInput).toBeEnabled();
    expect(await dropFiles(primaryInput.locator(".."), "辅料结构图", { itemsOnly: true, type: "" })).toBe(true);
    await expect(page.getByRole("img", { name: "辅料结构图", exact: true })).toBeVisible();
    await expect(patternInput).toBeEnabled();
    const data = `data:image/png;base64,${IMAGE.toString("base64")}`;
    expect(await dropText(patternInput.locator(".."), `<img src="${data}">`, "text/html")).toBe(true);
    await expect(patternInput.locator("..").getByRole("img")).toBeVisible();
    expect(await dropFiles(primaryInput.locator(".."), "不应猜角色.png", { count: 2 })).toBe(true);
    await expect(page.getByText("每个参考图位置一次只能拖入一张图片，请分别放入对应位置。", { exact: true })).toBeVisible();
    await expect(primaryInput.locator("..").getByRole("img")).toHaveAttribute("alt", "辅料结构图");
    expect(api.submissions).toHaveLength(0);
});

test("recipe drop respects the disabled pattern slot until a primary reference exists", async ({ page, api }) => {
    await page.goto("/creative/series-recipe");
    await expect(page.getByLabel("选择流程", { exact: true })).toBeEnabled();
    await page.getByLabel("选择流程", { exact: true }).selectOption("pattern");
    const primary = page.getByLabel("上传参考底图（必需）", { exact: true });
    const pattern = page.getByLabel("上传图案参考（可选）", { exact: true });
    await expect(pattern).toBeDisabled();
    expect(await dropFiles(pattern.locator(".."), "禁用图案原图.png")).toBe(true);
    await expect(page.getByText("当前暂不能添加图片，请完成正在进行的操作后再拖入。", { exact: true })).toBeVisible();
    await expect(pattern.locator("..").getByRole("img")).toHaveCount(0);
    expect(await dropFiles(primary.locator(".."), "配方底图", { itemsOnly: true, type: "" })).toBe(true);
    await expect(primary.locator("..").getByRole("img")).toBeVisible();
    await expect(pattern).toBeEnabled();
    expect(await dropFiles(pattern.locator(".."), "配方图案", { type: "" })).toBe(true);
    await expect(pattern.locator("..").getByRole("img")).toBeVisible();
    await expect(page.getByTitle("配方底图", { exact: true })).toBeVisible();
    await expect(page.getByTitle("配方图案", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

test("unreadable external image drops show actionable failure without retrying or generating", async ({ page, api }) => {
    let reads = 0;
    await page.context().route("https://drop.example.test/private.png", route => { reads += 1; return route.fulfill({ status: 403, headers: { "access-control-allow-origin": "*" }, body: "denied" }); });
    const form = await readyImage(page);
    expect(await dropText(form, "https://drop.example.test/private.png")).toBe(true);
    await expect(page.getByText(/没有读到可用的图片文件/)).toBeVisible();
    expect(reads).toBe(1);
    expect(api.assetBytes.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

test("a late external image cannot enter a newly selected chat session", async ({ page, api }) => {
    const request = await heldImage(page, "https://drop.example.test/late-chat.png");
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    const content = page.getByRole("heading", { name: "对话改图", exact: true }).locator("xpath=ancestor::section[1]");
    expect(await dropText(content, "https://drop.example.test/late-chat.png")).toBe(true);
    await expect.poll(request.started).toBe(true);
    await expect(page.getByText("正在读取附件，请稍候…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    request.release();
    await expect(page.getByText("正在读取附件，请稍候…", { exact: true })).toHaveCount(0);
    expect(await dropFiles(content, "新会话原图.png")).toBe(true);
    await expect(page.getByRole("button", { name: "移除 新会话原图.png", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "移除 拖入图片.png", exact: true })).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});

test("leaving an image tool aborts late extraction and does not write the destination tool draft", async ({ page, api }) => {
    const request = await heldImage(page, "https://drop.example.test/late-tool.png");
    const form = await readyImage(page);
    expect(await dropText(form, "https://drop.example.test/late-tool.png")).toBe(true);
    await expect.poll(request.started).toBe(true);
    await page.getByRole("link", { name: "对话改图", exact: true }).first().click();
    await expect(page).toHaveURL(/\/chat$/);
    request.release();
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "移除 拖入图片.png", exact: true })).toHaveCount(0);
    expect(api.assetBytes.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

test("seamless source accepts one original image and rejects ambiguous multi-file drops without generating", async ({ page, api }) => {
    await page.goto("/image?tool=seamless-stitch");
    const panel = page.getByRole("heading", { name: "无缝拼接", exact: true }).locator("xpath=ancestor::section[1]");
    await expect(panel).toBeVisible();
    expect(await dropFiles(panel, "拼接原图", { itemsOnly: true, type: "" })).toBe(true);
    const original = panel.getByRole("img", { name: "拼接原图", exact: true });
    await expect(original).toBeVisible();
    expect(await originalBytes(original)).toEqual(IMAGE);
    expect(await dropFiles(panel, "不能猜底图.png", { count: 2 })).toBe(true);
    await expect(page.getByText("每个参考图位置一次只能拖入一张图片，请分别放入对应位置。", { exact: true })).toBeVisible();
    await expect(original).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

test("asset library imports dropped originals in a batch without generation or publication", async ({ page, api }) => {
    await page.goto("/assets");
    const panel = page.getByRole("heading", { name: "素材库", exact: true }).locator("xpath=ancestor::main[1]");
    await expect(panel).toBeVisible();
    expect(await dropFiles(panel, "素材原图", { itemsOnly: true, type: "", count: 2 })).toBe(true);
    await expect(page.getByText("已上传 2 张图片", { exact: true })).toBeVisible();
    expect([...api.assetBytes.values()]).toEqual([IMAGE, IMAGE]);
    expect([...api.assets.values()].map(asset => asset.metadata?.source)).toEqual(["manual-upload", "manual-upload"]);
    expect(api.submissions).toHaveLength(0);
});

test("library drops remain unpublished private drafts with count limits and exact original bytes", async ({ page, api }) => {
    let publications = 0;
    await page.context().route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: true } }));
    await page.context().route("**/api/design-library?**", route => route.fulfill({ json: { code: 0, data: { items: [], total: 0, page: 1, pageSize: 24 } } }));
    await page.context().route("**/api/design-library", route => { publications++; return route.fulfill({ status: 403, json: { code: "FORBIDDEN_IN_TEST" } }); });
    await page.goto("/design-library?publish=1");
    const dialog = page.getByRole("dialog", { name: "发布到公司设计灵感库", exact: true });
    const slot = dialog.getByRole("region", { name: "分享图片", exact: true });
    await expect(slot).toBeVisible();
    expect(await dropFiles(slot, "未公开原图", { itemsOnly: true, type: "" })).toBe(true);
    const original = slot.getByRole("img", { name: "未公开原图", exact: true });
    await expect(original).toBeVisible();
    expect(await originalBytes(original)).toEqual(IMAGE);
    await expect(dialog.getByRole("button", { name: "确认公开并发布", exact: true })).toBeDisabled();
    expect(await dropFiles(slot, "超过分享限制.png", { count: 12 })).toBe(true);
    await expect(page.getByText("每次最多分享 12 张图片", { exact: true })).toBeVisible();
    await expect(slot.locator("img")).toHaveCount(1);
    expect(api.assetBytes.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
    expect(publications).toBe(0);
});
