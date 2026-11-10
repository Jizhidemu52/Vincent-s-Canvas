import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Locator, Page, Route } from "@playwright/test";
import { test, expect, IMAGE, newCanvas, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { assertVideoMotionTimeline, parseOptimizedPrompt } from "../../server/src/prompt-safety";
import { preflightVideoTask } from "../../server/src/video-task-preflight";

// All images/phrases below are synthetic. No employee inputs, provider requests,
// production accounts, or production storage are used by this browser suite.
const model = { id: "10000000-0000-4000-8000-000000000001", name: "Isolated image model", modelId: "gpt-image-2", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
const videoModel = { ...model, id: "10000000-0000-4000-8000-000000000003", name: "Isolated video model", modelId: "doubao-seedance-2.5", capabilities: ["video"] };
const textOnlyPrompt = "Create a cobalt blue knitted hat, retain the requested construction and material.";
const referencePrompt = "Edit Image 1: change only the knit color to cobalt blue; preserve the existing NOVA and 73 lettering, construction and material.";
const batchPrompt = "Change only the knit color to cobalt blue in each independent source; preserve each source's original lettering and construction.";
const movie = readFileSync(new URL("./media/video.mp4", import.meta.url));

async function hatImage(page: Page) {
    const encoded = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#f7f3ed"; context.fillRect(0, 0, 1024, 1024);
        context.fillStyle = "#9a6b5b"; context.beginPath(); context.arc(512, 455, 295, Math.PI, 0); context.lineTo(807, 730); context.lineTo(217, 730); context.fill();
        context.fillStyle = "#765044"; context.fillRect(190, 670, 644, 145);
        context.fillStyle = "#ffffff"; context.textAlign = "center"; context.font = "bold 88px sans-serif"; context.fillText("NOVA", 512, 490); context.fillText("73", 512, 605);
        return canvas.toDataURL("image/png").split(",")[1];
    });
    return Buffer.from(encoded!, "base64");
}

async function pasteReference(target: Locator, bytes: Buffer) {
    await target.evaluate((element, values) => {
        const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(values)], "synthetic-hat.png", { type: "image/png" }));
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...bytes]);
}

async function setupFlow(page: Page, api: MockCanvasApi, video = false) {
    const compilations: any[] = [], manualPosts: any[] = [], reused: string[] = [];
    const compiled = new Map<string, any>();
    const selected = video ? videoModel : model;
    await page.route("**/api/models", route => route.fulfill({ json: { models: [selected], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: selected.id, configurationVersion: 1 })) } }));
    const compile = (input: any, batch = false) => {
        const scene = input.promptInput.scene;
        const reverse = scene === "reverse-prompt", motion = scene === "video-motion";
        const referenceCount = batch ? 0 : input.sourceUrls.length - Number(input.promptInput.hasMask === true);
        const duration = Number(input.promptInput.fields?.duration || 5);
        const prompt = motion ? `0-${duration}秒：蓝色针织帽在原地缓慢旋转，镜头固定，保留帽子结构与材质。` : batch ? batchPrompt : referenceCount ? referencePrompt : textOnlyPrompt;
        const raw = JSON.stringify(reverse || motion ? { prompt, summary_zh: "保留主体结构和原有字样" } : { prompt, avoid: [], keep_text: referenceCount ? ["NOVA", "73"] : [] });
        // Exercise the real server output guard, not a success-only response stub.
        const result = parseOptimizedPrompt(raw, [], { video: motion, reverse, referenceCount, userText: input.promptInput.userText || "", language: motion ? "zh" : "en" });
        if (motion) assertVideoMotionTimeline(result.prompt, duration);
        const compilation = { id: randomUUID(), requestId: input.requestId, status: "success", optimized: true, ...result };
        compiled.set(compilation.id, compilation); compilations.push({ ...input, batch, compilation });
        return compilation;
    };
    await page.route("**/api/prompt-compilations", route => {
        const input = route.request().postDataJSON(); manualPosts.push(input);
        return route.fulfill({ json: { compilation: compile(input) } });
    });
    await page.route("**/api/tasks/preflight", route => {
        const input = route.request().postDataJSON();
        const checked = preflightVideoTask({ model: videoModel.modelId, prompt: input.prompt, parameters: input.parameters });
        return route.fulfill({ json: { ok: true, normalized: checked.normalized } });
    });
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON(); api.submissions.push(input);
        const previous = input.promptInput?.compilationId ? compiled.get(input.promptInput.compilationId) : null;
        if (input.promptInput?.compilationId) { expect(previous).toBeDefined(); reused.push(input.promptInput.compilationId); }
        const compilation = previous || (input.promptInput ? compile(input) : null);
        const id = randomUUID(), isVideo = input.operationType === "video_generation";
        const task = { ...input, id, userId: "00000000-0000-4000-8000-000000000099", status: "success", prompt: compilation?.prompt || input.prompt, summaryZh: compilation?.summaryZh, optimized: Boolean(compilation), userInput: input.promptInput, resultUrls: [`/api/assets/${id}/content`], failureReason: null, createdAt: new Date().toISOString() };
        api.tasks.set(id, task);
        const maskOriginal = input.parameters.inputArchive?.maskReferenceIndex === 1 ? api.assetBytes.get(input.sourceUrls[0].split("/")[3]) : undefined;
        api.assetBytes.set(id, maskOriginal || IMAGE);
        api.assets.set(id, { id, ownerUserId: task.userId, status: "ready", mimeType: isVideo ? "video/mp4" : "image/png", contentUrl: task.resultUrls[0] });
        if (isVideo) {
            await page.route(`**/api/assets/${id}/content`, content => content.fulfill({ contentType: "video/mp4", body: movie }));
            await page.route(`**/api/assets/${id}/playback`, content => content.fulfill({ contentType: "video/mp4", body: movie }));
        }
        return route.fulfill({ status: 201, json: { task } });
    });
    await page.route("**/api/tasks/batch", route => {
        const input = route.request().postDataJSON(); api.batchSubmissions.push(input);
        const compilation = input.promptInput ? compile({ ...input, sourceUrls: [] }, true) : null;
        const tasks = input.items.map((item: any, itemIndex: number) => {
            const id = randomUUID();
            const task = { ...input, ...item, id, itemIndex, batchId: api.batchId, status: "success", prompt: compilation?.prompt || input.prompt, optimized: Boolean(compilation), userInput: input.promptInput, resultUrls: [`/api/assets/${id}/content`], failureReason: null, createdAt: new Date().toISOString() };
            api.tasks.set(id, task); api.assetBytes.set(id, IMAGE); return task;
        });
        return route.fulfill({ status: 201, json: { batchId: api.batchId, tasks, failures: [], prompt: compilation?.prompt || input.prompt, optimized: Boolean(compilation) } });
    });
    return { compilations, manualPosts, reused };
}

for (const mode of [{ query: "", tool: "image", operation: "image_generation", action: "开始生成" }, { query: "?tool=image-edit", tool: "image-edit", operation: "inpaint", action: "开始编辑" }]) {
    test(`${mode.tool}: lettering seen only in the synthetic reference survives optimize then one generation`, async ({ page, api }) => {
        const flow = await setupFlow(page, api), bytes = await hatImage(page);
        await page.goto(`/image${mode.query}`);
        const input = page.getByRole("textbox", { name: "图像提示词", exact: true });
        await input.fill("仅将帽子改为钴蓝色，其他保持参考图原样");
        await pasteReference(input, bytes);
        await expect(page.getByRole("img", { name: "synthetic-hat.png", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
        const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
        await expect(preview.locator("pre").nth(1)).toHaveText(referencePrompt);
        await expect(input).toHaveValue("仅将帽子改为钴蓝色，其他保持参考图原样");
        expect(api.submissions).toHaveLength(0);
        await preview.getByRole("button", { name: "确认应用", exact: true }).click();
        await expect(preview).toBeHidden();
        await expect(input).toHaveValue(referencePrompt);
        expect(flow.compilations).toHaveLength(1); expect(api.submissions).toHaveLength(0);
        expect(flow.compilations[0].promptInput.userText).not.toContain("NOVA");
        expect(flow.compilations[0].compilation.keepText).toEqual(["NOVA", "73"]);
        await page.getByRole("button", { name: mode.action, exact: true }).click();
        await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength(1); expect(flow.compilations).toHaveLength(1);
        expect(api.submissions[0]).toMatchObject({ prompt: referencePrompt, toolKey: mode.tool, operationType: mode.operation, promptInput: { compilationId: flow.compilations[0].compilation.id } });
        expect(api.submissions[0].sourceUrls).toEqual(flow.compilations[0].sourceUrls);
        expect(flow.reused).toHaveLength(1);
        expect([...api.assetBytes.values()].some(value => value.equals(bytes))).toBe(true);
    });
}

test("canvas reference optimization preserves literal lettering and reuses the compilation only once", async ({ page, api }) => {
    const flow = await setupFlow(page, api), bytes = await hatImage(page), id = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel"), prompt = panel.getByRole("textbox", { name: "描述图像", exact: true });
    await prompt.fill("仅改变帽子的针织颜色，其他完全保留");
    await pasteReference(prompt, bytes);
    await expect(panel.locator(".cw-reference-image")).toHaveCount(1);
    await panel.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
    await expect(preview.locator("pre").nth(1)).toHaveText(referencePrompt);
    await expect(prompt).toHaveValue("仅改变帽子的针织颜色，其他完全保留");
    expect(api.submissions).toHaveLength(0);
    await preview.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(prompt).toHaveValue(referencePrompt);
    expect(api.submissions).toHaveLength(0);
    await panel.getByRole("button", { name: /^生成修改图/ }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.metadata?.prompt === referencePrompt && node.metadata?.status === "success")).toBe(true);
    expect(flow.compilations).toHaveLength(1); expect(flow.reused).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "canvas-edit", operationType: "inpaint", promptInput: { compilationId: flow.compilations[0].compilation.id } });
    await page.reload();
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.metadata?.prompt === referencePrompt)).toBe(true);
    expect(api.submissions).toHaveLength(1); expect(flow.compilations).toHaveLength(1);
});

for (const scene of ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "accessory-design", "pattern-craft"]) {
    test(`creative ${scene}: automatic optimization reaches one image and retains the compiled result prompt`, async ({ page, api }) => {
        const flow = await setupFlow(page, api), bytes = await hatImage(page);
        await page.goto(`/creative/${scene}`);
        await expect(page.locator(".cs-form-body")).toBeVisible();
        if (scene === "text-to-style") await page.getByRole("textbox", { name: "款式描述", exact: true }).fill("钴蓝色针织帽，罗纹翻边");
        for (const input of await page.locator(".cs-upload input[type=file]").all()) {
            await input.setInputFiles({ name: "synthetic-hat.png", mimeType: "image/png", buffer: bytes });
            await expect(input.locator("..").locator("img")).toBeVisible();
        }
        if (scene === "local-restyle") {
            await page.getByRole("textbox", { name: "要改成什么样", exact: true }).fill("只把帽子顶部针织改为钴蓝色");
            await page.getByRole("button", { name: "涂选修改区域", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
            await expect(dialog.getByRole("button", { name: "保存选区", exact: true })).toBeEnabled();
            const selection = dialog.getByLabel("修改区域画布", { exact: true });
            await expect(dialog).not.toHaveClass(/\bant-zoom-(?:appear|enter)\b/);
            const box = (await selection.boundingBox())!;
            await selection.click({ position: { x: box.width / 2, y: box.height / 3 } });
            await expect.poll(() => selection.evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 3), 1, 1).data[3])).toBe(255);
            await dialog.getByRole("button", { name: "保存选区", exact: true }).click();
            await expect(dialog).toBeHidden();
        }
        await page.locator("button.cs-generate").click();
        await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
        expect(flow.manualPosts).toHaveLength(0); expect(flow.compilations).toHaveLength(1); expect(api.submissions).toHaveLength(1);
        expect(api.submissions[0]).toMatchObject({ toolKey: `creative-${scene}`, promptInput: { scene } });
        await page.locator(".cs-result-card img").click();
        await expect(page.getByLabel("设计提示词", { exact: true })).toContainText(scene === "text-to-style" ? textOnlyPrompt : referencePrompt);
        if (scene === "local-restyle") {
            expect(api.submissions[0].sourceUrls).toHaveLength(2);
            expect(api.submissions[0].promptInput.fields.selectionGuide).toBe(true);
            expect(api.submissions[0].parameters.maskReferenceIndex).toBeUndefined();
            const [originalId, guideId] = api.submissions[0].sourceUrls.map((url: string) => url.split("/")[3]);
            expect(api.assetBytes.get(originalId)).toEqual(bytes);
            expect(api.assetBytes.get(guideId)).not.toEqual(bytes);
            await expect(page.getByText("已开启选区合成：选区外保留原图。修改处的结构和衔接仍需检查。", { exact: true })).toBeVisible();
        }
    });
}

test("series selected color optimizes exactly once with its full palette and displays the optimized candidate", async ({ page, api }) => {
    const flow = await setupFlow(page, api), bytes = await hatImage(page);
    await page.goto("/creative/series-recipe");
    await page.getByLabel("上传参考底图（必需）", { exact: true }).setInputFiles({ name: "synthetic-hat.png", mimeType: "image/png", buffer: bytes });
    await page.getByRole("combobox", { name: "配色数量", exact: true }).selectOption("6");
    await page.getByRole("button", { name: "编辑第 3 色 #b9827b", exact: true }).click();
    await page.getByRole("button", { name: "生成第 3 色 1 张", exact: true }).click();
    await expect(page.locator(".sr-result img")).toHaveCount(1);
    expect(flow.compilations).toHaveLength(1); expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "series-recipe", promptInput: { scene: "series-recipe", fields: { variantIndex: 2, count: 6 } }, parameters: { n: 1, count: 1 } });
    expect(api.submissions[0].promptInput.fields.palette).toHaveLength(6);
    expect([...api.tasks.values()][0].prompt).toBe(referencePrompt);
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByText("已保存到当前员工的本地浏览器。", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator(".sr-result img")).toHaveCount(1);
    expect(flow.compilations).toHaveLength(1); expect(api.submissions).toHaveLength(1);
});

test("canvas batch opt-in compiles once for two independent originals and never creates a second batch", async ({ page, api }) => {
    const flow = await setupFlow(page, api), bytes = await hatImage(page);
    let runtimeRequest: Route | undefined;
    await page.route("**/src/pages/canvas/canvas-batch-edit-runtime.ts*", route => { runtimeRequest = route; });
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "批量改图", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "批量一键改图" }), chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "选择图片（可多选）" }).click();
    await (await chooser).setFiles(["hat-a.png", "hat-b.png"].map(name => ({ name, mimeType: "image/png", buffer: bytes })));
    await expect.poll(() => Boolean(runtimeRequest)).toBe(true);
    // Edit while file preparation is blocked on its lazy module. These unrelated
    // fields must not invalidate the already selected independent originals.
    const instruction = "分别改为钴蓝色，逐张保留其原来的文字和结构";
    await dialog.locator("textarea").fill(instruction);
    await expect(dialog.getByRole("switch", { name: "批量统一优化提示词", exact: true })).not.toBeChecked();
    await dialog.getByRole("switch", { name: "批量统一优化提示词", exact: true }).click();
    await expect(dialog.locator("textarea")).toHaveValue(instruction);
    await expect(dialog.getByRole("switch", { name: "批量统一优化提示词", exact: true })).toBeChecked();
    expect(api.batchSubmissions).toHaveLength(0); expect(flow.compilations).toHaveLength(0);
    await runtimeRequest!.fallback();
    await expect(dialog.getByText("hat-a.png", { exact: true })).toBeVisible();
    await expect(dialog.getByText("hat-b.png", { exact: true })).toBeVisible();
    await expect(dialog.getByText("等待中", { exact: true })).toHaveCount(2);
    await dialog.getByRole("button", { name: "一键生图", exact: true }).click();
    await expect(dialog.getByText("成功", { exact: true })).toHaveCount(2);
    expect(api.batchSubmissions).toHaveLength(1); expect(api.submissions).toHaveLength(0); expect(flow.compilations).toHaveLength(1);
    expect(api.batchSubmissions[0]).toMatchObject({ operationType: "batch_image", toolKey: "canvas-batch", promptInput: { scene: "batch-optimize", mode: "edit", userText: instruction }, parameters: { count: 1, n: 1 } });
    expect(api.batchSubmissions[0].items).toHaveLength(2);
    expect(new Set(api.batchSubmissions[0].items.map((item: any) => item.sourceUrls[0])).size).toBe(2);
    await expect.poll(() => api.document(id)?.nodes.filter((node: any) => node.metadata?.prompt === batchPrompt && node.metadata?.status === "success").length).toBe(2);
});

test("video motion planning compiles the real duration and returns one playable result without image-schema fields", async ({ page, api }) => {
    const flow = await setupFlow(page, api, true);
    await page.goto("/video");
    await page.getByRole("textbox", { name: "视频提示词", exact: true }).fill("蓝色针织帽原地缓慢旋转，保留结构和材质");
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await expect(page.locator("video")).toHaveCount(1);
    await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    expect(api.submissions).toHaveLength(1); expect(flow.compilations).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "video", operationType: "video_generation", promptInput: { scene: "video-motion", mode: "video", outputLanguage: "zh" } });
    const final = [...api.tasks.values()][0];
    assertVideoMotionTimeline(final.prompt, api.submissions[0].promptInput.fields.duration);
    expect(final.summaryZh).toBe("保留主体结构和原有字样");
    await page.reload();
    await expect(page.locator("video")).toHaveCount(1);
    expect(api.submissions).toHaveLength(1); expect(flow.compilations).toHaveLength(1);
});

test("reverse prompt inspects the original image and creates text only, never an image task", async ({ page, api }) => {
    const flow = await setupFlow(page, api), bytes = await hatImage(page), id = await newCanvas(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "synthetic-hat.png", mimeType: "image/png", buffer: bytes });
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const node = page.locator(`[data-node-id="${api.document(id)!.nodes[0].id}"]`);
    await node.click({ position: { x: 35, y: 15 } }); await node.hover();
    const action = page.getByRole("button", { name: "反推提示词", exact: true });
    if (await action.isVisible()) await action.click();
    else { await page.getByRole("button", { name: "更多图片工具", exact: true }).click(); await page.getByRole("menuitem", { name: "反推提示词", exact: true }).click(); }
    await expect.poll(() => api.document(id)?.nodes.some((item: any) => item.metadata?.content?.includes(referencePrompt))).toBe(true);
    expect(flow.compilations).toHaveLength(1); expect(api.submissions).toHaveLength(0); expect(api.batchSubmissions).toHaveLength(0);
    expect(flow.compilations[0]).toMatchObject({ toolKey: "canvas-edit", promptInput: { scene: "reverse-prompt", mode: "edit", userText: "" } });
    expect(flow.compilations[0].sourceUrls).toHaveLength(1);
});

test("native mask editing keeps its explicit instruction and mask, without borrowing a prior whole-image compilation", async ({ page, api }) => {
    const flow = await setupFlow(page, api), bytes = await hatImage(page), id = await newCanvas(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "synthetic-hat.png", mimeType: "image/png", buffer: bytes });
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const nodeId = api.document(id)!.nodes[0].id, node = page.locator(`[data-node-id="${nodeId}"]`);
    await node.click({ position: { x: 35, y: 15 } });
    const open = page.getByRole("button", { name: "展开创建面板", exact: true });
    if (await open.isVisible()) await open.click();
    const panel = page.getByTestId("canvas-quick-generate-panel"), prompt = panel.getByRole("textbox", { name: "描述图像", exact: true });
    await expect(panel.locator(".cw-reference-image")).toHaveCount(1);
    await prompt.fill("整张帽子改为钴蓝色，保留所有文字");
    await panel.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
    await expect(preview.locator("pre").nth(1)).toHaveText(referencePrompt);
    await expect(prompt).toHaveValue("整张帽子改为钴蓝色，保留所有文字");
    expect(api.submissions).toHaveLength(0);
    await preview.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(prompt).toHaveValue(referencePrompt);
    expect(flow.compilations).toHaveLength(1); expect(api.submissions).toHaveLength(0);
    await node.hover();
    const mask = page.getByRole("button", { name: "局部重绘", exact: true });
    if (await mask.isVisible()) await mask.click();
    else { await page.getByRole("button", { name: "更多图片工具", exact: true }).click(); await page.getByRole("menuitem", { name: "局部重绘", exact: true }).click(); }
    const dialog = page.getByRole("dialog", { name: "局部遮罩编辑", exact: true });
    await expect(dialog.getByRole("button", { name: "AI 修改", exact: true })).toBeEnabled();
    await expect(dialog).not.toHaveClass(/ant-zoom-(?:enter|appear)/);
    const box = (await dialog.locator('[aria-label="蒙版绘制区"]').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
    const instruction = "仅将涂选区域改为浅绿色，保留所有字样";
    await dialog.getByRole("textbox").fill(instruction);
    await dialog.getByRole("button", { name: "AI 修改", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.submissions.length).toBe(1);
    const task = api.submissions[0];
    expect(task).toMatchObject({ toolKey: "canvas-mask-edit", operationType: "inpaint" });
    expect(task.prompt).toContain(`只修改蒙版透明区域，其他区域保持不变。${instruction}`);
    expect(task.prompt).not.toContain(referencePrompt); expect(task.promptInput).toBeUndefined();
    expect(task.sourceUrls).toHaveLength(2); expect(task.parameters.inputArchive.maskReferenceIndex).toBe(1);
    expect(flow.compilations).toHaveLength(1); expect(flow.reused).toHaveLength(0);
    await expect.poll(() => api.document(id)?.nodes.some((item: any) => item.id !== nodeId && item.metadata?.status === "success")).toBe(true);
    expect(api.document(id)!.nodes.some((item: any) => item.id === nodeId)).toBe(true);
    expect(api.assetBytes.get(task.sourceUrls[0].split("/")[3])).toEqual(bytes);
});

test("manual optimizer retains an uncertain request through a failed lookup and only queries it again", async ({ page, api }) => {
    await setupFlow(page, api);
    let posts = 0, lookups = 0, requestId = "";
    await page.route("**/api/prompt-compilations", route => { posts++; requestId = route.request().postDataJSON().requestId; return route.fulfill({ status: 503, json: { error: "UNKNOWN_SUBMISSION_STATE", message: "isolated uncertain response" } }); });
    await page.route("**/api/prompt-compilations/by-request/**", route => {
        expect(route.request().url()).toContain(requestId); lookups++;
        return lookups < 3 ? route.fulfill({ status: 503, json: { message: "isolated lookup unavailable" } }) : route.fulfill({ json: { compilation: { id: randomUUID(), requestId, status: "success", optimized: true, prompt: textOnlyPrompt } } });
    });
    await page.goto("/image");
    const input = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await input.fill("钴蓝色针织帽");
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const query = page.getByRole("button", { name: "查询原优化请求", exact: true });
    await expect(query).toBeEnabled();
    await query.click(); await expect(query).toBeEnabled();
    await query.click();
    const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
    await expect(preview.locator("pre").nth(1)).toHaveText(textOnlyPrompt);
    await expect(input).toHaveValue("钴蓝色针织帽");
    expect(posts).toBe(1); expect(lookups).toBe(3); expect(api.submissions).toHaveLength(0);
    await preview.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(input).toHaveValue(textOnlyPrompt);
    expect(posts).toBe(1); expect(lookups).toBe(3); expect(api.submissions).toHaveLength(0);
});
