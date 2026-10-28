import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import type { Locator, Page } from "@playwright/test";
import { test, expect, newCanvas } from "./fixtures";

async function moveNode(page: Page, node: Locator, x: number, y: number) {
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + 15, { steps: 10 });
    await page.mouse.up();
}

async function boxSelect(page: Page, nodes: Locator[]) {
    const boxes = await Promise.all(nodes.map(node => node.boundingBox()));
    const left = Math.min(...boxes.map(box => box!.x)) - 25;
    const top = Math.min(...boxes.map(box => box!.y)) - 35;
    const right = Math.max(...boxes.map(box => box!.x + box!.width)) + 25;
    const bottom = Math.max(...boxes.map(box => box!.y + box!.height)) + 25;
    await page.getByRole("button", { name: "选择 / 框选", exact: true }).click();
    await page.mouse.move(left, top); await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 15 }); await page.mouse.up();
}

test("框选混合节点后从工具栏和右键下载原图 ZIP，排除未选图片且不改原稿", async ({ page, api }, testInfo) => {
    test.setTimeout(120_000);
    const id = await newCanvas(page);
    const collapse = page.getByRole("button", { name: "收起创建面板", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    const fixtures = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
        const context = canvas.getContext("2d")!;
        return ["#c22", "#2a4", "#36c"].map((color, index) => {
            context.clearRect(0, 0, 256, 256); context.fillStyle = color; context.fillRect(0, 0, 192, 192);
            const mime = index === 1 ? "image/jpeg" : "image/png";
            return { mime, base64: canvas.toDataURL(mime).split(",")[1], name: ["选中红色.png", "选中绿色.jpg", "未选蓝色.png"][index] };
        });
    });
    const nodes: Locator[] = [];
    for (const [index, fixture] of fixtures.entries()) {
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "上传素材", exact: true }).click();
        await (await chooser).setFiles({ name: fixture.name, mimeType: fixture.mime, buffer: Buffer.from(fixture.base64, "base64") });
        await expect.poll(() => api.document(id)?.nodes.length).toBe(index + 1);
        const nodeId = api.document(id)!.nodes.find((node: any) => node.title === fixture.name).id;
        const node = page.locator(`[data-node-id="${nodeId}"]`); nodes.push(node);
        await moveNode(page, node, [220, 580, 1320][index], 300);
    }
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(4);
    const textId = api.document(id)!.nodes.find((node: any) => node.type === "text").id;
    const text = page.locator(`[data-node-id="${textId}"]`);
    await moveNode(page, text, 220, 700);
    await boxSelect(page, [nodes[0], nodes[1], text]);
    await expect.poll(() => api.document(id)?.selectedNodeIds.length).toBe(3);
    const before = JSON.parse(JSON.stringify(api.document(id)));
    const downloadButton = page.getByRole("button", { name: "下载所选图片（2 张）", exact: true });
    await expect(downloadButton).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("selected-images-download.png") });
    const downloadAndCheck = async () => {
        const dialog = page.getByRole("dialog", { name: "导出图片集", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("radio", { name: "原图（ZIP）", exact: true })).toBeChecked();
        await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(2);
        await expect(dialog.getByRole("checkbox")).toHaveCount(2);
        const received = page.waitForEvent("download");
        await dialog.getByRole("button", { name: "导出并下载", exact: true }).click();
        const download = await received;
        expect(download.suggestedFilename()).toMatch(/\.zip$/);
        const path = testInfo.outputPath(`batch-${Date.now()}.zip`);
        await download.saveAs(path);
        const files = unzipSync(await readFile(path));
        expect(Object.keys(files)).toEqual(["001_选中红色_v1.png", "002_选中绿色_v1.jpg"]);
        for (const [index, bytes] of Object.values(files).entries()) expect(Buffer.from(bytes)).toEqual(Buffer.from(fixtures[index].base64, "base64"));
        await expect(dialog).toBeHidden();
    };
    await downloadButton.click(); await downloadAndCheck();
    await nodes[0].click({ button: "right", position: { x: 30, y: 15 } });
    await page.getByRole("menuitem", { name: "下载所选图片（2 张）", exact: true }).click();
    await downloadAndCheck();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索命令、节点和素材" }).fill("下载所选图片");
    await page.getByRole("option", { name: "命令 下载所选图片", exact: true }).click();
    await downloadAndCheck();
    expect(api.document(id)!.nodes).toEqual(before.nodes);
    expect(api.document(id)!.connections).toEqual(before.connections);
    expect(api.submissions).toEqual([]);

    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    for (const width of [736, 360]) {
        await page.setViewportSize({ width, height: 700 });
        await expect(downloadButton).toBeVisible();
        const box = (await downloadButton.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: testInfo.outputPath(`selection-dark-${width}.png`) });
    }
    await page.setViewportSize({ width: 1800, height: 1200 });

    // A non-image selection must never offer an action that falls back to every image.
    // Clicking an already-selected node intentionally preserves a multi-selection for group dragging.
    await page.mouse.click(1200, 1000);
    await text.click({ position: { x: 30, y: 15 } });
    await expect.poll(() => api.document(id)?.selectedNodeIds).toEqual([textId]);
    await expect(downloadButton).toBeHidden();
    await text.click({ button: "right", position: { x: 30, y: 15 } });
    await expect(page.getByRole("menuitem", { name: /下载所选图片/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索命令、节点和素材" }).fill("下载所选图片");
    await expect(page.getByRole("option", { name: /下载所选图片/ })).toHaveCount(0);
});
