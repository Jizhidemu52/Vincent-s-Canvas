import type { Page } from "@playwright/test";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";

type RegionComposite = {
    mode: "selection-composite";
    source: { imageId: string; storageKey: string; width: number; height: number };
    selection: { storageKey: string; width: number; height: number };
};
const generated = (page: Page) => page.locator('[data-message-role="assistant"] .group\\/image');

async function savedSessions(page: Page): Promise<any[]> {
    return page.evaluate(async () => {
        const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        return chatSessionStorage.load(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, () => null);
    });
}

async function send(page: Page, content: string) {
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill(content);
    await page.getByRole("button", { name: "发送", exact: true }).click();
}

async function prepare(page: Page, api: MockCanvasApi, resultSize = { width: 1024, height: 1024 }) {
    const plans: any[] = [];
    await page.route("**/api/models", route => route.fulfill({ json: {
        models: [
            { id: "fixture-chat", modelId: "gpt-6-astra", name: "隔离对话模型", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
            { id: "fixture-nano", modelId: "gemini-3.1-flash-image-preview-official", name: "隔离 Nano2", imageParameterProfile: "resolution", imageSupportsMask: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
        ], prices: [], tools: [
            { toolKey: "gpt-chat", enabled: true, modelConfigId: "fixture-chat", configurationVersion: 1 },
            { toolKey: "gpt-chat-image", enabled: true, modelConfigId: "fixture-nano", configurationVersion: 1 },
        ],
    } }));
    await page.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); plans.push(body);
        return route.fulfill({ json: body.profileContext.currentUserText === "只查看原图，暂不生成"
            ? { content: "已查看原图，请圈选允许改变的区域。", toolCalls: [] }
            : { content: "只修改圈选范围。", toolCalls: [{ id: "edit-" + plans.length, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: body.profileContext.currentUserText, note_update: "圈选范围改红色", keep: ["选区外全部保持原样"] }) } }] },
        });
    });
    await page.goto("/chat");
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    const redPng = await page.evaluate(({ width, height }) => {
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d")!; context.fillStyle = "#ff0000"; context.fillRect(0, 0, width, height);
        return canvas.toDataURL("image/png").split(",")[1]!;
    }, resultSize);
    await page.context().route("**/api/assets/*/content", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3]!;
        return api.tasks.has(id) ? route.fulfill({ contentType: "image/png", body: Buffer.from(redPng, "base64") }) : route.fallback();
    });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "保留原像素.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 保留原像素.png", exact: true })).toBeVisible();
    await send(page, "只查看原图，暂不生成");
    await expect(page.getByText("已查看原图，请圈选允许改变的区域。", { exact: true })).toBeVisible();
    await expect.poll(async () => (await savedSessions(page))[0]?.messages.find((item: any) => item.attachments?.length)?.attachments[0]?.storageKey).toMatch(/^image:/);
    expect(api.submissions).toHaveLength(0);
    return { plans };
}

async function paintRegion(page: Page) {
    const card = page.locator('[data-message-role="user"] .group\\/image').first();
    await card.hover();
    await card.getByRole("button", { name: "更多图片操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "圈选修改", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
    await expect(dialog.getByText(/它不是模型原生蒙版/)).toBeVisible();
    const paint = dialog.getByLabel("修改区域画布", { exact: true });
    await expect(paint).toBeVisible();
    await paint.click({ trial: true });
    await expect(dialog).not.toHaveClass(/ant-zoom-(?:enter|appear)/);
    await expect(dialog).toHaveCSS("transform", "none");
    const box = (await paint.boundingBox())!;
    expect(box.width).toBeGreaterThan(200); expect(box.height).toBeGreaterThan(200);
    await page.mouse.move(box.x + box.width * .42, box.y + box.height * .5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .58, box.y + box.height * .5, { steps: 8 });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "保存选区", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("已圈选局部区域，仅修改选区内", { exact: true })).toBeVisible();
}

function assertContract(region: RegionComposite, original: any) {
    expect(region).toMatchObject({
        mode: "selection-composite",
        source: { imageId: original.id, storageKey: original.storageKey, width: 256, height: 256 },
        selection: { storageKey: expect.stringMatching(/^image:/), width: 256, height: 256 },
    });
    expect(region.selection.storageKey).not.toBe(region.source.storageKey);
}

async function verifySubmittedReferences(page: Page, api: MockCanvasApi, region: RegionComposite, submissionIndex = 0) {
    expect(api.submissions).toHaveLength(submissionIndex + 1);
    const submitted = api.submissions[submissionIndex]!;
    expect(submitted.sourceUrls).toHaveLength(2);
    expect(submitted.parameters.inputArchive.references).toHaveLength(2);
    expect(submitted.parameters.inputArchive.references[0].id).toBe(region.source.imageId);
    expect(submitted.parameters.inputArchive).not.toHaveProperty("maskReferenceIndex");
    expect(submitted.parameters).not.toHaveProperty("maskReferenceIndex");
    expect(submitted.parameters.hasMask).not.toBe(true);
    expect(submitted.promptInput?.hasMask).not.toBe(true);
    const originalAssetId = new URL(submitted.sourceUrls[0], page.url()).pathname.split("/")[3]!;
    const guideAssetId = new URL(submitted.sourceUrls[1], page.url()).pathname.split("/")[3]!;
    expect(api.assetBytes.get(originalAssetId)?.equals(IMAGE)).toBe(true);
    expect(api.assetBytes.get(guideAssetId)?.equals(IMAGE)).toBe(false);
    const evidence = await page.evaluate(async ({ sourceUrl, guideUrl, region }) => {
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const decode = async (blob: Blob) => {
            const bitmap = await createImageBitmap(blob);
            try {
                const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
                const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, canvas.width, canvas.height);
            } finally { bitmap.close(); }
        };
        const storedSource = (await getImageBlob(region.source.storageKey))!;
        const selectionBlob = (await getImageBlob(region.selection.storageKey))!;
        if (!storedSource || !selectionBlob) throw new Error("合成契约引用的原图或选区未持久化");
        const [original, guide, selection, durableOriginal] = await Promise.all([
            fetch(sourceUrl).then(response => response.blob()).then(decode),
            fetch(guideUrl).then(response => response.blob()).then(decode),
            decode(selectionBlob), decode(storedSource),
        ]);
        let outside = 0, guideOutsideDiff = 0, guideInsideDiff = 0, sourceDiff = 0;
        for (let offset = 0; offset < original.data.length; offset += 4) {
            const different = (a: Uint8ClampedArray, b: Uint8ClampedArray) => [0, 1, 2, 3].some(channel => a[offset + channel] !== b[offset + channel]);
            if (different(original.data, durableOriginal.data)) sourceDiff++;
            if (selection.data[offset + 3] === 0) { outside++; if (different(original.data, guide.data)) guideOutsideDiff++; }
            else if (different(original.data, guide.data)) guideInsideDiff++;
        }
        return { sourceSize: [original.width, original.height], guideSize: [guide.width, guide.height], selectionSize: [selection.width, selection.height], outside, guideOutsideDiff, guideInsideDiff, sourceDiff };
    }, { sourceUrl: submitted.sourceUrls[0], guideUrl: submitted.sourceUrls[1], region });
    expect(evidence).toMatchObject({ sourceSize: [256, 256], guideSize: [256, 256], selectionSize: [256, 256], guideOutsideDiff: 0, sourceDiff: 0 });
    expect(evidence.outside).toBeGreaterThan(256 * 256 / 2);
    expect(evidence.guideInsideDiff).toBeGreaterThan(0);
}

async function verifyFinalPixels(page: Page, result: any) {
    const evidence = await page.evaluate(async ({ storageKey, region }) => {
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const outputBlob = (await getImageBlob(storageKey))!;
        if (!outputBlob) throw new Error("合成结果没有持久化 PNG");
        const decode = async (key: string) => {
            const blob = (await getImageBlob(key))!;
            if (!blob) throw new Error("缺失合成输入素材");
            const bitmap = await createImageBitmap(blob);
            try {
                const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
                const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, canvas.width, canvas.height);
            } finally { bitmap.close(); }
        };
        const [original, selection, edited] = await Promise.all([decode(region.source.storageKey), decode(region.selection.storageKey), decode(storageKey)]);
        let outside = 0, outsideDiff = 0, selected = 0, selectedDiff = 0;
        for (let offset = 0; offset < original.data.length; offset += 4) {
            if (selection.data[offset + 3] === 0) {
                outside++;
                if ([0, 1, 2, 3].some(channel => edited.data[offset + channel] !== original.data[offset + channel])) outsideDiff++;
            } else if (selection.data[offset + 3] === 255) {
                selected++;
                if ([255, 0, 0, 255].some((value, channel) => edited.data[offset + channel] !== value)) selectedDiff++;
            }
        }
        return { mimeType: outputBlob.type, signature: [...new Uint8Array(await outputBlob.slice(0, 8).arrayBuffer())], originalSize: [original.width, original.height], outputSize: [edited.width, edited.height], outside, outsideDiff, selected, selectedDiff };
    }, { storageKey: result.storageKey, region: result.regionComposite as RegionComposite });
    expect(evidence).toMatchObject({ mimeType: "image/png", signature: [137, 80, 78, 71, 13, 10, 26, 10], originalSize: [256, 256], outputSize: [256, 256], outsideDiff: 0, selectedDiff: 0 });
    expect(evidence.outside).toBeGreaterThan(256 * 256 / 2);
    expect(evidence.selected).toBeGreaterThan(0);
}

for (const mode of ["正常返回", "processing 后刷新恢复"] as const) {
    test(`Nano2 ${mode}使用选区示意图并保护全部未选中像素`, async ({ page, api }, info) => {
        api.taskStatus = mode === "正常返回" ? "success" : "processing";
        const { plans } = await prepare(page, api);
        const original = (await savedSessions(page))[0].messages.find((item: any) => item.attachments?.length).attachments[0];
        await paintRegion(page);
        await send(page, "只把圈选范围改为纯红色，选区外全部保持原样");
        await expect.poll(() => api.submissions.length).toBe(1);
        const taskId = [...api.tasks.keys()][0]!;
        let savedRegion: RegionComposite | undefined;
        if (mode !== "正常返回") {
            await expect.poll(async () => (await savedSessions(page))[0]?.messages.find((item: any) => item.pendingImageTask)?.pendingImageTask?.taskId).toBe(taskId);
            const pending = (await savedSessions(page))[0].messages.find((item: any) => item.pendingImageTask).pendingImageTask;
            savedRegion = pending.regionComposite;
            assertContract(savedRegion!, original);
            expect(pending).not.toHaveProperty("maskAdaptation");
            await page.reload();
            await expect(page.getByTestId("chat-pending-image-card")).toHaveCount(1);
            const restored = (await savedSessions(page))[0].messages.find((item: any) => item.pendingImageTask).pendingImageTask;
            expect(restored.regionComposite).toEqual(savedRegion);
            expect(api.submissions).toHaveLength(1);
            expect(plans).toHaveLength(2);
            const task = api.tasks.get(taskId)!; task.status = "success"; task.resultUrls = [`/api/assets/${taskId}/content`];
            await page.reload();
        }
        await expect(generated(page)).toHaveCount(1);
        await expect(page.getByTestId("chat-pending-image-card")).toHaveCount(0);
        await expect.poll(async () => (await savedSessions(page))[0]?.messages.find((item: any) => item.generatedImages?.length)?.generatedImages[0]?.storageKey).toMatch(/^image:/);
        const completed = (await savedSessions(page))[0];
        const result = completed.messages.find((item: any) => item.generatedImages?.length).generatedImages[0];
        assertContract(result.regionComposite, original);
        if (savedRegion) expect(result.regionComposite).toEqual(savedRegion);
        expect(result).toMatchObject({ id: `${taskId}:0`, sourceTaskId: taskId, sourceResultUrl: `/api/assets/${taskId}/content`, mimeType: "image/png" });
        expect(result).not.toHaveProperty("maskAdaptation");
        expect(completed.focusImageId).toBe(result.id);
        await verifySubmittedReferences(page, api, result.regionComposite);
        await verifyFinalPixels(page, result);
        await page.screenshot({ path: info.outputPath(mode === "正常返回" ? "nano-composite-normal.png" : "nano-composite-recovered.png"), animations: "disabled" });
        await page.reload();
        await expect(generated(page)).toHaveCount(1);
        expect((await savedSessions(page))[0].messages.find((item: any) => item.generatedImages?.length).generatedImages[0]).toEqual(result);
        expect(api.submissions).toHaveLength(1);
        expect(plans).toHaveLength(2);
    });
}

test("Nano2 返回比例不符时保留原任务，刷新和查询都不重发", async ({ page, api }, info) => {
    const { plans } = await prepare(page, api, { width: 1024, height: 512 });
    const original = (await savedSessions(page))[0].messages.find((item: any) => item.attachments?.length).attachments[0];
    await paintRegion(page);
    await send(page, "只把圈选范围改为纯红色，选区外全部保持原样");
    await expect.poll(() => api.submissions.length).toBe(1);
    const taskId = [...api.tasks.keys()][0]!;
    await expect(page.getByText(/比例与原图不一致/)).toBeVisible();
    await expect(page.getByTestId("chat-pending-image-card")).toHaveCount(1);
    await expect(generated(page)).toHaveCount(0);
    const before = (await savedSessions(page))[0];
    const pending = before.messages.find((item: any) => item.pendingImageTask).pendingImageTask;
    expect(pending.taskId).toBe(taskId);
    assertContract(pending.regionComposite, original);
    expect(before.focusImageId).toBe(original.id);
    await verifySubmittedReferences(page, api, pending.regionComposite);
    await page.reload();
    await expect(page.getByText(/比例与原图不一致/)).toBeVisible();
    const reads = api.taskReads.length;
    await page.getByTestId("chat-image-recovery-action").click();
    await expect.poll(() => api.taskReads.length).toBeGreaterThan(reads);
    await expect(page.getByText(/比例与原图不一致/)).toBeVisible();
    await expect(generated(page)).toHaveCount(0);
    const after = (await savedSessions(page))[0];
    expect(after.messages.find((item: any) => item.pendingImageTask).pendingImageTask).toMatchObject({ requestId: pending.requestId, taskId, regionComposite: pending.regionComposite });
    expect(after.focusImageId).toBe(original.id);
    expect(api.tasks.get(taskId)?.resultUrls).toEqual([`/api/assets/${taskId}/content`]);
    expect(api.submissions).toHaveLength(1);
    expect(plans).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("nano-composite-aspect-failure.png"), animations: "disabled" });
});

for (const replay of ["重新生成", "编辑发送"] as const) {
    test(`Nano2 刷新后${replay}仍使用原选区，不降级为整图修改`, async ({ page, api }, info) => {
        const { plans } = await prepare(page, api);
        const original = (await savedSessions(page))[0].messages.find((item: any) => item.attachments?.length).attachments[0];
        await paintRegion(page);
        await send(page, "只把圈选范围改为纯红色，选区外全部保持原样");
        await expect(generated(page)).toHaveCount(1);
        await expect.poll(async () => (await savedSessions(page))[0]?.messages.find((item: any) => item.generatedImages?.length)?.generatedImages[0]?.storageKey).toMatch(/^image:/);
        const first = (await savedSessions(page))[0];
        const firstAnswer = first.messages.find((item: any) => item.generatedImages?.length);
        const firstResult = firstAnswer.generatedImages[0];
        const sourceTurn = first.messages.find((item: any) => item.id === firstAnswer.parentMessageId);
        expect(sourceTurn.regionSelection).toMatchObject({
            imageId: original.id,
            selection: { storageKey: firstResult.regionComposite.selection.storageKey, dataUrl: "" },
            mask: { storageKey: expect.stringMatching(/^image:/), dataUrl: "" },
        });
        expect(JSON.stringify(sourceTurn.regionSelection)).not.toMatch(/blob:|data:image/);
        await page.reload();
        await expect(generated(page)).toHaveCount(1);
        // The composer has no live selection after reload; replay must restore its saved contract.
        await expect(page.getByText("已圈选局部区域，仅修改选区内", { exact: true })).toHaveCount(0);
        const editedText = "仍只把原圈选范围改为纯红色，其余全部保持原样";
        if (replay === "重新生成") {
            await page.locator(`[data-message-id="${firstAnswer.id}"]`).getByRole("button", { name: "重新生成", exact: true }).click();
        } else {
            await page.locator(`[data-message-id="${sourceTurn.id}"]`).getByRole("button", { name: "编辑消息", exact: true }).click();
            await page.getByRole("textbox", { name: "编辑消息", exact: true }).fill(editedText);
            await page.getByRole("button", { name: "发送为新分支", exact: true }).click();
        }
        await expect.poll(() => api.submissions.length).toBe(2);
        await expect.poll(async () => (await savedSessions(page)).length).toBe(2);
        const taskId = [...api.tasks.keys()][1]!;
        await expect.poll(async () => (await savedSessions(page))[0]?.messages.find((item: any) => item.generatedImages?.length)?.generatedImages[0]?.sourceTaskId).toBe(taskId);
        await expect(generated(page)).toHaveCount(1);
        const stored = await savedSessions(page), branch = stored[0];
        const resultMessage = branch.messages.find((item: any) => item.generatedImages?.length);
        const result = resultMessage.generatedImages[0];
        const replayedTurn = branch.messages.find((item: any) => item.id === resultMessage.parentMessageId);
        expect(branch.branchOf).toEqual({ sessionId: first.id, messageId: sourceTurn.id });
        expect(replayedTurn.content).toBe(replay === "重新生成" ? sourceTurn.content : editedText);
        expect(replayedTurn.regionSelection).toEqual(sourceTurn.regionSelection);
        expect(result.regionComposite).toEqual(firstResult.regionComposite);
        expect(result).toMatchObject({ sourceTaskId: taskId, sourceResultUrl: `/api/assets/${taskId}/content`, mimeType: "image/png" });
        expect(stored.find(session => session.id === first.id)).toEqual(first);
        assertContract(result.regionComposite, original);
        await verifySubmittedReferences(page, api, result.regionComposite, 1);
        await verifyFinalPixels(page, result);
        expect(plans).toHaveLength(3);
        await page.reload();
        await expect(generated(page)).toHaveCount(1);
        expect((await savedSessions(page))[0].messages.find((item: any) => item.generatedImages?.length).generatedImages[0]).toEqual(result);
        expect(api.submissions).toHaveLength(2);
        expect(plans).toHaveLength(3);
        await page.screenshot({ path: info.outputPath(replay === "重新生成" ? "nano-regenerated-with-selection.png" : "nano-edited-branch-with-selection.png"), animations: "disabled" });
    });
}

test("旧局部结果缺失选区时，重新生成及编辑发送都在模型调用前明确拦截", async ({ page, api }, info) => {
    const { plans } = await prepare(page, api);
    await paintRegion(page);
    await send(page, "只把圈选范围改为纯红色，选区外全部保持原样");
    await expect(generated(page)).toHaveCount(1);
    await expect.poll(async () => (await savedSessions(page))[0]?.messages.find((item: any) => item.generatedImages?.length)?.generatedImages[0]?.storageKey).toMatch(/^image:/);
    const first = (await savedSessions(page))[0];
    const answer = first.messages.find((item: any) => item.generatedImages?.length);
    const sourceTurn = first.messages.find((item: any) => item.id === answer.parentMessageId);
    expect(answer.generatedImages[0].regionComposite.mode).toBe("selection-composite");
    expect(sourceTurn.regionSelection.selection.storageKey).toMatch(/^image:/);
    const database = await page.evaluate(async sessionId => {
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        const ownerId = useUserStore.getState().user!.id;
        return { name: `wireless-canvas:oa:user:${encodeURIComponent(ownerId)}`, recordKey: `wireless-canvas:llm-chat:${ownerId}:session:${encodeURIComponent(sessionId)}` };
    }, first.id);
    // A dedicated seed document prevents the active page's pagehide save from restoring the
    // field. Only this isolated fixture's historic record is changed; no app stores are injected.
    await page.route("**/__chat-region-legacy", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Legacy region fixture</title>" }));
    await page.goto("/__chat-region-legacy");
    await page.evaluate(async ({ database, messageId }) => {
        await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open(database.name);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result, tx = db.transaction("app_state", "readwrite"), store = tx.objectStore("app_state");
                const request = store.get(database.recordKey);
                request.onsuccess = () => {
                    const session = request.result;
                    if (!session?.messages?.some((item: any) => item.id === messageId && item.regionSelection)) { tx.abort(); return; }
                    session.messages = session.messages.map((item: any) => {
                        if (item.id !== messageId) return item;
                        const { regionSelection: _selection, ...legacy } = item;
                        return legacy;
                    });
                    store.put(session, database.recordKey);
                };
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("无法建立缺选区的旧记录 fixture")); };
            };
        });
    }, { database, messageId: sourceTurn.id });
    await page.goto("/chat");
    await expect(generated(page)).toHaveCount(1);
    const legacy = (await savedSessions(page))[0];
    expect(legacy.messages.find((item: any) => item.id === sourceTurn.id)).not.toHaveProperty("regionSelection");
    await page.locator(`[data-message-id="${answer.id}"]`).getByRole("button", { name: "重新生成", exact: true }).click();
    await expect(page.getByText(/重新圈选/).last()).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(plans).toHaveLength(2);
    expect(await savedSessions(page)).toHaveLength(1);
    await page.locator(`[data-message-id="${sourceTurn.id}"]`).getByRole("button", { name: "编辑消息", exact: true }).click();
    await page.getByRole("textbox", { name: "编辑消息", exact: true }).fill("编辑旧要求：只改原选区，不要改外部");
    await page.getByRole("button", { name: "发送为新分支", exact: true }).click();
    await expect(page.getByText(/重新圈选/).last()).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(plans).toHaveLength(2);
    expect(await savedSessions(page)).toHaveLength(1);
    await expect(generated(page)).toHaveCount(1);
    expect((await savedSessions(page))[0].messages.find((item: any) => item.id === answer.id).generatedImages).toEqual(answer.generatedImages);
    await page.screenshot({ path: info.outputPath("nano-legacy-replay-blocked.png"), animations: "disabled" });
});
