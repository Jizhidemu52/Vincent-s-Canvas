import { test, expect, newCanvas, uploadImage, IMAGE } from "./fixtures";
import type { Locator } from "@playwright/test";

async function dropCanvasFiles(target: Locator, names: string[], itemsOnly = false) {
    return target.evaluate((element, input) => {
        const data = new DataTransfer();
        input.names.forEach(name => data.items.add(new File([Uint8Array.from(input.bytes)], name, { type: input.itemsOnly ? "" : "image/png" })));
        if (input.itemsOnly) Object.defineProperty(data, "files", { value: new DataTransfer().files });
        element.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
        const bounds = element.getBoundingClientRect();
        const event = new DragEvent("drop", { dataTransfer: data, clientX: bounds.left + 200, clientY: bounds.top + 200, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, { names, itemsOnly, bytes: [...IMAGE] });
}

async function dropCanvasText(target: Locator, value: string, type = "text/uri-list") {
    return target.evaluate((element, input) => {
        const data = new DataTransfer(); data.setData(input.type, input.value);
        element.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
        const bounds = element.getBoundingClientRect();
        const event = new DragEvent("drop", { dataTransfer: data, clientX: bounds.left + 200, clientY: bounds.top + 200, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, { type, value });
}

test("desktop: collapsed remembered panel, grid import, pan/zoom shortcuts and reversible deletion", async ({ page, api }, info) => {
    const id = await newCanvas(page);
    await expect(page.getByTestId("canvas-empty-start")).toBeVisible();
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeHidden();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeHidden();
    await expect(page.getByRole("button", { name: "跟我走一遍", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeVisible();
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    const input = await chooser;
    expect(input.isMultiple()).toBe(true);
    await input.setFiles([{ name: "原图一.png", mimeType: "image/png", buffer: IMAGE }, { name: "原图二.png", mimeType: "image/png", buffer: IMAGE }]);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    const imported = api.document(id)!.nodes;
    expect(imported[1].position.x - imported[0].position.x).toBe(688);
    expect(imported[0].width / imported[0].height).toBe(1);
    expect([...api.assetBytes.values()].every(bytes => bytes.equals(IMAGE))).toBe(true);
    await expect(page.getByTestId("canvas-quick-generate-panel")).toBeHidden();
    const canvas = page.locator("[data-canvas-viewport]");
    await page.mouse.move(1200, 400); await page.mouse.wheel(100, 80);
    await expect.poll(() => api.document(id)?.viewport.k).toBe(1);
    await page.keyboard.press("Control++");
    await expect.poll(() => api.document(id)?.viewport.k).toBeGreaterThan(1);
    await page.keyboard.press("Control+0");
    await expect.poll(() => api.document(id)?.viewport.k).toBe(1);
    await page.keyboard.press("Shift+1");
    await expect(page.locator(`[data-node-id="${imported[0].id}"]`)).toBeVisible();
    await expect(page.locator(`[data-node-id="${imported[1].id}"]`)).toBeVisible();
    await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(0);
    await page.locator(".ant-message").getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    await expect(page.getByText("体验数据", { exact: true })).toBeHidden();
    await canvas.click({ button: "right", position: { x: 1100, y: 120 } });
    for (const name of ["粘贴到此处", "添加文本", "全选节点", "适应全部内容"]) await expect(page.getByRole("menuitem", { name: new RegExp(name) })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: info.outputPath("canvas-desktop.png") });
    expect(api.submissions).toHaveLength(0);
});

test("mobile: single empty-state entry and explicit collapsible creation", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await newCanvas(page);
    await expect(page.getByTestId("canvas-empty-start")).toBeVisible();
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeHidden();
    await page.getByRole("button", { name: "跟我走一遍", exact: true }).click();
    await expect(page.getByTestId("canvas-onboarding-tour")).toBeVisible();
    await expect(page.getByTestId("canvas-empty-start")).toBeHidden();
    await page.getByRole("button", { name: "跳过引导", exact: true }).click();
    await expect(page.getByTestId("canvas-empty-start")).toBeVisible();
    await page.screenshot({ path: info.outputPath("canvas-mobile.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(api.submissions).toHaveLength(0);
});

test("image editing runtime is absent on first paint and crop still creates a separate result", async ({ page, api }) => {
    const loaded: string[] = [];
    page.on("request", request => { if (request.url().includes("canvas-image-actions-runtime")) loaded.push(request.url()); });
    const id = await newCanvas(page);
    await uploadImage(page);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    const node = page.locator(`[data-node-id="${original.id}"]`);
    await node.click({ position: { x: 35, y: 15 } });
    await node.hover();
    const crop = page.getByRole("button", { name: "裁剪并生成新节点", exact: true });
    if (await crop.isVisible()) await crop.click();
    else {
        await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
        await page.getByRole("menuitem", { name: "裁剪", exact: true }).click();
    }
    const dialog = page.getByRole("dialog", { name: "裁剪图片", exact: true });
    await expect(dialog.getByRole("button", { name: "确认裁剪", exact: true })).toBeEnabled();
    expect(loaded).toHaveLength(0);
    await dialog.getByRole("button", { name: "确认裁剪", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(loaded.length).toBeGreaterThan(0);
    expect(api.document(id)!.nodes.find((item: any) => item.id === original.id)).toEqual(original);
    expect(api.submissions).toHaveLength(0);
});

test("canvas empty-state and toolbar drops retain desktop/WeCom original bytes and do not generate", async ({ page, api }) => {
    const id = await newCanvas(page);
    expect(await dropCanvasFiles(page.getByTestId("canvas-empty-start"), ["桌面原图一.png", "桌面原图二.png"])).toBe(true);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(await dropCanvasFiles(page.getByRole("button", { name: "上传素材", exact: true }), ["企业微信原图"], true)).toBe(true);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(3);
    expect(api.document(id)!.nodes.map((node: any) => node.title)).toEqual(["桌面原图一.png", "桌面原图二.png", "企业微信原图"]);
    expect([...api.assetBytes.values()].every(bytes => bytes.equals(IMAGE))).toBe(true);
    await expect(page.getByTestId("canvas-drop-overlay")).toBeHidden();
    expect(api.submissions).toHaveLength(0);
});

test("canvas HTML image drops decode originals; unreadable links fail once and preserve existing nodes", async ({ page, api }) => {
    let reads = 0;
    await page.context().route("https://drop.example.test/canvas-denied.png", route => { reads++; return route.fulfill({ status: 403, headers: { "access-control-allow-origin": "*" }, body: "denied" }); });
    const id = await newCanvas(page), canvas = page.locator("[data-canvas-viewport]");
    expect(await dropCanvasText(canvas, `<img src="data:image/png;base64,${IMAGE.toString("base64")}">`, "text/html")).toBe(true);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    expect([...api.assetBytes.values()].every(bytes => bytes.equals(IMAGE))).toBe(true);
    expect(await dropCanvasText(canvas, "https://drop.example.test/canvas-denied.png")).toBe(true);
    await expect(page.getByText(/没有读到可用的图片文件/)).toBeVisible();
    await expect(page.getByTestId("canvas-drop-overlay")).toBeHidden();
    expect(api.document(id)!.nodes).toEqual([original]); expect(reads).toBe(1);
    expect(api.submissions).toHaveLength(0);
});

test("a delayed external canvas image cannot enter the next project", async ({ page, api }) => {
    let started = false, release!: () => void;
    const resume = new Promise<void>(resolve => { release = resolve; });
    await page.context().route("https://drop.example.test/canvas-late.png", async route => {
        started = true; await resume;
        await route.fulfill({ contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: IMAGE }).catch(() => undefined);
    });
    const oldId = await newCanvas(page);
    expect(await dropCanvasText(page.locator("[data-canvas-viewport]"), "https://drop.example.test/canvas-late.png")).toBe(true);
    await expect.poll(() => started).toBe(true);
    await expect(page.getByTestId("canvas-drop-overlay")).toContainText("正在读取拖入图片");
    const nextId = await newCanvas(page);
    release();
    expect(nextId).not.toBe(oldId);
    await expect(page.getByTestId("canvas-drop-overlay")).toBeHidden();
    expect(await dropCanvasFiles(page.locator("[data-canvas-viewport]"), ["新画布原图.png"])).toBe(true);
    await expect.poll(() => api.document(nextId)?.nodes.length).toBe(1);
    expect(api.document(nextId)!.nodes[0].title).toBe("新画布原图.png");
    expect(api.document(oldId)!.nodes).toHaveLength(0);
    expect(api.submissions).toHaveLength(0);
});
