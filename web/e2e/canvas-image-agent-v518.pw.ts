import type { BrowserContext, Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { test, expect, fixturePng, newCanvas, uploadImage, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const placeholder = "理解画布、修改图片或批量编排…";
async function fixture(context: BrowserContext, supportsMask = true) {
    const requests: any[] = [];
    let reply: (route: Route, request: any) => Promise<void> = (route, input) => route.fulfill({ json: { content: "准备修改当前图", toolCalls: [{ id: `edit-${requests.length}`, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ base: input.profileContext.currentUserText.includes("上一版") ? "previous" : input.profileContext.currentUserText.includes("原版") ? "original" : "focus", prompt: input.profileContext.currentUserText, note_update: input.profileContext.currentUserText }) } }] } });
    const models = [
        { id: "test-image", modelId: "gpt-image-2", name: "隔离图片", protocol: "openai", imageParameterProfile: "standard", imageSupportsMask: supportsMask, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 },
        { id: "test-chat", modelId: "test-chat", name: "隔离对话", protocol: "openai", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 },
    ];
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? "test-chat" : "test-image", configurationVersion: 1 })) } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    await context.route("**/api/chat/responses", route => { const input = route.request().postDataJSON(); requests.push(input); return reply(route, input); });
    return { requests, setReply: (next: typeof reply) => { reply = next; } };
}

/** Saved test-only cloud history: 1→2→3, 2→4, 1→5; no app store injection. */
function historicalBranch(api: MockCanvasApi) {
    const project = "historical-branch-repair", sessionId = "historical-branch-session", now = "2026-11-08T00:00:00.000Z";
    const nodeId = (version: number) => `branch-v${version}`;
    const assetId = (version: number) => `73000000-0000-4000-8000-${String(version).padStart(12, "0")}`;
    const url = (version: number) => `/api/assets/${assetId(version)}/content`;
    const imageId = (version: number): string => version === 1 ? `chat-image:branch-upload:reference:0:${nodeId(1)}` : `chat-image:branch-message-${version}:result:${nodeId(version)}`;
    const parent = (version: number) => version === 2 || version === 5 ? 1 : 2;
    const note = (version: number) => ({ summary: `版本${version}`, keep: version === 3 ? ["森林绿包身和肩带", "浅暖灰背景"] : [`其他分支${version}`] });
    const bytes = Array.from({ length: 5 }, (_, index) => fixturePng(20 + index * 40));
    for (const [index, data] of bytes.entries()) api.assetBytes.set(assetId(index + 1), data);
    const nodes = Array.from({ length: 5 }, (_, index) => {
        const version = index + 1;
        return { id: nodeId(version), type: "image", title: `包版本${version}`, position: { x: index * 230, y: 50 }, width: 180, height: 180,
            metadata: { content: url(version), status: "success", naturalWidth: 256, naturalHeight: 256, mimeType: "image/png",
                ...(version > 1 ? { imageAgent: { parentNodeId: nodeId(parent(version)), workId: imageId(1), version, note: note(version) } } : {}) } };
    });
    const messages = [{ id: "branch-upload", role: "user", text: "原包", references: [{ id: nodeId(1), type: "image", title: "原包", dataUrl: url(1) }] },
        ...[2, 3, 4, 5].map(version => ({ id: `branch-message-${version}`, role: "assistant", text: `版本${version}已生成`,
            attachments: [{ id: nodeId(version), name: `版本${version}`, mediaType: "image", url: url(version) }],
            detail: { kind: "agent_generation", status: "completed", prompt: version === 3 ? "森林绿包身和肩带、浅暖灰背景、金色连接环" : `其他版本${version}`,
                imageAgent: { baseImageId: imageId(parent(version)), sourceNodeId: nodeId(parent(version)), workId: imageId(1),
                    referenceIds: [imageId(parent(version))], version, note: note(version) } } })),
    ];
    const document = { id: project, title: "历史分支修复隔离回归", createdAt: now, updatedAt: now, nodes,
        connections: [2, 3, 4, 5].map(version => ({ id: `branch-edge-${version}`, fromNodeId: nodeId(parent(version)), toNodeId: nodeId(version) })), groups: [],
        chatSessions: [{ id: sessionId, title: "五版包历史", createdAt: now, updatedAt: now, messages, focusImageId: imageId(5), focusRevision: 5 }],
        activeChatId: sessionId, backgroundMode: "dots", showImageInfo: false, viewport: { x: 180, y: 100, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    api.documents.set(project, { id: project, revision: 1, document, deleted: false, updatedAt: now });
    return { project, sessionId, imageId, nodeId, url, bytes, original: structuredClone(document) };
}

for (const failPreview of [false, true]) {
    test(`historical branch repair ${failPreview ? "stops before replanning when image 3 cannot load" : "loads exact image 3 pixels before one edit submission"}`, async ({ page, context, api }, info) => {
        const chat = await fixture(context), branch = historicalBranch(api);
        const prompt = "以图3为基础，只把两侧连接环从金色改成银色。保留图3的森林绿包身和肩带、浅暖灰背景，以及原有包型，生成一张。";
        const order: string[] = [];
        page.on("request", request => {
            if (request.method() !== "POST") return;
            const path = new URL(request.url()).pathname;
            if (path === "/api/chat/responses") order.push("agent");
            if (path === "/api/tasks") order.push("image");
        });
        let failOriginal = false, failedReads = 0;
        await context.route(`**${branch.url(3)}`, route => {
            if (!failOriginal) return route.fallback();
            failedReads++;
            return route.fulfill({ status: 404, contentType: "text/plain", body: "isolated missing original" });
        });
        chat.setReply((route, request) => {
            if (failPreview && request.profileContext.stage === "plan") failOriginal = true;
            return route.fulfill({ json: { content: "只修改图3的连接环", toolCalls: [{ id: `historical-edit-${chat.requests.length}`, type: "function",
                function: { name: "edit_image", arguments: JSON.stringify({ base: branch.imageId(3), prompt }) } }] } });
        });
        await page.goto(`/canvas/${branch.project}`);
        await page.getByRole("tab", { name: "对话", exact: true }).first().click();
        const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
        await expect(panel.getByTestId("canvas-agent-image-result")).toHaveCount(4);
        await input.fill(prompt); await input.press("Enter");
        if (failPreview) {
            await expect(panel.getByText("画布媒体不可读取", { exact: true })).toBeVisible();
            await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
            expect(failedReads).toBeGreaterThan(0);
            expect(order).toEqual(["agent"]);
            expect(chat.requests).toHaveLength(1);
            expect(api.submissions).toHaveLength(0);
            expect(api.document(branch.project)!.nodes).toHaveLength(5);
            expect(api.document(branch.project)!.chatSessions[0].focusImageId).toBe(branch.imageId(5));
            await expect(panel.getByText("本轮助手看到了 2 张图片（图5、图1）", { exact: true })).toBeVisible();
            await expect(panel.getByText("本轮助手看到了 3 张图片（图3、图5、图1）", { exact: true })).toHaveCount(0);
            await expect.poll(() => api.document(branch.project)!.chatSessions[0].messages
                .find((message: any) => message.role === "user" && message.text === prompt)?.detail?.previewImageIds)
                .toEqual([branch.imageId(5), branch.imageId(1)]);
            await expect(input).toHaveValue(prompt);
            await expect.poll(() => api.document(branch.project)!.chatSessions[0].messages
                .filter((message: any) => message.role === "error").map((message: any) => ({ title: message.title, text: message.text })))
                .toEqual([{ title: "操作失败", text: "画布媒体不可读取" }]);
            await page.reload();
            await page.getByRole("tab", { name: "对话", exact: true }).first().click();
            await expect(panel.getByText("画布媒体不可读取", { exact: true })).toBeVisible();
            expect(chat.requests).toHaveLength(1);
            expect(api.submissions).toHaveLength(0);
        } else {
            await expect.poll(() => api.submissions.length).toBe(1);
            await expect.poll(() => api.document(branch.project)?.nodes.length).toBe(6);
            await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
            expect(order).toEqual(["agent", "agent", "image"]);
            expect(chat.requests).toHaveLength(2);
            const [initial, repair] = chat.requests;
            expect(initial.profileContext.previewImageIds).toEqual([branch.imageId(5), branch.imageId(1)]);
            expect(repair.profileContext).toMatchObject({ stage: "repair", focusImageId: branch.imageId(5),
                previewImageIds: [branch.imageId(3), branch.imageId(5), branch.imageId(1)], repairIssue: { code: "IMAGE_AGENT_UNPREVIEWED_IMAGE", submitted: false } });
            expect(repair.profileContext.imageCatalog.find((image: any) => image.id === branch.imageId(3))).toMatchObject({ previewed: true, parentId: branch.imageId(2) });
            const expectedPreviews = await page.evaluate(async sources => Promise.all(sources.map(async source => {
                const image = new Image(); image.src = source; await image.decode();
                const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
                const drawing = canvas.getContext("2d")!; drawing.fillStyle = "#fff"; drawing.fillRect(0, 0, canvas.width, canvas.height); drawing.drawImage(image, 0, 0);
                return canvas.toDataURL("image/jpeg", 0.85);
            })), branch.bytes.map(bytes => `data:image/png;base64,${bytes.toString("base64")}`));
            const previews = (request: any) => request.input.flatMap((message: any) => Array.isArray(message.content)
                ? message.content.filter((part: any) => part.type === "input_image").map((part: any) => part.image_url) : []);
            expect(previews(initial)).toEqual([expectedPreviews[4], expectedPreviews[0]]);
            expect(previews(repair)).toEqual([expectedPreviews[2], expectedPreviews[4], expectedPreviews[0]]);
            expect(repair.input.at(-1).content).toContain(prompt);
            const submitted = api.submissions[0], reference = submitted.parameters.inputArchive.references[0];
            expect(submitted.operationType).toBe("inpaint");
            expect(submitted.parameters.imageAgentProfile).toBe("canvas-assistant");
            expect(submitted.parameters.inputArchive.references).toHaveLength(1);
            expect(reference.id).toBe(branch.imageId(3));
            expect(reference.sha256).toBe(createHash("sha256").update(branch.bytes[2]).digest("hex"));
            expect(submitted.sourceUrls).toHaveLength(1);
            const document = api.document(branch.project)!;
            const added = document.nodes.find((node: any) => !branch.original.nodes.some(original => original.id === node.id));
            expect(added.metadata.imageAgent).toMatchObject({ parentNodeId: branch.nodeId(3), workId: branch.imageId(1), version: 6 });
            expect(document.connections.some((edge: any) => edge.fromNodeId === branch.nodeId(3) && edge.toNodeId === added.id)).toBe(true);
            const saved = document.chatSessions[0].messages.findLast((message: any) => message.detail?.kind === "agent_generation");
            expect(saved.detail.imageAgent).toMatchObject({ baseImageId: branch.imageId(3), referenceIds: [branch.imageId(3)], sourceNodeId: branch.nodeId(3) });
            expect(document.nodes.slice(0, 5)).toEqual(branch.original.nodes);
            await expect(panel.getByText(/需要先查看指定图片|IMAGE_AGENT_UNPREVIEWED_IMAGE|操作失败/)).toHaveCount(0);
            await expect(panel.getByText("本轮助手看到了 3 张图片（图3、图5、图1）", { exact: true })).toBeVisible();
            await expect(panel.getByText("本轮助手看到了 2 张图片（图5、图1）", { exact: true })).toHaveCount(0);
            const userMessage = document.chatSessions[0].messages.find((message: any) => message.role === "user" && message.text === prompt);
            expect(userMessage.detail).toMatchObject({ previewImageIds: [branch.imageId(3), branch.imageId(5), branch.imageId(1)], conversationContext: { images: 3 } });
            expect(userMessage.contextReferences.map((reference: any) => reference.id)).toEqual([branch.imageId(5), branch.imageId(1)]);
        }
        expect(chat.requests[0].profileContext.previewImageIds).toEqual([branch.imageId(5), branch.imageId(1)]);
        expect(api.batchSubmissions).toHaveLength(0);
        await page.screenshot({ path: info.outputPath(`historical-branch-${failPreview ? "missing-original" : "repaired"}.png`), animations: "disabled" });
        await info.attach("historical-branch-evidence", { contentType: "application/json", body: Buffer.from(JSON.stringify({
            mode: failPreview ? "missing-original" : "success", order, plannerCalls: chat.requests.length, imageSubmissions: api.submissions.length,
            previewImageIds: chat.requests.map(request => request.profileContext.previewImageIds), failedReads,
            baseImageId: api.submissions[0]?.parameters.inputArchive.references[0]?.id,
            originalSha256: createHash("sha256").update(branch.bytes[2]).digest("hex"), submittedSha256: api.submissions[0]?.parameters.inputArchive.references[0]?.sha256,
        }, null, 2)) });
    });
}

// Department admins have no canvas workspace access; their component guard is
// covered by the unit test without bypassing the production route restriction.
for (const role of ["designer", "super_admin"] as const) {
    test(`developer controls default hidden and deletion still confirms for ${role}`, async ({ page, context, api }, info) => {
        api.role = role;
        const chat = await fixture(context);
        const id = await newCanvas(page);
        await page.getByRole("tab", { name: "对话", exact: true }).first().click();
        const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
        await panel.getByRole("button", { name: "对话选项", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: /^开发者选项/ })).toHaveCount(role === "super_admin" ? 1 : 0);
        await page.keyboard.press("Escape");
        // The read step also exercises confirmation decisions in the continuation path.
        chat.setReply(route => route.fulfill({ json: { content: "", toolCalls: [{ id: `write-${chat.requests.length}`, type: "function", function: chat.requests.length === 1
            ? { name: "canvas_get_state", arguments: "{}" }
            : { name: "canvas_create_text_node", arguments: JSON.stringify({ text: "保留中文说明", title: "待确认的说明" }) } }] } }));
        await input.fill("读取画布并创建文字说明"); await input.press("Enter");
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toHaveCount(0);
        expect(chat.requests).toHaveLength(2);
        const node = api.document(id)!.nodes[0];
        chat.setReply(route => route.fulfill({ json: { content: "", toolCalls: [{ id: "delete-test", type: "function", function: { name: "canvas_delete_nodes", arguments: JSON.stringify({ ids: [node.id] }) } }] } }));
        await input.fill("删除刚才的说明节点"); await input.press("Enter");
        await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toBeVisible();
        await expect(panel.getByText("将删除 1 个对象", { exact: true })).toBeVisible();
        await expect(panel.getByText(node.title, { exact: true })).toBeVisible();
        await expect(panel.locator("pre, details:not([data-testid='conversation-examples'])")).toHaveCount(0);
        expect(api.document(id)?.nodes).toHaveLength(1);
        await page.screenshot({ path: info.outputPath(`${role}-deletion-default.png`), animations: "disabled" });
        await panel.getByRole("button", { name: "批准执行", exact: true }).click();
        await expect.poll(() => api.document(id)?.nodes.length).toBe(0);
        expect(api.submissions).toHaveLength(0);
    });
}

test("developer detail opt-in and extra confirmation are separate administrator controls", async ({ page, context, api }, info) => {
    api.role = "super_admin";
    const chat = await fixture(context), id = await newCanvas(page);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    const developerOption = async (label: string) => {
        await panel.getByRole("button", { name: "对话选项", exact: true }).click();
        await page.getByRole("menuitem", { name: /^开发者选项/ }).hover();
        await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    await developerOption("开启非删除操作确认");
    chat.setReply(route => route.fulfill({ json: { content: "", toolCalls: [{ id: "create-confirmed", type: "function", function: { name: "canvas_create_text_node", arguments: JSON.stringify({ text: "需管理员确认", title: "调试说明" }) } }] } }));
    await input.fill("创建文字说明"); await input.press("Enter");
    await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toBeVisible();
    await expect(panel.getByTestId("canvas-agent-tool-detail")).toHaveCount(0);
    await expect(panel.locator("details:not([data-testid='conversation-examples'])")).toHaveCount(0);
    expect(api.document(id)?.nodes || []).toHaveLength(0);
    await developerOption("显示工具详情");
    await expect(panel.locator("details:not([data-testid='conversation-examples'])")).toHaveCount(1);
    await panel.locator("details:not([data-testid='conversation-examples']) > summary").click();
    await expect(panel.getByTestId("canvas-agent-tool-detail")).toBeVisible();
    await expect(panel.getByTestId("canvas-agent-tool-detail")).toContainText('"status": "pending"');
    await page.screenshot({ path: info.outputPath("admin-developer-details-enabled.png"), animations: "disabled" });
    await developerOption("隐藏工具详情");
    await expect(panel.locator("pre, details:not([data-testid='conversation-examples'])")).toHaveCount(0);
    await panel.getByRole("button", { name: "拒绝执行", exact: true }).click();
    await expect(panel.getByRole("button", { name: "批准执行", exact: true })).toHaveCount(0);
    expect(api.document(id)?.nodes || []).toHaveLength(0);
    expect(api.submissions).toHaveLength(0);
});

test("current image persists through continuous edits, previous/original and selected old branches", async ({ page, context, api }, info) => {
    const chat = await fixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "knitwear.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = api.document(id)!.nodes[0];
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    const send = async (text: string, count: number) => {
        await input.fill(text); await input.press("Enter");
        await expect.poll(() => api.submissions.length).toBe(count);
        await expect.poll(() => api.document(id)?.nodes.filter((node: any) => node.metadata?.imageAgent).length).toBe(count);
        await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    };
    await send("改成V领，保留针织纹理", 1);
    const first = api.document(id)!.nodes.find((node: any) => node.metadata?.imageAgent);
    expect(first.metadata.imageAgent.parentNodeId).toBe(original.id);
    expect(first.position.x).toBeGreaterThan(original.position.x);
    expect(api.document(id)!.connections.some((edge: any) => edge.fromNodeId === original.id && edge.toNodeId === first.id)).toBe(true);
    await send("颜色再浅一点", 2);
    const outputs = api.document(id)!.nodes.filter((node: any) => node.metadata?.imageAgent);
    const second = outputs.find((node: any) => node.id !== first.id);
    expect(second.metadata.imageAgent.parentNodeId).toBe(first.id);
    expect(chat.requests[1].profileContext.lockedImageId).toBeUndefined();
    expect(chat.requests[1].profileContext.previewImageIds).toContain(chat.requests[1].profileContext.focusImageId);
    expect(chat.requests[1].input.at(-1).content).toContain("颜色再浅一点");
    expect(api.submissions.every(item => item.parameters.imageAgentProfile === "canvas-assistant")).toBe(true);
    await send("回上一版，袖子改短", 3);
    const third = api.document(id)!.nodes.find((node: any) => node.metadata?.imageAgent && !outputs.some((old: any) => old.id === node.id));
    expect(third.metadata.imageAgent.parentNodeId).toBe(first.id);
    await send("在原版上加小口袋", 4);
    const fourth = api.document(id)!.nodes.find((node: any) => node.metadata?.imageAgent && node.id !== third.id && !outputs.some((old: any) => old.id === node.id));
    expect(fourth.metadata.imageAgent.parentNodeId).toBe(original.id);
    await page.reload(); await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    await expect(panel.locator("[data-image-agent-focus]")).toHaveCount(0);
    await expect.poll(() => api.document(id)?.chatSessions.find((session: any) => session.id === api.document(id)?.activeChatId)?.focusImageId).toContain(fourth.id);
    await expect.poll(() => panel.locator('[data-testid="canvas-agent-image-result"] img').last().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(panel.getByText("工具自动执行完成", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("canvas-focus-version-chain.png"), animations: "disabled" });
});

test("clarification and image mentions stay conversational without selection candidates or locked base UI", async ({ page, context, api }, info) => {
    const chat = await fixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "original.png");
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("改成蓝色"); await input.press("Enter");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    const original = api.document(id)!.nodes[0];
    const seen = panel.getByRole("group", { name: "本轮助手看到了", exact: true });
    await expect(seen).toHaveCount(0);
    chat.setReply(route => route.fulfill({ json: { content: "你想改图1还是图2？", toolCalls: [] } }));
    await input.fill("你指的是哪一个"); await input.press("Enter");
    const candidates = panel.getByRole("group", { name: "选择要修改的图片", exact: true });
    await expect(panel.getByText("你想改图1还是图2？", { exact: true })).toBeVisible();
    await expect(candidates).toHaveCount(0);
    await expect(panel.locator("[data-image-agent-focus]")).toHaveCount(0);
    chat.setReply((route, request) => route.fulfill({ json: { content: "修改图1", toolCalls: [{ id: "edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ base: "图1", prompt: request.profileContext.currentUserText }) } }] } }));
    await input.fill("图1，把袖口改短"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(2);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(3);
    expect(api.document(id)!.nodes.at(-1).metadata.imageAgent.parentNodeId).toBe(original.id);
    await input.fill("@图1 再把背景改浅灰");
    await expect(panel.getByRole("listbox", { name: "选择图片引用" })).toHaveCount(0);
    await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(3);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(4);
    const lastPlan = chat.requests.at(-1).profileContext;
    expect(lastPlan.lockedImageId).toBeUndefined();
    expect(lastPlan.imageCatalog.some((image: any) => image.label === "图1")).toBe(true);
    expect(api.document(id)!.nodes.at(-1).metadata.imageAgent.parentNodeId).toBe(original.id);
    await page.screenshot({ path: info.outputPath("canvas-seen-candidates-mention.png") });
});

test("canvas mask UI submits paired mask and preserves original outside pixels", async ({ page, context, api }, info) => {
    await fixture(context);
    const id = await newCanvas(page);
    await uploadImage(page, "mask-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = api.document(id)!.nodes[0];
    const redPng = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024; const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 1024, 1024); return canvas.toDataURL("image/png").split(",")[1]!; });
    await context.route("**/api/assets/*/content", route => api.tasks.has(new URL(route.request().url()).pathname.split("/")[3]!) ? route.fulfill({ contentType: "image/png", body: Buffer.from(redPng, "base64") }) : route.fallback());
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await panel.getByRole("button", { name: "圈选修改", exact: true }).last().click();
    const dialog = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
    const paint = dialog.getByLabel("修改区域画布", { exact: true });
    await expect(paint).toBeVisible();
    // Ant Modal's opening scale changes pointer coordinates after visibility.
    // Wait for this square fixture's final display size before sampling a bbox.
    await expect.poll(() => paint.evaluate(canvas => {
        const rect = canvas.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)];
    })).toEqual([460, 460]);
    await expect(dialog).not.toHaveClass(/ant-zoom-(?:enter|appear)/);
    await expect(dialog).toHaveCSS("transform", "none");
    await paint.click({ trial: true });
    const box = (await paint.boundingBox())!;
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 8 }); await page.mouse.up();
    const selectedPixels = await paint.evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d")!;
        return { centerAlpha: context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3], cornerAlpha: context.getImageData(1, 1, 1, 1).data[3] };
    });
    expect(selectedPixels.centerAlpha).toBeGreaterThan(0); expect(selectedPixels.cornerAlpha).toBe(0);
    await page.screenshot({ path: info.outputPath("canvas-mask-selected-center.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "保存选区", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await input.fill("只把选区改红"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(2);
    expect(api.submissions[0].parameters.inputArchive.maskReferenceIndex).toBe(1);
    expect(api.submissions[0].sourceUrls).toHaveLength(2);
    const result = api.document(id)!.nodes.find((node: any) => node.id !== original.id);
    const pixels = await page.evaluate(async ({ source, output }) => {
        const read = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); return { width: canvas.width, height: canvas.height, edge: [...ctx.getImageData(1, 1, 1, 1).data], center: [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data] }; };
        return { original: await read(source), result: await read(output) };
    }, { source: original.metadata.content, output: result.metadata.content });
    expect(pixels.result.width).toBe(pixels.original.width); expect(pixels.result.height).toBe(pixels.original.height);
    expect(pixels.result.edge).toEqual(pixels.original.edge); expect(pixels.result.center).toEqual([255, 0, 0, 255]);
    await page.screenshot({ path: info.outputPath("canvas-mask-output.png") });
});

test("non-native selection is available and multi-generation plans make no generation submission", async ({ page, context, api }) => {
    const chat = await fixture(context, false);
    const id = await newCanvas(page); await uploadImage(page);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await panel.getByRole("button", { name: "圈选修改", exact: true }).last().click();
    const selectionDialog = page.getByRole("dialog", { name: "涂选修改区域", exact: true });
    await expect(selectionDialog.getByText(/它不是模型原生蒙版/)).toBeVisible();
    await selectionDialog.getByRole("button", { name: /^取\s*消$/ }).click();
    expect(api.submissions).toHaveLength(0);
    chat.setReply(route => route.fulfill({ json: { content: "准备两张", toolCalls: ["first", "second"].map(callId => ({ id: callId, type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: "修改颜色" }) } })) } }));
    await input.fill("改成绿色"); await input.press("Enter");
    await expect(panel.getByText("单轮只允许提交一个生成任务，本轮没有提交；请分别发送要求。", { exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(0); await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
});

test("pending generation does not block chat and late result cannot steal newer explicit focus", async ({ page, context, api }) => {
    const chat = await fixture(context);
    api.taskStatus = "queued";
    const id = await newCanvas(page);
    await uploadImage(page, "hat.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("帽子改成浅蓝色"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    chat.setReply(route => route.fulfill({ json: { content: "针织帽的浅色更适合春夏，这是文字分析。", toolCalls: [] } }));
    await input.fill("只分析浅色适合什么季节，不生成"); await input.press("Enter");
    await expect(panel.getByText("针织帽的浅色更适合春夏，这是文字分析。", { exact: true })).toBeVisible();
    const focusBefore = api.document(id)?.chatSessions.find((session: any) => session.id === api.document(id)?.activeChatId)?.focusImageId;
    for (const task of api.tasks.values()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await expect.poll(() => api.document(id)?.nodes.length, { timeout: 30_000 }).toBe(2);
    expect(api.document(id)?.chatSessions.find((session: any) => session.id === api.document(id)?.activeChatId)?.focusImageId).toBe(focusBefore);
    await expect(panel.locator("[data-image-agent-focus]")).toHaveCount(0);
    expect(api.submissions).toHaveLength(1);
});

test("accepted task card stops local waiting, ignores a late response and queries the original task without resubmission", async ({ page, context, api }, info) => {
    await fixture(context); api.taskStatus = "queued";
    let heldRead: Route | undefined, holdRead = true;
    await context.route(/\/api\/tasks\/[^/?]+$/, async route => {
        const path = new URL(route.request().url()).pathname, taskId = path.split("/").at(-1)!;
        if (route.request().method() !== "GET" || !api.tasks.has(taskId)) return route.fallback();
        api.taskReads.push(path);
        if (holdRead && !heldRead) { heldRead = route; return; }
        await route.fulfill({ json: { task: api.tasks.get(taskId) } });
    });
    const id = await newCanvas(page); await uploadImage(page, "stop-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("把帽子改为浅蓝色"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    const task = [...api.tasks.values()][0];
    const card = panel.getByText(`原任务：${task.id}`, { exact: true }).locator("..");
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await expect.poll(() => Boolean(heldRead)).toBe(true);
    await card.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(card.getByRole("button", { name: "停止本页等待", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    // Querying a still-queued original task owns a fresh stop target, and cannot
    // start another concurrent query of that same task through the card button.
    await card.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect(card.getByRole("button", { name: "停止本页等待", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await card.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(card.getByRole("button", { name: "停止本页等待", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; holdRead = false;
    // The shared snapshot HTTP read remains alive for other consumers. Stopping
    // this card revokes only its authority to apply the eventual result.
    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${task.id}`);
    await heldRead!.fulfill({ json: { task } }); await (await lateResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(`[data-node-id="agent-${task.id}-0"]`)).toHaveCount(0);
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.screenshot({ path: info.outputPath("accepted-task-stopped.png"), animations: "disabled" });
    const readsBeforeQuery = api.taskReads.length;
    await card.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.id === `agent-${task.id}-0`)).toBe(true);
    expect(api.taskReads.slice(readsBeforeQuery)).toContain(`/api/tasks/${task.id}`);
    expect(api.submissions).toHaveLength(1); expect(api.submissions[0].requestId).toBe(task.requestId);
    await expect(panel.getByText("已取回原任务结果并放入画布，没有重新生成。", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("accepted-task-original-query.png"), animations: "disabled" });
});

test("two accepted tasks stop only the chosen card and retain independent original-task recovery", async ({ page, context, api }, info) => {
    await fixture(context); api.taskStatus = "queued";
    const id = await newCanvas(page); await uploadImage(page, "two-tasks-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    for (const [index, text] of ["帽子改为蓝色", "帽子改为绿色"].entries()) {
        await input.fill(text); await input.press("Enter"); await expect.poll(() => api.submissions.length).toBe(index + 1);
        await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    }
    const [first, second] = [...api.tasks.values()];
    const firstCard = panel.getByText(`原任务：${first.id}`, { exact: true }).locator("..");
    const secondCard = panel.getByText(`原任务：${second.id}`, { exact: true }).locator("..");
    await expect(firstCard.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await expect(secondCard.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    await firstCard.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(firstCard.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    await expect(firstCard.getByRole("button", { name: "停止本页等待", exact: true })).toHaveCount(0);
    await expect(secondCard.getByRole("button", { name: "停止本页等待", exact: true })).toBeVisible();
    await expect(secondCard.getByRole("button", { name: "查询原任务", exact: true })).toBeDisabled();
    for (const task of [first, second]) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await expect.poll(() => api.document(id)?.nodes.some((node: any) => node.id === `agent-${second.id}-0`), { timeout: 30_000 }).toBe(true);
    expect(api.document(id)!.nodes.some((node: any) => node.id === `agent-${first.id}-0`)).toBe(false);
    expect(api.document(id)!.nodes).toHaveLength(2); expect(api.submissions).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("only-selected-task-stopped.png"), animations: "disabled" });
    await firstCard.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect.poll(() => api.document(id)?.nodes.length).toBe(3);
    expect(api.document(id)!.nodes.some((node: any) => node.id === `agent-${first.id}-0`)).toBe(true);
    expect(api.submissions).toHaveLength(2);
});

test("stopping an accepted card does not cancel another current planning reply", async ({ page, context, api }) => {
    const chat = await fixture(context); api.taskStatus = "queued";
    const id = await newCanvas(page); await uploadImage(page, "planning-original.png");
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel"), input = panel.getByPlaceholder(placeholder);
    await input.fill("帽子改成蓝色"); await input.press("Enter");
    await expect.poll(() => api.submissions.length).toBe(1);
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const task = [...api.tasks.values()][0], card = panel.getByText(`原任务：${task.id}`, { exact: true }).locator("..");
    let planning: Route | undefined;
    chat.setReply(async route => { planning = route; });
    await input.fill("只分析这个蓝色适合什么季节，不要生成"); await input.press("Enter");
    await expect.poll(() => Boolean(planning)).toBe(true);
    await card.getByRole("button", { name: "停止本页等待", exact: true }).click();
    await expect(card.getByRole("button", { name: "查询原任务", exact: true })).toBeEnabled();
    expect(planning!.request().failure()).toBeNull();
    await planning!.fulfill({ json: { content: "这个蓝色适合春夏，本轮仅分析。", toolCalls: [] } });
    await expect(panel.getByText("这个蓝色适合春夏，本轮仅分析。", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1); expect(api.document(id)!.nodes).toHaveLength(1);
});
