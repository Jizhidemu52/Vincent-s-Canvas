// Real /chat UI in a fresh, isolated browser context. All business APIs are
// stubbed and off-origin requests blocked: colored fixture images test workflow,
// not actual image-model quality, and no provider or paid task is contacted.
export async function verifyChatCreativeContinuity(page, origin = "http://127.0.0.1:4319", options = {}) {
    const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const tab = await context.newPage();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const waitFor = async (read, message) => {
        const deadline = performance.now() + 15_000;
        while (performance.now() < deadline) {
            if (await read()) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(message);
    };
    const user = { id: "browser-chat-continuity-owner", username: "browser-fixture", displayName: "隔离创作回归", role: "designer", status: "active", mustChangePassword: false, mfaEnabled: false, creditBalance: 0 };
    const storageKey = `wireless-canvas:llm-chat:${user.id}`;
    const requirements = "需求文件：保留原款连衣裙的领型、袖型和裙长；不增加花纹或装饰；第一轮只改为紫色。";
    const firstInstruction = "把这件衣服改成紫色，按需求文件保留版型，生成修改图。";
    const secondInstruction = "再让女模特穿上，衣服颜色和版型不变。";
    const discussion = "只讨论这套穿搭适合什么场景，不要生成图片。";
    const discussionAnswer = "这套紫色连衣裙适合简洁的日常穿搭或聚会。本轮只讨论，没有生成图片。";
    const followUpAnswer = "文件要求保留领型、袖型和裙长，并且不增加花纹或装饰；后续修改继续遵守这些要求。";
    const firstPrompt = "以原款连衣裙为编辑对象，仅将衣服改为紫色，保持原款领型、袖型和裙长，不增加花纹或装饰，其他构图与背景不变。";
    const secondPrompt = "让成年女模特穿上上一轮的紫色连衣裙，衣服紫色、领型、袖型和裙长保持不变，不增加花纹或装饰，服装结构与上一轮一致。";
    const preservedConstraints = ["保留领型、袖型和裙长", "不增加花纹或装饰"];
    const taskIds = ["continuity-browser-task-1", "continuity-browser-task-2"];
    const resultIds = taskIds.map(id => `${id}:0`);
    const models = [
        { id: "fixture-chat", modelId: "gpt-fixture-chat", name: "隔离对话模型", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
        { id: "fixture-image", modelId: "gpt-image-2", name: "隔离图片模型", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    ];
    const calls = [], plannerRequests = [], taskPosts = [], uploads = [], unexpected = [], pageErrors = [], consoleErrors = [], screenshots = [];
    const uploadedBytes = new Map();
    const pendingRequests = new Set();
    const failedRequests = [];
    let fixtureImages;
    let originalAttachment;
    const readSession = () => tab.evaluate(async key => {
        if (!(await indexedDB.databases()).some(item => item.name === "wireless-canvas")) return undefined;
        return new Promise((resolve, reject) => {
            const open = indexedDB.open("wireless-canvas");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains("app_state")) { db.close(); resolve(undefined); return; }
                const query = db.transaction("app_state", "readonly").objectStore("app_state").get(key);
                query.onsuccess = () => { db.close(); resolve(query.result?.[0]); };
                query.onerror = () => { db.close(); reject(query.error); };
            };
        });
    }, storageKey);
    const assertNaturalChatControls = async () => {
        check(await tab.getByRole("button", { name: /^(聊天|创作|Agent)$/ }).count() === 0, "Manual chat/create/agent mode buttons still exist");
        check(await tab.getByRole("combobox", { name: /^(编辑起点|创作理解模型|图像模型)$/ }).count() === 0, "Manual image target or creative-model selectors still exist");
        check(await tab.getByRole("button", { name: /继续编辑/ }).count() === 0, "Click-to-select image editing buttons still exist");
        check(await tab.getByRole("combobox", { name: "对话模型", exact: true }).count() === 0, "Designer chat model selection is still exposed");
        check(await tab.getByText("隔离对话模型", { exact: true }).count() === 0, "The managed chat model name is still exposed");
    };
    const screenshot = async name => {
        if (!options.screenshotDirectory) return;
        const path = `${options.screenshotDirectory}/${name}.png`;
        await tab.screenshot({ path, fullPage: true });
        screenshots.push(path);
    };
    tab.on("pageerror", error => pageErrors.push(error.message));
    tab.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    tab.on("request", request => pendingRequests.add(request.url()));
    tab.on("requestfinished", request => pendingRequests.delete(request.url()));
    tab.on("requestfailed", request => { pendingRequests.delete(request.url()); failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }); });
    await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
            unexpected.push({ method: request.method(), url: request.url(), reason: "off-origin blocked" });
            return route.abort("blockedbyclient");
        }
        if (url.pathname === "/__chat-creative-continuity-fixture__") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated natural chat continuity fixture</title>" });
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const call = { method: request.method(), path: url.pathname + url.search };
        calls.push(call);
        const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
        if (request.method() === "POST" && url.pathname === "/api/chat/responses") {
            plannerRequests.push(request.postDataJSON());
            if (plannerRequests.length === 1) {
                originalAttachment = (await readSession())?.messages[0]?.attachments?.find(item => item.kind === "image");
                if (!originalAttachment) return json({ message: "Original upload was not persisted before planning" }, 422);
            }
            if (plannerRequests.length === 2) return json({ content: "查看上一轮结果以继续修改。", toolCalls: [{ id: "fixture-inspect-previous", type: "function", function: { name: "inspect_images", arguments: JSON.stringify({ image_ids: [resultIds[0]] }) } }] });
            const turnIndex = plannerRequests.length === 1 ? 0 : plannerRequests.length === 3 ? 1 : 2;
            if (turnIndex < 2) return json({ content: turnIndex === 0 ? "只调整衣服颜色，保留文件要求的版型。" : "沿用上一轮紫色衣服，保留颜色和版型。", toolCalls: [{ id: `fixture-edit-call-${turnIndex + 1}`, type: "function", function: { name: "create_image", arguments: JSON.stringify({ action: "edit", prompt: [firstPrompt, secondPrompt][turnIndex], target_image_id: turnIndex === 0 ? originalAttachment.id : resultIds[0], reference_image_ids: [], preserve: turnIndex === 0 ? preservedConstraints : [...preservedConstraints, "保持上一轮紫色"] }) } }] });
            if (plannerRequests.length === 5) return json({ content: `实际提示词：\n${taskPosts[1].parameters.inputArchive.prompt}`, toolCalls: [] });
            if (plannerRequests.length === 6) return json({ content: followUpAnswer, toolCalls: [] });
            return json({ content: discussionAnswer, toolCalls: [] });
        }
        if (request.method() === "POST" && url.pathname === "/api/assets/upload-request") {
            const assetId = `fixture-edit-reference-${uploads.length + 1}`;
            uploads.push({ assetId, ...request.postDataJSON() });
            return json({ assetId, uploadUrl: `/api/assets/${assetId}/upload-content` });
        }
        const upload = uploads.find(item => url.pathname === `/api/assets/${item.assetId}/upload-content`);
        if (request.method() === "PUT" && upload) {
            uploadedBytes.set(upload.assetId, request.postDataBuffer().toString("base64"));
            return json({ ok: true });
        }
        if (request.method() === "POST" && url.pathname === "/api/tasks" && taskPosts.length < taskIds.length) {
            taskPosts.push(request.postDataJSON());
            return json({ task: { id: taskIds[taskPosts.length - 1], status: "processing" } });
        }
        if (request.method() !== "GET") {
            unexpected.push({ ...call, reason: "business mutation blocked" });
            return json({ message: "This browser regression blocks all unmocked mutations" }, 405);
        }
        if (url.pathname === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
        if (url.pathname === "/api/auth/session") return json({ user });
        if (url.pathname === "/api/modules") return json({ modules: ["canvas", "image", "assets", "gpt-chat", "gpt-chat-image"].map(moduleKey => ({ moduleKey, enabled: true, updatedAt: "fixture" })) });
        if (url.pathname === "/api/models") return json({ models, prices: [], tools: [{ toolKey: "gpt-chat", modelConfigId: "fixture-chat", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }] });
        if (url.pathname === "/api/generation-capabilities") return json({ models: [] });
        const taskIndex = taskIds.findIndex(id => url.pathname === `/api/tasks/${id}`);
        if (taskIndex >= 0 && taskPosts[taskIndex]) return json({ task: { id: taskIds[taskIndex], requestId: taskPosts[taskIndex].requestId, status: "success", ownerUserId: user.id, userId: user.id, operationType: "inpaint", resultUrls: [`/api/assets/fixture-edited-result-${taskIndex + 1}/content`], failureReason: null } });
        const resultIndex = taskIds.findIndex((_id, index) => url.pathname === `/api/assets/fixture-edited-result-${index + 1}/content`);
        if (resultIndex >= 0) return route.fulfill({ contentType: "image/png", body: Buffer.from([fixtureImages.first, fixtureImages.second][resultIndex].split(",")[1], "base64") });
        unexpected.push({ ...call, reason: "unmocked API query blocked" });
        return json({ message: `Unmocked endpoint ${url.pathname}` }, 404);
    });
    try {
        await tab.goto(`${origin}/__chat-creative-continuity-fixture__`);
        fixtureImages = await tab.evaluate(() => {
            const image = (color, label) => {
                const canvas = document.createElement("canvas");
                canvas.width = 320; canvas.height = 180;
                const ctx = canvas.getContext("2d");
                ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180);
                ctx.fillStyle = "white"; ctx.font = "28px sans-serif"; ctx.fillText(label, 24, 98);
                return canvas.toDataURL("image/png");
            };
            return { original: image("#25634a", "Original"), first: image("#724aa2", "Purple v1"), second: image("#795079", "Model v2") };
        });
        check(!(await readSession()), "The isolated context unexpectedly contains a pre-existing chat session");
        await tab.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
        const draft = tab.getByRole("textbox", { name: "对话内容", exact: true });
        const send = tab.getByRole("button", { name: "发送", exact: true });
        await draft.waitFor({ state: "visible", timeout: 60_000 });
        await waitFor(() => tab.getByRole("combobox", { name: "出图模型", exact: true }).inputValue().then(value => value === "gpt-image-2"), "Shared business configuration did not become ready");
        await assertNaturalChatControls();
        await tab.locator('input[type="file"]').setInputFiles([
            { name: "原款.png", mimeType: "image/png", buffer: Buffer.from(fixtureImages.original.split(",")[1], "base64") },
            { name: "需求.txt", mimeType: "text/plain", buffer: Buffer.from(requirements, "utf8") },
        ]);
        await tab.getByRole("button", { name: "移除 原款.png", exact: true }).waitFor({ state: "visible" });
        await tab.getByRole("button", { name: "移除 需求.txt", exact: true }).waitFor({ state: "visible" });
        await draft.fill(firstInstruction);
        await screenshot("natural-chat-initial-upload");
        await send.click();
        await waitFor(async () => (await readSession())?.messages.at(-1)?.generatedImages?.[0]?.id === resultIds[0], "First direct image edit did not persist its result");
        check(plannerRequests.length === 1 && taskPosts.length === 1, "First direct edit did not produce exactly one plan and one image task");
        check(plannerRequests[0].modelId === "gpt-fixture-chat", "Chat did not use the administrative model binding");
        const firstState = await readSession();
        const firstUser = firstState.messages[0];
        const firstImage = firstState.messages.at(-1).generatedImages[0];
        check(firstUser.content === firstInstruction && firstUser.attachments.length === 2, "The first user turn lost its original text or uploads");
        check(originalAttachment.dataUrl === fixtureImages.original, "Uploaded original bytes were replaced by a planning preview");
        check(firstUser.attachments.find(item => item.name === "需求.txt")?.textContent === requirements, "Uploaded TXT requirements were not retained");
        const firstPayload = JSON.stringify(plannerRequests[0]);
        check(firstPayload.includes(requirements) && firstPayload.includes(firstInstruction) && firstPayload.includes(originalAttachment.id) && firstPayload.includes("input_image"), "The first planner request omitted original image, document, or current instruction");
        check(firstImage.prompt === taskPosts[0].parameters.inputArchive.prompt && firstImage.prompt.includes(firstPrompt) && firstImage.lineage.parentImageId === originalAttachment.id, "First result lost its actual compiled execution prompt or original parent");
        check(JSON.stringify(firstImage.lineage.sourceImageIds) === JSON.stringify([originalAttachment.id]), "First result lineage contains unexpected source images");
        check(await tab.getByRole("button", { name: /^移除 / }).count() === 0, "Sent attachments were not cleared from the composer");
        await assertNaturalChatControls();
        await screenshot("natural-chat-first-result");

        // No mode, model, target, image, or upload control is touched between turns.
        await draft.fill(secondInstruction);
        await send.click();
        await waitFor(async () => (await readSession())?.messages.at(-1)?.generatedImages?.[0]?.id === resultIds[1], "Text-only continuation did not persist the second result");
        check(plannerRequests.length === 3 && taskPosts.length === 2, "Historical edit did not use exactly one inspection followed by one image task");
        const secondPayload = JSON.stringify(plannerRequests[1]);
        check(secondPayload.includes(originalAttachment.id) && secondPayload.includes(resultIds[0]), "Second planner request omitted the original or previous result identity");
        check(secondPayload.includes(requirements) && secondPayload.includes(firstPrompt) && secondPayload.includes(secondInstruction), "Second planner request omitted the document, previous execution prompt, or current instruction");
        check((secondPayload.match(/"type":"input_image"/g) || []).length === 0, "Historical images were eagerly attached to initial continuation planning");
        check((JSON.stringify(plannerRequests[2]).match(/"type":"input_image"/g) || []).length === 1, "Inspection did not attach only the specifically requested prior result");
        const secondState = await readSession();
        const secondUser = secondState.messages.at(-2);
        const secondImage = secondState.messages.at(-1).generatedImages[0];
        check(secondUser.content === secondInstruction && !secondUser.attachments?.length, "Text-only continuation duplicated an upload or changed the user's text");
        check(secondImage.prompt === taskPosts[1].parameters.inputArchive.prompt && secondImage.prompt.includes(secondPrompt) && secondImage.lineage.parentImageId === resultIds[0], "Second result did not retain its compiled prompt and previous-result parent");
        check(JSON.stringify(secondImage.lineage.sourceImageIds) === JSON.stringify([resultIds[0]]), "Second result used the wrong source whitelist");
        check(secondImage.lineage.preservedConstraints.includes("保持上一轮紫色"), "Second result lost the retained color constraint");
        const referenceIds = taskPosts.map(submitted => submitted.parameters?.inputArchive?.references.map(item => item.id));
        check(JSON.stringify(referenceIds) === JSON.stringify([[originalAttachment.id], [resultIds[0]]]), `Actual edit targets are incorrect: ${JSON.stringify(referenceIds)}`);
        taskPosts.forEach((submitted, index) => {
            const prompt = [firstPrompt, secondPrompt][index];
            check(submitted.parameters?.count === 1 && submitted.operationType === "inpaint", `Edit ${index + 1} used the wrong operation or result count`);
            check(submitted.prompt.includes(prompt) && submitted.parameters.inputArchive.prompt.includes(prompt), `Edit ${index + 1} did not receive the full planner prompt`);
        });
        check(uploads.length === 2 && uploadedBytes.size === 2, "Two edits did not upload exactly their respective target images");
        check(uploadedBytes.get(uploads[0].assetId) === originalAttachment.dataUrl.split(",")[1], "First edit did not upload the stored original bytes");
        check(uploadedBytes.get(uploads[1].assetId) === fixtureImages.first.split(",")[1], "Second edit did not upload the prior result's original bytes");
        await assertNaturalChatControls();

        await draft.fill(discussion);
        await send.click();
        await tab.getByText(discussionAnswer, { exact: true }).waitFor({ state: "visible" });
        await waitFor(async () => (await readSession())?.messages.at(-1)?.content === discussionAnswer, "Discussion result did not persist");
        check(plannerRequests.length === 4 && taskPosts.length === 2 && uploads.length === 2, "Discussion unexpectedly submitted another image task or upload");
        check(!JSON.stringify(plannerRequests[3]).includes('"type":"input_image"'), "Ordinary discussion resent historical image previews");
        check(await tab.getByText("查看提示词", { exact: true }).count() === 0, "An unrequested prompt-view UI was added");
        for (const [index, [question, expected]] of [["这个画布提示词是什么发给我", secondImage.prompt], ["刚才文件里要求保留哪些内容？", followUpAnswer]].entries()) {
            await draft.fill(question);
            await send.click();
            await waitFor(async () => (await readSession())?.messages.at(-1)?.role === "assistant" && (await readSession())?.messages.at(-1)?.content.includes(expected), `Ordinary follow-up failed: ${question}`);
            check(plannerRequests.length === 5 + index && taskPosts.length === 2 && uploads.length === 2, "Ordinary follow-up bypassed the model, retried, or created an image task");
            check(!JSON.stringify(plannerRequests.at(-1)).includes('"type":"input_image"'), "Ordinary follow-up eagerly resent historical image previews");
        }
        const beforeReload = await readSession();
        check(beforeReload.messages.length === 10, "Five turns did not retain exactly five user/assistant pairs");
        check(beforeReload.messages.filter(item => item.role === "user").slice(1).every(item => !item.attachments?.length), "Later text-only turns acquired duplicated attachments");
        await tab.reload({ waitUntil: "domcontentloaded" });
        await draft.waitFor({ state: "visible" });
        await tab.getByText(discussionAnswer, { exact: true }).waitFor({ state: "visible" });
        await assertNaturalChatControls();
        const restored = await readSession();
        const restoredImages = restored.messages.flatMap(item => item.generatedImages || []);
        check(JSON.stringify(restoredImages) === JSON.stringify([firstImage, secondImage]), "Reload changed result bytes, prompts, or lineage");
        check(JSON.stringify(restored.messages[0].attachments) === JSON.stringify(firstUser.attachments), "Reload changed original image or document attachments");
        check(taskPosts.length === 2 && plannerRequests.length === 6, "Reload resubmitted planning or an image task");
        await tab.getByText(discussionAnswer, { exact: true }).scrollIntoViewIfNeeded();
        await screenshot("natural-chat-after-reload");

        await tab.setViewportSize({ width: 390, height: 844 });
        const closeSidebar = tab.locator("aside").getByRole("button", { name: "收起会话", exact: true });
        if (await closeSidebar.isVisible()) await closeSidebar.click();
        await waitFor(() => tab.locator("aside[aria-hidden]").evaluate(element => element.getBoundingClientRect().width <= 1), "Mobile conversation sidebar did not finish closing");
        await draft.fill("手机端直接继续聊天，不生成图片");
        check(await draft.inputValue() === "手机端直接继续聊天，不生成图片", "Mobile composer cannot accept direct text input");
        await assertNaturalChatControls();
        const geometry = await tab.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }));
        check(geometry.body <= geometry.viewport + 1 && geometry.document <= geometry.viewport + 1, `Mobile page overflows horizontally: ${JSON.stringify(geometry)}`);
        await tab.getByText(discussionAnswer, { exact: true }).scrollIntoViewIfNeeded();
        await screenshot("natural-chat-mobile");
        check(!unexpected.length, `Unexpected network requests: ${JSON.stringify(unexpected)}`);
        check(!pageErrors.length, `Page errors: ${pageErrors.join("; ")}`);
        check(!consoleErrors.length, `Console errors: ${consoleErrors.join("; ")}`);
        return { passed: true, mockedBusinessApi: true, fixtureImagesOnly: true, realGenerationRequests: 0, freshSessionWithoutSeededHistory: true, manualModeOrTargetSelections: 0, stubbedPlannerRequests: plannerRequests.length, stubbedImageTaskPosts: taskPosts.length, discussionTaskRequests: 0, ordinaryFollowUpModelCalls: 3, keywordBypasses: 0, additionalUiControls: 0, taskReferenceIds: referenceIds, originalUploadBytesPreserved: true, historicalImagesInspectedOnlyOnDemand: true, documentAndExecutionPromptInSecondTurn: true, laterAttachmentsNotDuplicated: true, lineageAndAttachmentsSurviveReload: true, reloadResubmissions: 0, mobile: geometry, screenshots, calls, pageErrors, consoleErrors };
    } catch (error) {
        await screenshot("natural-chat-failed").catch(() => {});
        const summarizedPlannerRequests = JSON.parse(JSON.stringify(plannerRequests, (_key, value) => typeof value === "string" && value.startsWith("data:image/") ? "[fixture image preview]" : value));
        return { passed: false, error: error instanceof Error ? error.message : String(error), calls, plannerRequests: summarizedPlannerRequests, taskPosts, uploads, unexpected, pageErrors, consoleErrors, screenshots, pendingRequests: [...pendingRequests], failedRequests, pageText: (await tab.locator("body").innerText().catch(() => "")).slice(0, 5000) };
    } finally { await context.close(); }
}
