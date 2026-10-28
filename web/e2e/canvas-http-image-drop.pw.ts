import { test, expect, newCanvas, IMAGE } from "./fixtures";
import { readFile } from "node:fs/promises";

test("HTTP-compatible drag import preserves Chinese filenames, original bytes, editing and reload", async ({ page, context, api }, testInfo) => {
    if (!process.env.CANVAS_REQUIRE_HTTP_ORIGIN) await context.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true }));
    const bytes = process.env.CANVAS_REFERENCE_FILE ? await readFile(process.env.CANVAS_REFERENCE_FILE) : IMAGE;
    const id = await newCanvas(page);
    if (process.env.CANVAS_REQUIRE_HTTP_ORIGIN) expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: "undefined" });
    await page.locator("[data-canvas-viewport]").evaluate((element, input) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(input)], "图片_v2.png", { type: "image/png" }));
        const box = element.getBoundingClientRect();
        element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
    }, [...bytes]);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const image = api.document(id)!.nodes[0];
    expect(image.title).toBe("图片_v2.png");
    expect([...api.assetBytes.values()].some(stored => stored.equals(bytes))).toBe(true);
    const node = page.locator(`[data-node-id="${image.id}"]`);
    await node.click({ position: { x: 35, y: 15 } });
    await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "自定义工具", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(node).toBeVisible();
    await node.click({ position: { x: 35, y: 15 } });
    await expect(page.getByRole("toolbar", { name: "图片工具栏", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("original-image-http-drop.png") });
});
