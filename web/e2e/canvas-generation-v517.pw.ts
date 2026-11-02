import { test, expect } from "@playwright/test";

const html = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-generation-v517.fixture.tsx"></script></body></html>`;

test.beforeEach(async ({ context }) => {
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1" || url.pathname.startsWith("/api/")) return route.abort("blockedbyclient");
        if (url.pathname === "/__generation") return route.fulfill({ contentType: "text/html", body: html });
        return route.continue();
    });
});

test("connection creation filters source types and stays screen sized, keyboard usable and within narrow viewports", async ({ page }, info) => {
    for (const zoom of [.1, 4]) {
        await page.setViewportSize({ width: 720, height: 600 });
        await page.goto(`/__generation?tool=connection&zoom=${zoom}`);
        const menu = page.getByRole("menu", { name: "连接下一步" });
        await expect(menu).toBeVisible();
        const bounds = (await menu.boundingBox())!;
        expect(bounds.width).toBe(300); expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.y).toBeGreaterThanOrEqual(8);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(712); expect(bounds.y + bounds.height).toBeLessThanOrEqual(592);
        await expect(menu.getByRole("menuitem")).toHaveCount(4);
        await expect(menu.getByRole("menuitem", { name: /音频/ })).toHaveCount(0);
        await expect(menu.getByRole("menuitem").first()).toBeFocused();
        await page.keyboard.press("End"); await expect(menu.getByRole("menuitem").last()).toBeFocused();
        await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
        await expect(page.getByTestId("connection-created")).toHaveText("image"); await expect(menu).toHaveCount(0);
        await page.getByRole("button", { name: "重新拉线" }).click(); await expect(menu).toBeVisible();
        await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0);
        await page.getByRole("button", { name: "重新拉线" }).click(); await expect(menu).toBeVisible();
        await page.mouse.click(450, 10); await expect(menu).toHaveCount(0);
    }
    await page.setViewportSize({ width: 280, height: 320 });
    await page.goto("/__generation?tool=connection&source=audio&zoom=.1");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu.getByRole("menuitem", { name: /图片/ })).toHaveCount(0);
    const bounds = (await menu.boundingBox())!;
    expect(bounds.width).toBe(264); expect(bounds.x).toBe(8); expect(bounds.y + bounds.height).toBeLessThanOrEqual(312);
    await page.screenshot({ path: info.outputPath("connection-menu-narrow.png") });
});

test("voice preview only loads on click, stops after three seconds and never substitutes unavailable samples", async ({ page }, info) => {
    const wav = Buffer.alloc(44 + 8000 * 2 * 8);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    const sampleRequests: string[] = [];
    await page.route("https://cdn.openai.com/API/docs/audio/*.wav", route => { sampleRequests.push(route.request().url()); return route.fulfill({ contentType: "audio/wav", body: wav }); });
    await page.goto("/__generation?tool=audio");
    const player = page.getByLabel("音色官方样例");
    await expect(page.getByRole("button", { name: "试听 3 秒 合金 Alloy" })).toBeVisible();
    await expect(player).not.toHaveAttribute("src"); expect(sampleRequests).toHaveLength(0);
    await player.evaluate((element: HTMLAudioElement) => { element.addEventListener("playing", () => { element.dataset.started = String(performance.now()); }); element.addEventListener("emptied", () => { element.dataset.elapsed = String(performance.now() - Number(element.dataset.started)); }); });
    await page.getByRole("button", { name: "试听 3 秒 合金 Alloy" }).click();
    await expect(page.getByText("3 秒后自动停止", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "试听 3 秒 合金 Alloy" })).toBeVisible({ timeout: 6000 });
    expect(await player.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    await expect(player).toHaveAttribute("data-elapsed", /\d+/);
    const elapsed = Number(await player.getAttribute("data-elapsed")); expect(elapsed).toBeGreaterThanOrEqual(2700); expect(elapsed).toBeLessThan(3600);
    expect(sampleRequests).toEqual(["https://cdn.openai.com/API/docs/audio/alloy.wav"]);
    await page.getByRole("button", { name: "试听 3 秒 合金 Alloy" }).click();
    await expect(page.getByText("3 秒后自动停止", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "白蜡Ash", exact: true }).click();
    await expect(player).not.toHaveAttribute("src");
    await page.getByRole("button", { name: "歌谣Ballad", exact: true }).click();
    await expect(page.getByRole("button", { name: "试听 3 秒 歌谣 Ballad" })).toBeDisabled();
    await expect(page.getByText("此音色暂无内置样例", { exact: true })).toBeVisible();
    await expect(page.getByText("试听为 AI 生成的官方英语样例", { exact: false })).toBeVisible();
    await page.setViewportSize({ width: 400, height: 900 });
    await page.screenshot({ path: info.outputPath("voice-preview-narrow.png") });
});

test("generic exclusion stays a separate parameter while the immutable record shows source and submitted prompts", async ({ page }, info) => {
    await page.goto("/__generation?tool=advanced");
    const exclusion = page.getByRole("textbox", { name: "排除内容", exact: true });
    await exclusion.fill("水印、额外文字");
    await expect(page.getByText("此模型没有原生排除参数", { exact: false })).toBeVisible();
    await expect(page.getByLabel("随机种子", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "检查发送参数", exact: true }).click();
    const submitted = JSON.parse((await page.getByTestId("advanced-submitted").textContent())!);
    expect(submitted.negative_prompt).toBe("水印、额外文字"); expect(submitted).not.toHaveProperty("prompt");
    await expect(page.getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText("蓝色衬衫");
    await page.getByText("实际发送提示词（含排除要求）", { exact: true }).click();
    await expect(page.getByRole("button", { name: "复制实际发送提示词", exact: true })).toContainText("排除要求：水印");
    await page.screenshot({ path: info.outputPath("exclusion-settings-and-record.png") });
});

test("overflowing configuration keeps its run button visible and names the one managed text model", async ({ page }, info) => {
    await page.goto("/__generation?tool=config");
    const panel = page.getByTestId("configuration-node");
    const contents = page.getByLabel("生成配置内容", { exact: true });
    const run = panel.getByRole("button", { name: /^(?:开始生成|合并参考生成 1 张)$/ });
    await expect(run).toBeEnabled();
    expect(await contents.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const before = (await run.boundingBox())!;
    const bounds = (await panel.boundingBox())!;
    expect(before.y + before.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    await run.click(); await expect(page.getByTestId("config-generated")).toHaveText("1");
    await contents.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const after = (await run.boundingBox())!;
    expect(Math.abs(before.y - after.y)).toBeLessThan(1);
    await run.click(); await expect(page.getByTestId("config-generated")).toHaveText("2");
    await contents.evaluate(element => { element.scrollTop = 0; });
    await panel.getByText("文本", { exact: true }).click();
    await expect(panel.getByText("团队文案助手", { exact: false })).toBeAttached();
    await contents.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(panel.getByText("团队文案助手", { exact: false })).toBeVisible();
    await expect(panel.getByText("后台统一指定 · 每次生成 1 份", { exact: false })).toBeVisible();
    await expect(panel.locator('[data-usage-control="model"]')).toHaveCount(0);
    await expect(run).toBeEnabled();
    await page.screenshot({ path: info.outputPath("configuration-fixed-footer.png") });
});

test("local image tools retain JPEG, protect alpha, crop exactly one pixel, and orient phone PDF through actual Workers", async ({ page }) => {
    await page.goto("/__generation?tool=viewer");
    const result = await page.evaluate(async () => (await import("/e2e/canvas-image-tools-v517.qa.ts")).runImageToolsQA());
    expect(result).toEqual({ cropSize: [1,1], cropType: "image/jpeg", splitTypes: ["image/jpeg","image/jpeg","image/jpeg","image/jpeg"], upscaleType: "image/jpeg", opaqueEdit: "image/jpeg", transparentEdit: "image/png", rotatedPDF: { width: 30, height: 60 }, pngPDF: { width: 60, height: 30 } });
});

test("precise crop controls submit exact pixels and viewer zoom remains inside its dialog", async ({ page }, info) => {
    await page.goto("/__generation?tool=crop");
    await expect(page.getByLabel("裁剪宽度（像素）")).toBeEnabled();
    await page.getByLabel("裁剪X（像素）").fill("10"); await page.getByLabel("裁剪Y（像素）").fill("20");
    await page.getByLabel("裁剪宽度（像素）").fill("1"); await page.getByLabel("裁剪高度（像素）").fill("2");
    await page.getByLabel("裁剪高度（像素）").press("Enter");
    await expect(page.getByTestId("crop-result")).not.toBeEmpty();
    const result = JSON.parse((await page.getByTestId("crop-result").textContent())!);
    expect(result).toEqual({ x: 10/333, y: 20/517, width: 1/333, height: 2/517 });
    await page.goto("/__generation?tool=viewer");
    const viewer = page.getByLabel("原图查看，可滚轮缩放、拖动和左右键换图");
    await expect(page.getByText("333 × 517px", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await viewer.hover(); await page.mouse.wheel(0, -250);
    await expect(viewer).toHaveAttribute("data-scale", /1\.64/);
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
    await viewer.focus(); await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog")).toHaveAccessibleName("第二张样衣");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.screenshot({ path: info.outputPath("image-viewer-narrow.png") });
});

test("the same original supports two consecutive drag crops without stale selection or changed source pixels", async ({ page }) => {
    await page.goto("/__generation?tool=crop");
    const width = page.getByLabel("裁剪宽度（像素）");
    await expect(width).toBeEnabled();
    const source = await page.getByRole("dialog").locator("img").getAttribute("src");
    const crops: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const distance of [45, 30]) {
        const before = Number(await width.inputValue());
        const resizeHandle = page.getByRole("button", { name: "调整裁剪框右下", exact: true });
        await resizeHandle.hover();
        const handle = (await resizeHandle.boundingBox())!;
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 - distance, handle.y + handle.height / 2 - distance, { steps: 8 }); await page.mouse.up();
        await expect.poll(async () => Number(await width.inputValue())).toBeLessThan(before);
        const expected = { width: Number(await width.inputValue()), height: Number(await page.getByLabel("裁剪高度（像素）").inputValue()) };
        await page.getByRole("button", { name: "确认裁剪", exact: true }).click();
        await expect(width).toBeEnabled();
        const crop = JSON.parse((await page.getByTestId("crop-result").textContent())!);
        expect(Math.round(crop.width * 333)).toBe(expected.width);
        expect(Math.round(crop.height * 517)).toBe(expected.height);
        crops.push(crop);
        expect(await page.getByRole("dialog").locator("img").getAttribute("src")).toBe(source);
    }
    expect(crops[1].width).toBeLessThan(crops[0].width);
    expect(crops[1].height).toBeLessThan(crops[0].height);
    const result = await page.evaluate(async ({ source, crops }) => {
        const { cropImageBlob } = await import("/src/lib/canvas/canvas-image-data.ts");
        const outputs = [];
        for (const crop of crops) {
            const blob = await cropImageBlob(source!, crop, { sourceMimeType: "image/png" });
            const bitmap = await createImageBitmap(blob);
            outputs.push([bitmap.width, bitmap.height]); bitmap.close();
        }
        const original = await createImageBitmap(await (await fetch(source!)).blob());
        const size = [original.width, original.height]; original.close();
        return { outputs, size };
    }, { source, crops });
    expect(result.outputs).toEqual(crops.map(crop => [Math.round(crop.width * 333), Math.round(crop.height * 517)]));
    expect(result.size).toEqual([333, 517]);
});

test("manual editor renders screen-sized strokes and caches the image while dragging a rectangle", async ({ page }, info) => {
    await page.goto("/__generation?tool=editor");
    const overlay = page.getByLabel("图片编辑画布");
    await expect(overlay).toBeVisible();
    await page.getByRole("button", { name: /^矩\s*形$/ }).click();
    const bounds = (await overlay.boundingBox())!;
    await page.mouse.move(bounds.x + 60, bounds.y + 80); await page.mouse.down(); await page.mouse.move(bounds.x + 160, bounds.y + 180, { steps: 4 }); await page.mouse.up();
    await expect(page.getByLabel("选中的矩形标注")).toBeVisible();
    await page.evaluate(() => { const canvas = document.querySelector('[aria-label="编辑图片预览"]') as HTMLCanvasElement; const original = canvas.getContext("2d")!.drawImage; (window as any).previewDraws = 0; canvas.getContext("2d")!.drawImage = function(...args: any[]) { (window as any).previewDraws++; return original.apply(this, args as any); }; });
    await page.mouse.move(bounds.x + 100, bounds.y + 120); await page.mouse.down();
    const downCount = await page.evaluate(() => (window as any).previewDraws);
    await page.mouse.move(bounds.x + 150, bounds.y + 170, { steps: 12 });
    expect(await page.evaluate(() => (window as any).previewDraws)).toBe(downCount);
    await page.mouse.up();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.screenshot({ path: info.outputPath("image-editor-narrow.png") });
});

test("compare sliders retain their rendered frame and interpolation offers a real 100 percent preview", async ({ page }, info) => {
    await page.goto("/__generation?tool=compare");
    const preview = page.getByLabel("改款前后对比预览");
    await expect(preview).toBeVisible();
    const slider = page.getByRole("slider");
    await slider.focus();
    for (let index = 0; index < 5; index++) { await page.keyboard.press("ArrowRight"); await expect(preview).toBeVisible(); }
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "按原分辨率导出", exact: true }).click();
    const output = await download;
    expect(output.suggestedFilename()).toContain("滑块_原分辨率.png");
    await output.saveAs(info.outputPath("comparison-original.png"));
    await page.goto("/__generation?tool=upscale");
    await expect(page.getByText("插值放大（非 AI）", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看 100% 局部预览", exact: true }).click();
    const local = page.getByAltText("放大结果 100% 局部");
    await expect(local).toBeVisible();
    expect(await local.evaluate((image: HTMLImageElement) => image.naturalWidth === image.width && image.naturalHeight === image.height)).toBe(true);
    await page.setViewportSize({ width: 720, height: 900 });
    await page.screenshot({ path: info.outputPath("upscale-preview-narrow.png") });
});

test("mask adaptation preserves source dimensions and every unpainted pixel through real browser raster/PNG/storage", async ({ page }) => {
    await page.goto("/__generation");
    await expect(page.getByLabel("蒙版绘制区")).toBeVisible();
    const result = await page.evaluate(async () => {
        const { canvasMaskAdaptationPlan, adaptCanvasMaskInputs, restoreCanvasMaskResult } = await import("/src/lib/canvas/canvas-mask-adaptation.ts");
        const { imageModelProfile } = await import("/src/lib/image-model-settings.ts");
        const { uploadImage } = await import("/src/services/image-storage.ts");
        const profile = imageModelProfile("mask-test");
        const width = 1080, height = 1440;
        const source = document.createElement("canvas"); source.width = width; source.height = height;
        const sourceContext = source.getContext("2d")!;
        const data = sourceContext.createImageData(width, height);
        for (let index = 0; index < data.data.length; index += 4) { data.data[index] = (index / 4) % 251; data.data[index + 1] = Math.floor(index / 4 / width) % 253; data.data[index + 2] = 93; data.data[index + 3] = 255; }
        sourceContext.putImageData(data, 0, 0);
        const mask = document.createElement("canvas"); mask.width = width; mask.height = height;
        const maskContext = mask.getContext("2d")!; maskContext.fillStyle = "white"; maskContext.fillRect(0, 0, width, height); maskContext.clearRect(400, 500, 120, 160);
        const plan = canvasMaskAdaptationPlan({ width, height }, profile);
        const sourceData = source.toDataURL("image/png"), maskData = mask.toDataURL("image/png");
        const adapted = await adaptCanvasMaskInputs(sourceData, maskData, plan);
        const inputImage = new Image(); inputImage.src = adapted.sourceDataUrl; await inputImage.decode();
        const maskImage = new Image(); maskImage.src = adapted.maskDataUrl; await maskImage.decode();
        const generated = document.createElement("canvas"); generated.width = plan.width; generated.height = plan.height;
        generated.getContext("2d")!.fillStyle = "#ff00ff"; generated.getContext("2d")!.fillRect(0, 0, plan.width, plan.height);
        const [storedSource, storedMask] = await Promise.all([uploadImage(sourceData), uploadImage(maskData)]);
        const node = { id: "result", type: "image", title: "pixel QA", position: { x: 0, y: 0 }, width: 300, height: 400, metadata: { maskAdaptation: { ...plan, sourceStorageKey: storedSource.storageKey, maskStorageKey: storedMask.storageKey } } };
        const outputUrl = await restoreCanvasMaskResult(node, generated.toDataURL("image/png"));
        const output = new Image(); output.src = outputUrl; await output.decode();
        const outputCanvas = document.createElement("canvas"); outputCanvas.width = width; outputCanvas.height = height;
        outputCanvas.getContext("2d")!.drawImage(output, 0, 0);
        const actual = outputCanvas.getContext("2d")!.getImageData(0, 0, width, height).data;
        let unchanged = 0, mismatches = 0, edited = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            if (x >= 400 && x < 520 && y >= 500 && y < 660) { if (actual[index] === 255 && actual[index + 1] === 0 && actual[index + 2] === 255) edited++; }
            else { unchanged++; for (let channel = 0; channel < 4; channel++) if (actual[index + channel] !== data.data[index + channel]) mismatches++; }
        }
        let mismatchedResultError = "";
        try { await restoreCanvasMaskResult(node, sourceData); } catch (error) { mismatchedResultError = (error as Error).message; }
        return { source: [width, height], adapted: [inputImage.naturalWidth, inputImage.naturalHeight], mask: [maskImage.naturalWidth, maskImage.naturalHeight], output: [output.naturalWidth, output.naturalHeight], unchanged, mismatches, edited, mismatchedResultError };
    });
    expect(result).toMatchObject({ source: [1080, 1440], adapted: [1024, 1536], mask: [1024, 1536], output: [1080, 1440], unchanged: 1536000, mismatches: 0, edited: 19200 });
    expect(result.mismatchedResultError).toContain("返回图片尺寸与适配坐标不符");
});

test("mask UI paints, undoes/redoes, zooms locally, uses shortcuts and confirms unsaved dismissal", async ({ page }, info) => {
    await page.goto("/__generation");
    const paint = page.getByLabel("蒙版绘制区");
    await expect(paint).toBeVisible();
    await expect(page.getByText("自动适配至", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "撤销笔画", exact: true })).toBeDisabled();
    const paintedPixels = () => page.locator("canvas.hidden").evaluate((canvas: HTMLCanvasElement) => { const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data; return Array.from(data).filter((value, index) => index % 4 === 3 && value >= 128).length; });
    const box = (await paint.boundingBox())!;
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55, { steps: 5 }); await page.mouse.up();
    const painted = await paintedPixels(); expect(painted).toBeGreaterThan(100);
    await page.getByRole("button", { name: "撤销笔画", exact: true }).click();
    await expect.poll(paintedPixels).toBe(0);
    await page.getByRole("button", { name: /^重\s*做$/ }).click();
    await expect.poll(paintedPixels).toBe(painted);
    await paint.hover(); await page.keyboard.down("Control"); await page.mouse.wheel(0, -150); await page.keyboard.up("Control");
    await expect(page.getByText("135%", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
    await page.getByRole("button", { name: "适应窗口", exact: true }).click();
    await page.keyboard.press("]"); await expect(page.getByText("44", { exact: false }).filter({ hasText: "显示像素" })).toBeVisible();
    await page.keyboard.press("e"); await expect(page.getByRole("button", { name: "擦除", exact: true })).toHaveClass(/ant-btn-primary/);
    await page.getByPlaceholder("例如：把选中区域改成金属材质，保持原图光影").fill("只修改涂抹区域");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByTestId("submitted")).toHaveAttribute("data-prompt", "只修改涂抹区域");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.screenshot({ path: info.outputPath("mask-editor-narrow.png") });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByText("放弃本次蒙版编辑？", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(paint).toBeVisible();
});
