import type { BrowserContext, Page, Route } from "@playwright/test";
import { test, expect, newCanvas, uploadImage, IMAGE, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { parseCanvasProject } from "../src/lib/canvas/canvas-project-codec";

type RegionComposite = {
    mode: "selection-composite";
    source: { imageId: string; storageKey: string; width: number; height: number };
    selection: { storageKey: string; width: number; height: number };
};
const placeholder = "理解画布、修改图片或批量编排…";
const panel = (page: Page) => page.locator(".cw-agent-panel");
const canvasMessages = (document: any): any[] => document?.chatSessions?.flatMap((session: any) => session.messages) || [];
const reviewReport = { summary: "方案方向基本符合，袖口仍需按本轮要求核对。", checks: [
    { criterion: "整体款式方向", result: "pass", evidence: "图中仍是同类针织上衣。" },
    { criterion: "袖口造型", result: "warning", evidence: "袖口仍偏宽，建议按原要求收窄。" },
    { criterion: "实际纱线成分", result: "unverifiable", evidence: "图片无法确认真实纱线成分。" },
] };
const reviewResponse = () => ({ content: "", toolCalls: [{ id: "manual-review", type: "function", function: { name: "report_image_review", arguments: JSON.stringify(reviewReport) } }] });
const reviewSection = (page: Page, id: string) => panel(page).locator(`section[data-image-review-id="${id}"]`);

async function savedCanvas(page: Page, projectId: string) {
    const key = JSON.stringify(["wireless-canvas:canvas_store:oa:user:00000000-0000-4000-8000-000000000099:project-documents:v1", projectId]);
    const encoded = await page.evaluate(key => new Promise<string>((resolve, reject) => {
        const open = indexedDB.open("wireless-canvas");
        open.onupgradeneeded = () => { open.transaction?.abort(); reject(new Error("Canvas storage is not initialized")); };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const database = open.result, transaction = database.transaction("app_state", "readonly");
            const request = transaction.objectStore("app_state").get(key);
            let value: unknown;
            request.onsuccess = () => { value = request.result; };
            transaction.oncomplete = () => { database.close(); typeof value === "string" ? resolve(value) : reject(new Error("Missing durable canvas document")); };
            transaction.onabort = transaction.onerror = () => { database.close(); reject(transaction.error); };
        };
    }), key);
    const document = parseCanvasProject(encoded);
    expect(document.id).toBe(projectId);
    return document;
}

async function installAgentFixture(context: BrowserContext, readOnly = false) {
    const plans: any[] = [];
    const models = [
        { id: "region-nano", modelId: "gemini-3.1-flash-image-preview-official", name: "隔离普通编辑模型", protocol: "openai", imageParameterProfile: "resolution", imageSupportsMask: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
        { id: "region-chat", modelId: "test-chat", name: "隔离对话模型", protocol: "openai", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 },
    ];
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? "region-chat" : "region-nano", configurationVersion: 1 })) } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0 } }));
    await context.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); plans.push(body);
        return route.fulfill({ json: readOnly
            ? { content: "已检查显式选中节点，本轮不生成。", toolCalls: [] }
            : { content: "只修改选区，保留外部像素。", toolCalls: [{ id: `region-edit-${plans.length}`, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: body.profileContext.currentUserText, note_update: "选区改红，外部不变", keep: ["选区外全部保持原样"] }) } }] },
        });
    });
    return { plans };
}

async function openConversation(page: Page) {
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(panel(page).getByPlaceholder(placeholder)).toBeEnabled();
}

async function send(page: Page, text: string) {
    const input = panel(page).getByPlaceholder(placeholder);
    await input.fill(text); await input.press("Enter");
}

async function paintRegion(page: Page) {
    await panel(page).getByRole("button", { name: "圈选修改", exact: true }).last().click();
    const dialog = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
    const paint = dialog.getByLabel("修改区域画布", { exact: true });
    await expect(paint).toBeVisible();
    await expect(dialog.getByText(/它不是模型原生蒙版/)).toBeVisible();
    await expect.poll(() => paint.evaluate(canvas => {
        const rect = canvas.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)];
    })).toEqual([460, 460]);
    await expect(dialog).not.toHaveClass(/ant-zoom-(?:enter|appear)/);
    await expect(dialog).toHaveCSS("transform", "none");
    await paint.click({ trial: true });
    const box = (await paint.boundingBox())!;
    await page.mouse.move(box.x + box.width * .42, box.y + box.height * .5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .58, box.y + box.height * .5, { steps: 8 });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "保存选区", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(page).getByText("已圈选局部修改区域", { exact: true })).toBeVisible();
}

async function verifyReferencesAndPixels(page: Page, api: MockCanvasApi, region: RegionComposite, outputStorageKey: string) {
    expect(region).toMatchObject({ mode: "selection-composite", source: { imageId: expect.any(String), storageKey: expect.any(String), width: 256, height: 256 }, selection: { storageKey: expect.any(String), width: 256, height: 256 } });
    expect(region.selection.storageKey).not.toBe(region.source.storageKey);
    expect(api.submissions).toHaveLength(1);
    const submitted = api.submissions[0]!;
    expect(submitted.sourceUrls).toHaveLength(2);
    expect(submitted.parameters.inputArchive.references).toHaveLength(2);
    expect(submitted.parameters.inputArchive.references[0].id).toBe(region.source.imageId);
    expect(submitted.parameters.inputArchive.references[1].id).toMatch(/^selection-guide:/);
    expect(submitted.parameters.inputArchive).not.toHaveProperty("maskReferenceIndex");
    expect(submitted.parameters).not.toHaveProperty("maskReferenceIndex");
    expect(submitted.parameters.hasMask).not.toBe(true);
    expect(submitted.promptInput?.hasMask).not.toBe(true);
    expect(submitted.prompt).toContain("蓝色选区示意，仅用于定位允许修改的区域，不是配色或款式参考");
    expect(submitted.prompt).toContain("不要把蓝色标记画进结果");
    const originalAssetId = new URL(submitted.sourceUrls[0], page.url()).pathname.split("/")[3]!;
    const guideAssetId = new URL(submitted.sourceUrls[1], page.url()).pathname.split("/")[3]!;
    expect(api.assetBytes.get(originalAssetId)?.equals(IMAGE)).toBe(true);
    expect(api.assetBytes.get(guideAssetId)?.equals(IMAGE)).toBe(false);
    const evidence = await page.evaluate(async ({ sourceUrl, guideUrl, region, outputStorageKey }) => {
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const decode = async (blob: Blob) => {
            const bitmap = await createImageBitmap(blob);
            try {
                const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
                const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, canvas.width, canvas.height);
            } finally { bitmap.close(); }
        };
        const stored = async (key: string) => {
            const blob = await getImageBlob(key);
            if (!blob) throw new Error(`选区合成素材未持久化：${key}`);
            return blob;
        };
        const [sourceBlob, selectionBlob, outputBlob] = await Promise.all([stored(region.source.storageKey), stored(region.selection.storageKey), stored(outputStorageKey)]);
        const [original, guide, selection, durableOriginal, edited] = await Promise.all([
            fetch(sourceUrl).then(response => response.blob()).then(decode), fetch(guideUrl).then(response => response.blob()).then(decode),
            decode(selectionBlob), decode(sourceBlob), decode(outputBlob),
        ]);
        let outside = 0, outsideDiff = 0, selected = 0, selectedDiff = 0, guideOutsideDiff = 0, guideInsideDiff = 0, sourceDiff = 0, guideBlue = 0;
        for (let offset = 0; offset < original.data.length; offset += 4) {
            const different = (a: Uint8ClampedArray, b: Uint8ClampedArray) => [0, 1, 2, 3].some(channel => a[offset + channel] !== b[offset + channel]);
            if (different(original.data, durableOriginal.data)) sourceDiff++;
            if (selection.data[offset + 3] === 0) {
                outside++;
                if (different(original.data, edited.data)) outsideDiff++;
                if (different(original.data, guide.data)) guideOutsideDiff++;
            } else {
                if (different(original.data, guide.data)) guideInsideDiff++;
                if (guide.data[offset + 2]! > guide.data[offset]!) guideBlue++;
                if (selection.data[offset + 3] === 255) {
                    selected++;
                    if ([255, 0, 0, 255].some((value, channel) => edited.data[offset + channel] !== value)) selectedDiff++;
                }
            }
        }
        return { mimeType: outputBlob.type, signature: [...new Uint8Array(await outputBlob.slice(0, 8).arrayBuffer())], sourceSize: [original.width, original.height], guideSize: [guide.width, guide.height], selectionSize: [selection.width, selection.height], outputSize: [edited.width, edited.height], outside, outsideDiff, selected, selectedDiff, guideOutsideDiff, guideInsideDiff, sourceDiff, guideBlue };
    }, { sourceUrl: submitted.sourceUrls[0], guideUrl: submitted.sourceUrls[1], region, outputStorageKey });
    expect(evidence).toMatchObject({ mimeType: "image/png", signature: [137, 80, 78, 71, 13, 10, 26, 10], sourceSize: [256, 256], guideSize: [256, 256], selectionSize: [256, 256], outputSize: [256, 256], outsideDiff: 0, selectedDiff: 0, guideOutsideDiff: 0, sourceDiff: 0 });
    expect(evidence.outside).toBeGreaterThan(256 * 256 / 2);
    expect(evidence.selected).toBeGreaterThan(0);
    expect(evidence.guideInsideDiff).toBeGreaterThan(0);
    expect(evidence.guideBlue).toBeGreaterThan(0);
}

for (const mode of ["正常返回", "processing 后刷新查询原任务"] as const) {
    test(`Canvas 普通编辑模型${mode}只回贴选区且不发原生 mask`, async ({ page, context, api }, info) => {
        api.taskStatus = mode === "正常返回" ? "success" : "processing";
        const { plans } = await installAgentFixture(context);
        const id = await newCanvas(page);
        await uploadImage(page, "canvas-region-original.png");
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        const original = structuredClone(api.document(id)!.nodes[0]);
        let acceptedPending: any;
        await context.route("**/api/tasks", async route => {
            if (route.request().method() === "POST") {
                // The production submission guard flushes the local durable document,
                // not a separate cloud PUT. Inspect that record before accepting POST.
                acceptedPending = canvasMessages(await savedCanvas(page, id)).find(message => message.detail?.pendingTask?.regionComposite)?.detail.pendingTask;
            }
            await route.fallback();
        });
        const redPng = await page.evaluate(() => {
            const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
            const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 1024, 1024);
            return canvas.toDataURL("image/png").split(",")[1]!;
        });
        await context.route("**/api/assets/*/content", route => api.tasks.has(new URL(route.request().url()).pathname.split("/")[3]!) ? route.fulfill({ contentType: "image/png", body: Buffer.from(redPng, "base64") }) : route.fallback());
        await openConversation(page);
        await paintRegion(page);
        await send(page, "只把圈选范围改为纯红色，选区外全部保持原样");
        await expect.poll(() => api.submissions.length).toBe(1);
        expect(acceptedPending).toBeDefined();
        const taskId = [...api.tasks.keys()][0]!, savedPending = acceptedPending;
        const region: RegionComposite = savedPending.regionComposite;
        expect(savedPending.maskAdaptation).toBeUndefined();
        expect(region.source.imageId).toBe(plans[0].profileContext.focusImageId);
        if (mode !== "正常返回") {
            await expect.poll(async () => canvasMessages(await savedCanvas(page, id)).find(message => message.detail?.pendingTask)?.detail.pendingTask.taskIds).toEqual([taskId]);
            const pendingBefore = structuredClone(canvasMessages(await savedCanvas(page, id)).find(message => message.detail?.pendingTask).detail.pendingTask);
            await page.reload();
            await openConversation(page);
            const card = panel(page).getByText(`原任务：${taskId}`, { exact: true }).locator("..");
            await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
            expect(canvasMessages(await savedCanvas(page, id)).find(message => message.detail?.pendingTask).detail.pendingTask.regionComposite).toEqual(region);
            expect(api.document(id)!.nodes).toHaveLength(1);
            expect(api.submissions).toHaveLength(1); expect(plans).toHaveLength(1);
            const task = api.tasks.get(taskId)!; task.status = "success"; task.resultUrls = [`/api/assets/${taskId}/content`];
            const reads = api.taskReads.length;
            await card.getByRole("button", { name: "查询原任务", exact: true }).click();
            await expect.poll(() => api.taskReads.length).toBeGreaterThan(reads);
            await expect(panel(page).getByText("已取回原任务结果并放入画布，没有重新生成。", { exact: true })).toBeVisible();
            expect(api.submissions[0].requestId).toBe(pendingBefore.requestId);
        }
        await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
        const completedDocument = await savedCanvas(page, id);
        const result = completedDocument.nodes.find((node: any) => node.id !== original.id)!;
        expect(result.id).toBe(`agent-${taskId}-0`);
        expect(result.metadata!.imageAgent!.parentNodeId).toBe(original.id);
        expect(result.metadata!.serverAssetId).not.toBe(taskId);
        const completed = canvasMessages(completedDocument).find(message => message.attachments?.some((attachment: any) => attachment.id === result.id));
        expect(completed.detail.regionComposite).toEqual(region);
        expect(completed.detail.prompt).toBe(savedPending.prompt);
        expect(completed.detail.prompt).toContain("不要把蓝色标记画进结果");
        await verifyReferencesAndPixels(page, api, region, result.metadata!.storageKey!);
        await page.reload(); await openConversation(page);
        await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
        const restored = await savedCanvas(page, id);
        const restoredMessage = canvasMessages(restored).find(message => message.attachments?.some((attachment: any) => attachment.id === result.id));
        await verifyReferencesAndPixels(page, api, restoredMessage.detail.regionComposite, restored.nodes.find((node: any) => node.id === result.id)!.metadata!.storageKey!);
        expect(api.document(id)!.nodes.find((node: any) => node.id === original.id)).toEqual(original);
        expect(api.submissions).toHaveLength(1); expect(plans).toHaveLength(1);
        await page.screenshot({ path: info.outputPath(mode === "正常返回" ? "canvas-region-composite.png" : "canvas-region-original-task-recovered.png"), animations: "disabled" });
    });
}

function seedDocument(api: MockCanvasApi, id: string, nodes: any[]) {
    const now = new Date().toISOString();
    api.documents.set(id, { id, revision: 1, deleted: false, updatedAt: now,
        document: { id, title: "选中节点上下文验收", createdAt: now, updatedAt: now, nodes, connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null } });
}

test("Canvas 仅显式选中的图片和 Config 带来源 prompt，均限 1000 字", async ({ page, context, api }) => {
    const { plans } = await installAgentFixture(context, true);
    const imagePrompt = `已选图片要求：${"图".repeat(1200)}`, configPrompt = `已选配置草稿：${"配".repeat(1200)}`;
    const privatePrompt = "未选节点的保密提示词绝不能进入对话";
    seedDocument(api, "selected-prompts-iteration", [
        { id: "selected-photo", type: "image", title: "显式选中图片", width: 220, height: 220, position: { x: 580, y: 200 }, metadata: { content: "/api/assets/selected-photo/content", prompt: imagePrompt } },
        { id: "selected-config", type: "config", title: "显式选中配置", width: 480, height: 640, position: { x: 950, y: 150 }, metadata: { generationMode: "image", model: "gemini-3.1-flash-image-preview-official", composerContent: configPrompt } },
        { id: "private-unselected", type: "image", title: "未选中私有图片", width: 200, height: 200, position: { x: 2800, y: 200 }, metadata: { content: "/api/assets/private-unselected/content", prompt: privatePrompt } },
    ]);
    await page.goto("/canvas/selected-prompts-iteration");
    await page.locator('[data-node-id="selected-photo"]').click({ position: { x: 80, y: 80 } });
    await page.locator('[data-node-id="selected-config"]').click({ position: { x: 80, y: 20 }, modifiers: ["Shift"] });
    await expect(page.locator("[data-node-id].is-selected")).toHaveCount(2);
    await openConversation(page);
    await send(page, "只总结已选节点，不生成");
    await expect.poll(() => plans.length).toBe(1);
    const selected = plans[0].profileContext.selectedNodes;
    expect(selected).toEqual([
        { id: "selected-photo", title: "显式选中图片", type: "image", source: "selected-node", prompt: imagePrompt.slice(0, 1000) },
        { id: "selected-config", title: "显式选中配置", type: "config", source: "selected-node", prompt: configPrompt.slice(0, 1000) },
    ]);
    expect(JSON.stringify(plans[0])).not.toContain(privatePrompt);
    expect(JSON.stringify(plans[0])).not.toContain("private-unselected");
    expect(api.submissions).toHaveLength(0);
});

test("Canvas 初始上下文最多携带 12 个显式选中节点，不扩展到其余节点", async ({ page, context, api }) => {
    const { plans } = await installAgentFixture(context, true);
    const nodes = Array.from({ length: 14 }, (_, index) => ({ id: `text-${index}`, type: "text", title: `显式选择${index}`, width: 170, height: 90,
        position: { x: 560 + (index % 5) * 190, y: 140 + Math.floor(index / 5) * 140 }, metadata: { content: `当前说明${index}` } }));
    seedDocument(api, "selected-limit-iteration", nodes);
    await page.goto("/canvas/selected-limit-iteration");
    await page.locator('[data-node-id="text-0"]').click({ position: { x: 30, y: 20 } });
    await page.keyboard.press("Control+a");
    await expect(page.locator("[data-node-id].is-selected")).toHaveCount(14);
    await openConversation(page);
    await send(page, "只总结已选节点，不生成");
    await expect.poll(() => plans.length).toBe(1);
    const selected = plans[0].profileContext.selectedNodes;
    expect(selected).toHaveLength(12);
    expect(selected.map((node: any) => node.id)).toEqual(nodes.slice(0, 12).map(node => node.id));
    expect(selected.every((node: any) => node.source === "selected-node")).toBe(true);
    expect(selected).not.toContainEqual(expect.objectContaining({ id: "text-12" }));
    expect(selected).not.toContainEqual(expect.objectContaining({ id: "text-13" }));
    expect(api.submissions).toHaveLength(0);
});

for (const scenario of [
    { name: "HTTP 422 typed 拒绝后仅修复一次并提交一个图片任务", kind: "repair-once" },
    { name: "连续两次 SSE typed 拒绝最多规划两次且不提交图片", kind: "reject-twice" },
    { name: "HTTP 500 未知错误即使文案相同也不触发规划修复", kind: "unknown-error" },
] as const) {
    test(`Canvas planner ${scenario.name}`, async ({ page, context, api }) => {
        await installAgentFixture(context);
        const requests: any[] = [], submissionsAtPlan: number[] = [];
        const issue = { code: "IMAGE_AGENT_ARGUMENTS_INVALID", message: "规划参数格式无效，本轮未提交生成。", repairable: true, submitted: false };
        await context.route("**/api/chat/responses", route => {
            const body = route.request().postDataJSON(); requests.push(body); submissionsAtPlan.push(api.submissions.length);
            if (scenario.kind === "repair-once" && requests.length > 1) {
                return route.fulfill({ json: { content: "规划已整理，修改当前图片。", toolCalls: [{ id: "repaired-edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: body.profileContext.currentUserText, note_update: "保留原结构，仅改蓝色", keep: ["原有结构与背景不变"] }) } }] } });
            }
            if (scenario.kind === "reject-twice") {
                return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: error\ndata: ${JSON.stringify({ type: "error", error: issue })}\n\n` });
            }
            return route.fulfill({ status: scenario.kind === "unknown-error" ? 500 : 422, json: scenario.kind === "unknown-error"
                ? { error: "INTERNAL_ERROR", message: issue.message }
                : { error: issue.code, message: issue.message, repairable: true, submitted: false } });
        });
        const id = await newCanvas(page);
        await uploadImage(page, "planner-original.png");
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        const original = structuredClone(api.document(id)!.nodes[0]);
        await openConversation(page);
        const requestText = "只把当前图改为浅蓝色，保持原有结构与背景";
        await send(page, requestText);
        if (scenario.kind === "repair-once") {
            await expect.poll(() => api.submissions.length).toBe(1);
            await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
            await expect(panel(page).getByText("1 张图片已生成并放入画布。", { exact: true })).toBeVisible();
            expect(api.document(id)!.nodes.find((node: any) => node.id !== original.id).metadata.imageAgent.parentNodeId).toBe(original.id);
        } else {
            await expect(panel(page).getByText(issue.message, { exact: false }).first()).toBeVisible();
            await expect(panel(page).getByRole("button", { name: "发送", exact: true })).toBeVisible();
            expect(api.submissions).toHaveLength(0);
            expect(api.document(id)!.nodes).toEqual([original]);
        }
        const expectedPlans = scenario.kind === "unknown-error" ? 1 : 2;
        expect(requests).toHaveLength(expectedPlans);
        expect(submissionsAtPlan).toEqual(Array(expectedPlans).fill(0));
        expect(requests[0].profileContext.stage).toBe("plan");
        expect(requests[0].profileContext.repairIssue).toBeUndefined();
        if (expectedPlans === 2) {
            expect(requests[1].profileContext.stage).toBe("repair");
            expect(requests[1].profileContext.repairIssue).toEqual(issue);
            for (const field of ["currentUserText", "focusImageId", "lockedImageId", "previewImageIds", "selectedNodes"]) {
                expect(requests[1].profileContext[field]).toEqual(requests[0].profileContext[field]);
            }
            expect(requests[1].profileContext.currentUserText).toBe(requestText);
        }
        expect(api.batchSubmissions).toHaveLength(0);
    });
}

test("Canvas planner 本地无效 edit_spec 仅修复一次，保存本版规格并在刷新后按版本传入", async ({ page, context, api }) => {
    await installAgentFixture(context);
    const requests: any[] = [], submissionsAtPlan: number[] = [];
    let validSpec: any;
    await context.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); requests.push(body); submissionsAtPlan.push(api.submissions.length);
        if (requests.length > 2) return route.fulfill({ json: { content: "仅查看当前版本保存的修改要求，没有重新生成。", toolCalls: [] } });
        validSpec = { changes: ["领口改为 V 领"], region: "领口", reference_roles: [{ image_id: body.profileContext.focusImageId, role: "base", purpose: "沿用原版针织衫主体与纹理" }], acceptance: ["领口呈 V 形，针织纹理保持"], assumptions: ["本轮只改变领口"] };
        const edit = { id: `local-spec-${requests.length}`, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: body.profileContext.currentUserText, note_update: "领口改为 V 领，保留针织纹理", keep: ["针织纹理与背景保持"], edit_spec: requests.length === 1 ? { changes: [] } : validSpec }) } };
        return route.fulfill({ json: { content: "准备修改领口。", toolCalls: requests.length === 1
            ? [{ id: "must-not-create", type: "function", function: { name: "canvas_create_text_node", arguments: JSON.stringify({ title: "无效规划不能创建", text: "INVALID_SPEC_MUST_NOT_CREATE" }) } }, edit]
            : [edit] } });
    });
    const id = await newCanvas(page);
    await uploadImage(page, "local-spec-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const originalId = api.document(id)!.nodes[0].id;
    await openConversation(page);
    await send(page, "只把领口改为 V 领，针织纹理与背景保持");
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(requests).toHaveLength(2);
    expect(submissionsAtPlan).toEqual([0, 0]);
    expect(requests[0].profileContext.stage).toBe("plan");
    expect(requests[1].profileContext).toMatchObject({ stage: "repair", repairIssue: { code: "IMAGE_AGENT_SPEC_INVALID", repairable: true, submitted: false } });
    expect(requests[1].profileContext.repairIssue.message.length).toBeLessThanOrEqual(1000);
    expect(requests[1].profileContext.focusImageId).toBe(requests[0].profileContext.focusImageId);
    const document = await savedCanvas(page, id);
    const result = document.nodes.find(node => node.id !== originalId)!;
    expect(result.metadata!.imageAgent!.spec).toEqual(validSpec);
    expect(canvasMessages(document).find(message => message.attachments?.some((attachment: any) => attachment.id === result.id)).detail.imageAgent.spec).toEqual(validSpec);
    expect(document.nodes.some(node => node.metadata?.content === "INVALID_SPEC_MUST_NOT_CREATE")).toBe(false);
    expect(api.submissions[0].prompt).toContain("本轮具体变化：");
    expect(api.submissions[0].prompt).toContain("领口改为 V 领");
    expect(api.submissions[0].prompt).toContain("图片分工：");
    expect(api.submissions[0].prompt).toContain("结果应满足：");
    const inspectVisibleSpec = async () => {
        await panel(page).getByText("最终提示词", { exact: true }).click();
        const requirements = panel(page).getByRole("region", { name: "本轮要求与假设", exact: true });
        await expect(requirements).toBeVisible();
        await expect(requirements.getByText("本轮要求与假设（待核对）", { exact: true })).toBeVisible();
        await expect(requirements).toContainText("本轮修改：领口改为 V 领");
        await expect(requirements).toContainText("待核对：领口呈 V 形，针织纹理保持");
        await expect(requirements).toContainText("本轮假设：本轮只改变领口");
        await expect(requirements.getByText("以上是本轮规划要求，不代表结果已通过视觉检查。", { exact: true })).toBeVisible();
    };
    await inspectVisibleSpec();
    await page.reload(); await openConversation(page);
    expect((await savedCanvas(page, id)).nodes.find(node => node.id === result.id)!.metadata!.imageAgent!.spec).toEqual(validSpec);
    await inspectVisibleSpec();
    await send(page, "只检查当前版本保存的要求，不再生成");
    await expect(panel(page).getByText("仅查看当前版本保存的修改要求，没有重新生成。", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(3);
    const catalog = requests[2].profileContext.imageCatalog;
    const briefs = catalog.filter((image: any) => image.designBrief);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].id).toContain(result.id);
    expect(briefs[0].designBrief).toContain("本轮修改：领口改为 V 领");
    expect(briefs[0].designBrief).toContain("待核对：领口呈 V 形，针织纹理保持");
    expect(briefs[0].designBrief.length).toBeLessThanOrEqual(1600);
    expect(catalog.find((image: any) => image.id === requests[0].profileContext.focusImageId)?.designBrief).toBeUndefined();
    expect(api.submissions).toHaveLength(1);
    expect(submissionsAtPlan).toEqual([0, 0, 1]);
});

test("Canvas review 仅手动检查、逐项报告持久化，纠正保留草稿并锁定实际 parent 与辅助参考", async ({ page, context, api }, info) => {
    await installAgentFixture(context);
    const requests: any[] = [];
    let editCount = 0;
    await context.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.profileContext.stage === "review") return route.fulfill({ json: reviewResponse() });
        editCount++;
        const reference = body.profileContext.imageCatalog.find((image: any) => image.id !== body.profileContext.focusImageId && body.profileContext.previewImageIds.includes(image.id));
        return route.fulfill({ json: { content: "按当前方案继续修改，完成后可手动检查。", toolCalls: [{ id: `review-edit-${editCount}`, type: "function", function: { name: "edit_image", arguments: JSON.stringify({
            prompt: body.profileContext.currentUserText, note_update: "保留款式方向，收窄袖口", keep: ["整体款式方向保持"],
            ...(editCount === 2 && reference ? { references: [reference.id] } : {}),
            edit_spec: { changes: ["收窄袖口"], acceptance: ["袖口造型收窄", "整体款式方向保持"], assumptions: ["不代表实际纱线成分已确认"] },
        }) } }] } });
    });
    const id = await newCanvas(page);
    await uploadImage(page, "review-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await openConversation(page);
    await send(page, "第一轮，沿用原图开发针织上衣方案");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    await expect(panel(page).getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await send(page, "在上一轮方案上收窄袖口，保留整体款式方向");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(3);
    await expect(panel(page).getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const before = await savedCanvas(page, id);
    const completed = canvasMessages(before).filter(message => message.detail?.kind === "agent_generation" && message.detail.status === "completed");
    expect(completed).toHaveLength(2);
    const resultMessage = completed[1], result = resultMessage.attachments[0], record = resultMessage.detail.imageAgent;
    expect(record.baseImageId).toContain(completed[0].attachments[0].id);
    expect(record.referenceIds).toHaveLength(2);
    expect(requests).toHaveLength(2);
    const section = reviewSection(page, result.id);
    await expect(section.getByRole("button", { name: "检查结果", exact: true })).toBeVisible();
    await expect(section.getByRole("status")).toHaveCount(0);
    // Ordinary canvas selection remains available, but review always uses the recorded parent.
    await page.locator(`[data-node-id="${before.nodes[0].id}"]`).click({ position: { x: 80, y: 80 } });
    await expect(page.locator(`[data-node-id="${before.nodes[0].id}"]`)).toHaveClass(/is-selected/);
    await section.getByRole("button", { name: "检查结果", exact: true }).click();
    await expect(section.getByRole("status")).toContainText(reviewReport.summary);
    for (const text of ["可见符合 · 整体款式方向", "发现偏差 · 袖口造型", "无法确认 · 实际纱线成分", "视觉辅助检查，不是像素或生产验收认证。"]) await expect(section).toContainText(text);
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: info.outputPath("canvas-review-report.png"), animations: "disabled" });
    expect(requests).toHaveLength(3);
    const inspected = requests[2];
    expect(inspected.toolKey).toBe("canvas-chat");
    expect(inspected.profile).toBe("canvas-assistant");
    expect(inspected.profileContext).toMatchObject({ stage: "review", focusImageId: `chat-image:${resultMessage.id}:result:${result.id}`, reviewContext: { baseImageId: record.baseImageId, resultImageId: `chat-image:${resultMessage.id}:result:${result.id}`, prompt: resultMessage.detail.prompt, spec: record.spec } });
    expect(inspected.profileContext.previewImageIds).toEqual([record.baseImageId, `chat-image:${resultMessage.id}:result:${result.id}`]);
    await expect(panel(page).locator("[data-image-agent-focus]")).toHaveCount(0);
    await expect.poll(async () => canvasMessages(await savedCanvas(page, id)).find(message => message.id === resultMessage.id)?.attachments[0].imageReview?.report).toEqual(reviewReport);
    const savedReview = canvasMessages(await savedCanvas(page, id)).find(message => message.id === resultMessage.id).attachments[0].imageReview;
    expect(savedReview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isFinite(Date.parse(savedReview.reviewedAt))).toBe(true);
    expect(api.submissions).toHaveLength(2);
    await expect.poll(() => canvasMessages(api.document(id)).find(message => message.id === resultMessage.id)?.attachments[0].imageReview?.report).toEqual(reviewReport);
    await page.reload(); await openConversation(page);
    const restoredMatches = await page.evaluate(async ({ document, messageId, attachmentId }) => {
        const { canvasImageAgentReviewTarget, canvasImageAgentReviewMatches } = await import("/src/lib/canvas/canvas-image-agent.ts");
        const target = canvasImageAgentReviewTarget(document.chatSessions.flatMap((session: any) => session.messages), document.nodes, messageId, attachmentId);
        return canvasImageAgentReviewMatches(target, target.message.attachments.find((item: any) => item.id === attachmentId).imageReview);
    }, { document: await savedCanvas(page, id), messageId: resultMessage.id, attachmentId: result.id });
    expect(restoredMatches).toBe(true);
    await expect(section.getByRole("status")).toContainText(reviewReport.summary);
    expect(requests).toHaveLength(3);
    const input = panel(page).getByPlaceholder(placeholder), correction = section.getByRole("button", { name: "根据问题创建纠正草稿", exact: true });
    await input.fill("保留我的方案讨论草稿"); await correction.click();
    await expect(input).toHaveValue("保留我的方案讨论草稿");
    await expect(section.getByRole("alert")).toContainText("当前已有草稿，未覆盖。");
    await input.fill(""); await correction.click();
    await expect(input).toHaveValue(/袖口仍偏宽/);
    await expect(input).toHaveValue(/原修改要求/);
    await expect(input).not.toHaveValue(/图片无法确认真实纱线成分/);
    await expect.poll(async () => (await savedCanvas(page, id)).chatSessions.find((session: any) => session.id === before.activeChatId)?.focusImageId).toBe(record.baseImageId);
    await expect(panel(page).locator("[data-image-agent-focus]")).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: /^移除参考图 / })).toHaveCount(2);
    expect(requests).toHaveLength(3); expect(api.submissions).toHaveLength(2); expect(api.batchSubmissions).toHaveLength(0);
    expect((await savedCanvas(page, id)).nodes).toEqual(before.nodes);
    await page.screenshot({ path: info.outputPath("canvas-manual-review-correction.png"), animations: "disabled" });
});

test("Canvas conversation-only current previous original and refresh keep exact parents without target buttons", async ({ page, context, api }, info) => {
    await installAgentFixture(context);
    const requests: any[] = [];
    await context.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); requests.push(body);
        const text = body.profileContext.currentUserText;
        if (text === "这几张哪个更好，先讨论") return route.fulfill({ json: { content: "你想比较颜色还是轮廓？我们先讨论，不出图。", toolCalls: [] } });
        const base = text.includes("回上一版") ? "previous" : text.includes("从原图") ? "original" : "focus";
        return route.fulfill({ json: { content: "好的，按你这一轮的要求修改。", toolCalls: [{ id: `conversation-edit-${requests.length}`, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ base, prompt: text }) } }] } });
    });
    const id = await newCanvas(page);
    await uploadImage(page, "conversation-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const originalNodeId = api.document(id)!.nodes[0].id;
    await openConversation(page);
    const assertSimple = async () => {
        await expect(panel(page).locator("[data-image-agent-focus]")).toHaveCount(0);
        await expect(panel(page).getByRole("group", { name: "选择要修改的图片", exact: true })).toHaveCount(0);
        await expect(panel(page).locator('[data-testid="canvas-agent-image-current"]')).toHaveCount(0);
        await expect(panel(page).getByRole("button", { name: /^(基于这张继续改|继续改这张|回到原图|回原图|仅参考|原图)$/ })).toHaveCount(0);
    };
    const prompts = ["背景改成海边", "在这版上把衣服改成红色", "回上一版，只把衣服改蓝色", "从原图重来，背景海边、衣服红色"];
    const results: Array<{ nodeId: string; imageId: string; baseId: string }> = [];
    for (const [index, text] of prompts.entries()) {
        await assertSimple(); await send(page, text);
        await expect.poll(() => api.submissions.length).toBe(index + 1);
        await expect.poll(() => api.document(id)?.nodes.length).toBe(index + 2);
        await expect(panel(page).getByRole("button", { name: "发送", exact: true })).toBeVisible();
        const document = await savedCanvas(page, id);
        const message = canvasMessages(document).filter(message => message.detail?.kind === "agent_generation" && message.detail.status === "completed").at(-1)!;
        const nodeId = message.attachments[0].id, imageId = `chat-image:${message.id}:result:${nodeId}`, baseId = message.detail.imageAgent.baseImageId;
        const expectedNodeId = index === 0 || index === 3 ? originalNodeId : results[0].nodeId;
        expect(document.nodes.find(node => node.id === nodeId)?.metadata?.imageAgent?.parentNodeId).toBe(expectedNodeId);
        expect(api.submissions[index].parameters.inputArchive.references[0].id).toBe(baseId);
        expect(api.submissions[index].parameters.inputArchive.references).toHaveLength(1);
        expect(requests[index].profileContext.lockedImageId).toBeUndefined();
        if (index === 1 || index === 2) expect(baseId).toBe(results[0].imageId);
        if (index === 3) expect(baseId).toBe(results[0].baseId);
        results.push({ nodeId, imageId, baseId });
    }
    await page.reload(); await openConversation(page); await assertSimple();
    await send(page, "刷新后继续把海面颜色调淡");
    await expect.poll(() => api.submissions.length).toBe(5);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(6);
    await expect(panel(page).getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const restored = await savedCanvas(page, id);
    const last = canvasMessages(restored).filter(message => message.detail?.kind === "agent_generation" && message.detail.status === "completed").at(-1)!;
    expect(last.detail.imageAgent.baseImageId).toBe(results[3].imageId);
    expect(restored.nodes.find(node => node.id === last.attachments[0].id)?.metadata?.imageAgent?.parentNodeId).toBe(results[3].nodeId);
    expect(api.submissions[4].parameters.inputArchive.references).toHaveLength(1);
    expect(api.submissions[4].parameters.inputArchive.references[0].id).toBe(results[3].imageId);
    await send(page, "这几张哪个更好，先讨论");
    await expect(panel(page).getByText("你想比较颜色还是轮廓？我们先讨论，不出图。", { exact: true })).toBeVisible();
    await assertSimple(); expect(api.submissions).toHaveLength(5); expect(requests).toHaveLength(6);
    await page.screenshot({ path: info.outputPath("canvas-conversation-only.png"), animations: "disabled" });
});

for (const destination of ["session", "owner", "project"] as const) test(`Canvas review 切换 ${destination} 后迟到报告不回写也不出图`, async ({ page, context, api }) => {
    await installAgentFixture(context);
    const requests: any[] = []; let held: Route | undefined;
    await context.route("**/api/chat/responses", route => {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.profileContext.stage === "review") { held = route; return; }
        return route.fulfill({ json: { content: "完成本轮方案。", toolCalls: [{ id: "scope-edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: body.profileContext.currentUserText }) } }] } });
    });
    const id = await newCanvas(page);
    await uploadImage(page, `review-${destination}-original.png`);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await openConversation(page); await send(page, "沿用原版开发新的针织方案");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    await expect(panel(page).getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const original = await savedCanvas(page, id);
    const completed = canvasMessages(original).find(message => message.detail?.kind === "agent_generation" && message.detail.status === "completed");
    await reviewSection(page, completed.attachments[0].id).getByRole("button", { name: "检查结果", exact: true }).click();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (destination === "session") {
        await panel(page).getByRole("button", { name: "新对话", exact: true }).first().click();
        await expect(panel(page).locator("[data-image-review-id]")).toHaveCount(0);
    } else if (destination === "project") {
        await newCanvas(page); await openConversation(page);
        await expect(panel(page).locator("[data-image-review-id]")).toHaveCount(0);
    } else {
        let reads = 0;
        await context.route("**/api/auth/session", route => { reads++; return route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }); });
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => reads).toBeGreaterThan(0);
        await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
    }
    await held!.fulfill({ json: reviewResponse() }).catch(() => undefined);
    if (destination === "owner") await context.unroute("**/api/auth/session");
    // Return through the real route and authenticated load; no store mutation.
    await page.goto(`/canvas/${id}`); await openConversation(page);
    const restored = await savedCanvas(page, id);
    expect(canvasMessages(restored).some(message => message.attachments?.some((attachment: any) => attachment.imageReview))).toBe(false);
    expect(restored.nodes).toEqual(original.nodes);
    expect(requests).toHaveLength(2); expect(api.submissions).toHaveLength(1); expect(api.batchSubmissions).toHaveLength(0);
});
