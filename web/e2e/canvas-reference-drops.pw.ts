import type { Locator, BrowserContext, Page } from "@playwright/test";
import { toolDefinitions } from "../../shared/feature-catalog";
import { test, expect, IMAGE, newCanvas } from "./fixtures";

async function drop(target: Locator, name: string, textType?: string) {
    return target.evaluate((element, input) => {
        const data = new DataTransfer();
        if (input.textType) data.setData(input.textType, input.name);
        else {
            data.items.add(new File([Uint8Array.from(input.bytes)], input.name, { type: "" }));
            Object.defineProperty(data, "files", { value: new DataTransfer().files });
        }
        element.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
        const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, { name, textType, bytes: [...IMAGE] });
}

async function prepareAssistant(context: BrowserContext) {
    await context.route("**/api/models", route => route.fulfill({ json: {
        models: [
            { id: "fixture-chat", modelId: "gpt-fixture-chat", name: "隔离对话模型", protocol: "openai", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
            { id: "fixture-image", modelId: "gpt-image-2", name: "隔离图片模型", protocol: "openai", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
        ], prices: [], tools: toolDefinitions.map(item => ({ ...item, enabled: true, modelConfigId: ["gpt-chat", "canvas-chat"].includes(item.toolKey) ? "fixture-chat" : "fixture-image", configurationVersion: 1 })),
    } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
}

async function originalBytes(image: Locator) {
    return Buffer.from(await image.evaluate(async element => [...new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())]));
}

async function heldImage(page: Page, url: string) {
    let started = false, release!: () => void;
    const resumed = new Promise<void>(resolve => { release = resolve; });
    await page.context().route(url, async route => { started = true; await resumed; await route.fulfill({ contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: IMAGE }).catch(() => undefined); });
    return { started: () => started, release };
}

test("creation reference drops preserve original bytes without creating nodes or submitting", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    expect(await drop(panel.getByRole("button", { name: "添加参考图", exact: true }), "创建企业微信原图")).toBe(true);
    const first = panel.getByRole("img", { name: "创建企业微信原图", exact: true });
    await expect(first).toBeVisible();
    expect(await originalBytes(first)).toEqual(IMAGE);
    expect(await drop(first, "创建桌面第二张.png")).toBe(true);
    await expect(panel.getByRole("img")).toHaveCount(2);
    expect(await drop(panel, "普通文字", "text/plain")).toBe(false);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(0);
    expect(await originalBytes(panel.getByRole("img", { name: "创建桌面第二张.png", exact: true }))).toEqual(IMAGE);
    expect(api.submissions).toHaveLength(0);
});

test("desktop assistant reference drops stay attachments and retain originals without sending", async ({ page, context, api }) => {
    await prepareAssistant(context);
    const id = await newCanvas(page);
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    const panel = page.getByTestId("canvas-agent-attachment-drop");
    await expect(panel.getByRole("button", { name: "添加参考图", exact: true })).toBeEnabled();
    expect(await drop(panel.locator("textarea"), "助手企业微信原图")).toBe(true);
    const first = panel.getByRole("img", { name: "助手企业微信原图", exact: true });
    await expect(first).toBeVisible();
    expect(await originalBytes(first)).toEqual(IMAGE);
    expect(await drop(first, `<img src="data:image/png;base64,${IMAGE.toString("base64")}">`, "text/html")).toBe(true);
    await expect(panel.getByRole("img")).toHaveCount(2);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(0);
    expect(api.assetBytes.size).toBe(0);
    expect(api.submissions).toHaveLength(0);
});

test("configuration reference drops update only the selected node and never duplicate canvas images", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "生成配置", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id;
    const references = page.locator(`[data-node-id="${nodeId}"]`).locator('section[aria-label="参考图"]');
    await expect(references).toBeVisible();
    expect(await drop(references.getByRole("button", { name: "添加参考图", exact: true }), "配置企业微信原图")).toBe(true);
    await expect.poll(() => api.document(id)?.nodes[0].metadata.manualImageReferences?.length).toBe(1);
    expect(await drop(references.getByRole("img"), "配置第二张.png")).toBe(true);
    await expect.poll(() => api.document(id)?.nodes[0].metadata.manualImageReferences?.length).toBe(2);
    expect(api.document(id)!.nodes).toHaveLength(1);
    expect([...api.assetBytes.values()]).toEqual([IMAGE, IMAGE]);
    await expect(page.getByTestId("canvas-drop-overlay")).toBeHidden();
    expect(api.submissions).toHaveLength(0);
});

for (const target of ["creation", "assistant"] as const) test(`late ${target} reference extraction cannot enter another project`, async ({ page, context, api }) => {
    if (target === "assistant") await prepareAssistant(context);
    const url = `https://drop.example.test/late-${target}.png`;
    const request = await heldImage(page, url);
    const oldId = await newCanvas(page);
    await expect.poll(() => api.document(oldId)?.nodes.length).toBe(0);
    const open = async () => {
        if (target === "creation") {
            const button = page.getByRole("button", { name: "展开创建面板", exact: true });
            if (await button.isVisible()) await button.click();
            return page.getByTestId("canvas-quick-generate-panel");
        }
        await page.getByRole("tab", { name: "对话", exact: true }).click();
        const panel = page.getByTestId("canvas-agent-attachment-drop");
        await expect(panel.getByRole("button", { name: "添加参考图", exact: true })).toBeEnabled();
        return panel;
    };
    expect(await drop(await open(), url, "text/uri-list")).toBe(true);
    await expect.poll(request.started).toBe(true);
    const nextId = await newCanvas(page);
    request.release();
    const next = await open();
    expect(await drop(next, "新项目原图.png")).toBe(true);
    await expect(next.getByRole("img", { name: "新项目原图.png", exact: true })).toBeVisible();
    await expect(next.getByRole("img")).toHaveCount(1);
    expect(api.document(oldId)!.nodes).toHaveLength(0);
    await expect.poll(() => api.document(nextId)?.nodes.length).toBe(0);
    expect(api.submissions).toHaveLength(0);
});
