import { test, expect, type Page, type Download } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const origin = "http://127.0.0.1:5347";
const owner = "81000000-0000-4000-8000-000000000001";

async function inspect(page: Page, bytes: Uint8Array, mime: string) {
    return page.evaluate(async ({ encoded, type }) => {
        const blob = await (await fetch(`data:${type};base64,${encoded}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
        const result = { width: bitmap.width, height: bitmap.height, transparent: Array.from(context.getImageData(bitmap.width - 2, bitmap.height - 2, 1, 1).data), painted: Array.from(context.getImageData(4, 4, 1, 1).data) };
        bitmap.close(); return result;
    }, { encoded: Buffer.from(bytes).toString("base64"), type: mime });
}

async function fileBytes(download: Download, path: string) {
    await download.saveAs(path);
    return readFile(path);
}

test("真实单图与所选图片导出 PNG/JPG：透明/白底、像素尺寸和画布原稿保持正确", async ({ page, context }, testInfo) => {
    const errors: string[] = [], outside: string[] = [], generation: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (/^https?:$/.test(url.protocol)) {
            if (url.origin !== origin) { outside.push(url.href); return route.abort(); }
            if (route.request().method() === "POST" && ["/api/tasks", "/api/chat/responses"].includes(url.pathname)) { generation.push(url.pathname); return route.abort(); }
        }
        return route.continue();
    });
    await context.addCookies([{ name: "workspace-fixture", value: "fixture-admin", url: origin, httpOnly: true, sameSite: "Lax" }]);
    await page.goto("/canvas");
    await page.getByRole("button", { name: "新建画布", exact: true }).first().click();
    await expect(page).toHaveURL(/\/canvas\/[^/]+$/);
    const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByRole("button", { name: "收起创建面板", exact: true }).click();
    const fixtureBytes = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48;
        const context = canvas.getContext("2d")!; context.fillStyle = "#ff0000"; context.fillRect(0, 0, 16, 16);
        return canvas.toDataURL("image/png").split(",")[1];
    });
    const upload = async (name: string) => {
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "上传素材", exact: true }).click();
        await (await chooser).setFiles({ name, mimeType: "image/png", buffer: Buffer.from(fixtureBytes, "base64") });
    };
    await upload("另一个样本.png"); await expect(page.locator("[data-node-id]")).toHaveCount(1);
    await upload("透明样本.png"); await expect(page.locator("[data-node-id]")).toHaveCount(2);
    const readDocument = async () => (await (await context.request.get(`/api/canvas-documents/${projectId}`, { headers: { "X-Canvas-Owner-Id": owner } })).json()).document.document;
    await expect.poll(async () => (await readDocument())?.nodes.length).toBe(2);
    const before = await readDocument();
    const first = before.nodes.find((node: { title: string }) => node.title === "透明样本.png");
    const node = page.locator(`[data-node-id="${first.id}"]`);
    await node.click({ position: { x: 30, y: 12 } }); await node.hover();
    const downloadButton = page.getByRole("button", { name: "下载图片", exact: true });
    if (await downloadButton.isVisible()) await downloadButton.click();
    else { await page.getByRole("button", { name: "更多图片工具", exact: true }).click(); await page.getByRole("menuitem", { name: "下载", exact: true }).click(); }
    const dialog = page.getByRole("dialog", { name: "下载图片", exact: true });
    await expect(dialog).toBeVisible();
    for (const format of ["PNG", "JPG"] as const) {
        await dialog.getByRole("radio", { name: format === "PNG" ? "PNG（保留透明）" : "JPG（白底）", exact: true }).check();
        const received = page.waitForEvent("download");
        await dialog.getByRole("button", { name: `下载 ${format} 图片`, exact: true }).click();
        const download = await received;
        expect(download.suggestedFilename()).toBe(`透明样本_v1.${format.toLowerCase()}`);
        const bytes = await fileBytes(download, testInfo.outputPath(download.suggestedFilename()));
        expect([...bytes.subarray(0, 2)]).toEqual(format === "PNG" ? [0x89, 0x50] : [0xff, 0xd8]);
        const decoded = await inspect(page, bytes, format === "PNG" ? "image/png" : "image/jpeg");
        expect([decoded.width, decoded.height]).toEqual([64, 48]);
        expect(decoded.transparent).toEqual(format === "PNG" ? [0, 0, 0, 0] : [255, 255, 255, 255]);
        expect(decoded.painted[0]).toBeGreaterThan(245); expect(decoded.painted[1]).toBeLessThan(10); expect(decoded.painted[3]).toBe(255);
        if (format === "PNG") expect(bytes).toEqual(Buffer.from(fixtureBytes, "base64"));
    }
    await dialog.screenshot({ path: testInfo.outputPath("single-format-picker.png") });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const openSet = async () => {
        await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
        await page.getByRole("menuitem", { name: "导出图片集 / PDF", exact: true }).click();
        return page.getByRole("dialog", { name: "导出图片集", exact: true });
    };
    for (const format of ["PNG", "JPG"] as const) {
        const batch = await openSet();
        await batch.getByRole("button", { name: "仅画布已选", exact: true }).click();
        await expect(batch.getByRole("checkbox", { checked: true })).toHaveCount(1);
        await batch.getByRole("radio", { name: `${format} 图片（ZIP）`, exact: true }).check();
        await batch.getByRole("textbox", { name: "图片集名称", exact: true }).fill(`所选${format}`);
        await batch.screenshot({ path: testInfo.outputPath(`batch-${format}.png`) });
        const received = page.waitForEvent("download");
        await batch.getByRole("button", { name: "导出并下载", exact: true }).click();
        const download = await received;
        const bytes = await fileBytes(download, testInfo.outputPath(download.suggestedFilename()));
        const files = unzipSync(bytes);
        expect(Object.keys(files)).toEqual([`001_透明样本_v1.${format.toLowerCase()}`]);
        const image = Object.values(files)[0];
        expect([...image.slice(0, 2)]).toEqual(format === "PNG" ? [0x89, 0x50] : [0xff, 0xd8]);
        const decoded = await inspect(page, image, format === "PNG" ? "image/png" : "image/jpeg");
        expect([decoded.width, decoded.height]).toEqual([64, 48]);
        expect(decoded.transparent).toEqual(format === "PNG" ? [0, 0, 0, 0] : [255, 255, 255, 255]);
        await expect(batch).toBeHidden();
    }
    const batch = await openSet(); await batch.getByRole("button", { name: "全选", exact: true }).click();
    await batch.getByRole("radio", { name: "原图（ZIP）", exact: true }).check();
    const received = page.waitForEvent("download"); await batch.getByRole("button", { name: "导出并下载", exact: true }).click();
    const original = await received; const files = unzipSync(await fileBytes(original, testInfo.outputPath("original-images.zip")));
    expect(Object.keys(files)).toHaveLength(2);
    for (const bytes of Object.values(files)) expect(Buffer.from(bytes)).toEqual(Buffer.from(fixtureBytes, "base64"));
    expect((await readDocument()).nodes).toEqual(before.nodes);
    expect((await readDocument()).connections).toEqual(before.connections);
    expect(generation).toEqual([]); expect(outside).toEqual([]); expect(errors).toEqual([]);
});
