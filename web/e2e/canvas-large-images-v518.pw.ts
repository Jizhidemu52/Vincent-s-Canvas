import { createHash } from "node:crypto";
import { test, expect, newCanvas } from "./fixtures";

test("大图导入提示、轻量显示和云端原图字节保持一致", async ({ page, api }, info) => {
    const id = await newCanvas(page);
    // A generated test fixture, not a transformed user image. Padding exercises
    // the byte threshold while 4096² real pixels exercise thumbnail decoding.
    const png = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 4096;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "rgb(34, 120, 198)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    const original = Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024 - png.length)]);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "large-preserved.png", mimeType: "image/png", buffer: original });
    await expect(page.getByText(/大图优先使用轻量预览；原图保留/)).toBeVisible();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const node = api.document(id)!.nodes[0];
    expect(node.metadata.naturalWidth).toBe(4096);
    expect(node.metadata.naturalHeight).toBe(4096);
    expect(node.metadata.bytes).toBe(original.length);
    await expect.poll(() => [...api.assetBytes.values()].some(bytes => hash(bytes) === hash(original))).toBe(true);
    const image = page.locator(`[data-node-id="${node.id}"] img[data-canvas-image-resolution]`);
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.naturalWidth <= 1024)).toBe(true);
    const rendered = await image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight, resolution: element.dataset.canvasImageResolution }));
    await info.attach("original-preservation", { body: JSON.stringify({ bytes: original.length, sha256: hash(original), source: [4096, 4096], rendered }), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("large-image-lightweight-preview.png") });
    expect(api.submissions).toHaveLength(0);
});
