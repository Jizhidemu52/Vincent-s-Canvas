import type { Page, Route } from "@playwright/test";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";

const spec = { changes: ["左袖口改为罗纹"], region: "左袖口", acceptance: ["袖口为罗纹", "纽扣数量保持"], assumptions: ["只处理左袖口"] };
const answer = (args: Record<string, unknown> = {}) => ({ content: "将按所列要求修改，结果仍需核对。", toolCalls: [{ id: "edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify({ prompt: "完整规划：左袖口罗纹过渡自然，保留真实棉纱纹理。", edit_spec: spec, ...args }) } }] });
const review = { summary: "袖口可见罗纹，纽扣细节仍需核对。", checks: [{ criterion: "袖口", result: "pass", evidence: "左袖口出现竖向罗纹" }, { criterion: "纽扣数量", result: "warning", evidence: "图片较小，疑似少了一粒，应对照底图核查" }] };
async function setup(page: Page, plans: any[], respond: (body: any, index: number, route: Route) => Promise<void>) {
    await page.route("**/api/models", route => route.fulfill({ json: { models: [
        { id: "chat", modelId: "gpt-6-astra", name: "隔离对话", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 },
        { id: "image", modelId: "gpt-image-2", name: "隔离图片", imageParameterProfile: "standard", imageSupportsMask: true, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    ], prices: [], tools: [{ toolKey: "gpt-chat", enabled: true, modelConfigId: "chat", configurationVersion: 1 }, { toolKey: "gpt-chat-image", enabled: true, modelConfigId: "image", configurationVersion: 1 }] } }));
    await page.route("**/api/chat/responses", route => { const body = route.request().postDataJSON(); plans.push(body); return respond(body, plans.length, route); });
    await page.goto("/chat"); await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
}
async function upload(page: Page) {
    const chooser = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: "原版.png", mimeType: "image/png", buffer: IMAGE });
    await expect(page.getByRole("button", { name: "移除 原版.png", exact: true })).toBeVisible();
}
async function send(page: Page, text: string) { await page.getByRole("textbox", { name: "对话内容", exact: true }).fill(text); await page.getByRole("button", { name: "发送", exact: true }).click(); }
async function sessions(page: Page) { return page.evaluate(async () => { const { chatSessionStorage } = await import("/src/pages/chat/chat-session-storage.ts"); const { useUserStore } = await import("/src/stores/use-user-store.ts"); return chatSessionStorage.load(`wireless-canvas:llm-chat:${useUserStore.getState().user!.id}`, () => null) as Promise<any[]>; }); }
const generated = (page: Page) => page.locator('[data-message-role="assistant"] .group\\/image');

// Build the observed branching history through the actual composer, with five
// distinct PNG originals supplied by the existing isolated business-API fixture.
async function prepareOlderBranch(page: Page, api: MockCanvasApi, plans: any[]) {
    await setup(page, plans, (body, _index, route) => {
        const text = body.profileContext.currentUserText;
        const target = body.profileContext.imageCatalog.find((image: any) => image.label === "图3");
        const base = text.includes("以图3") ? target.id : text.includes("上一版") ? "previous" : text.includes("原图") ? "original" : "focus";
        return route.fulfill({ json: answer({ base, prompt: text, edit_spec: { changes: [text] } }) });
    });
    await upload(page);
    for (const [index, text] of ["把包身和肩带改成森林绿", "保持森林绿，把背景改浅暖灰", "回上一版，把包身改成酒红色", "回原图，只把背景改成蓝色"].entries()) {
        await send(page, text);
        await expect(generated(page)).toHaveCount(index + 1);
    }
    const snapshot = (await sessions(page))[0];
    const original = snapshot.messages[0].attachments.find((item: any) => item.kind === "image");
    const versions = snapshot.messages.flatMap((message: any) => message.generatedImages || []);
    expect(versions.map((image: any) => image.parentId)).toEqual([original.id, versions[0].id, versions[0].id, original.id]);
    expect(plans).toHaveLength(4); expect(api.submissions).toHaveLength(4);
    return { original, versions, snapshot, olderBytes: api.assetBytes.get(versions[1].id.split(":")[0])! };
}

const olderInstruction = "以图3为基础，只把两侧连接环从金色改成银色。保留图3的森林绿包身和肩带、浅暖灰背景，以及原有包型，生成一张。";
const planningPixels = (body: any) => body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content.filter((part: any) => part.type === "input_image").map((part: any) => part.image_url) : []);

test("旧图像素补载：五版本分支直接改图3，唯一repair带真实像素且只提交一次正确原件", async ({ page, api }, info) => {
    const plans: any[] = [];
    const { original, versions, olderBytes } = await prepareOlderBranch(page, api, plans);
    const olderId = versions[1].id, currentId = versions[3].id;
    const expectedPreview = await page.evaluate(async dataUrl => {
        const image = new Image();
        await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("fixture PNG unreadable")); image.src = dataUrl; });
        const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!; context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.78);
    }, `data:image/png;base64,${olderBytes.toString("base64")}`);
    await send(page, olderInstruction);
    await expect(generated(page)).toHaveCount(5);
    expect(plans).toHaveLength(6);
    const [initial, repaired] = plans.slice(4);
    expect(initial.profileContext.previewImageIds).toEqual([currentId, original.id]);
    expect(planningPixels(initial)).not.toContain(expectedPreview);
    expect(repaired.profileContext).toMatchObject({ stage: "repair", focusImageId: currentId, previewImageIds: [olderId, currentId, original.id] });
    expect(repaired.profileContext.imageCatalog.find((item: any) => item.id === olderId)).toMatchObject({ parentId: versions[0].id, previewed: true });
    expect(planningPixels(repaired)).toHaveLength(3);
    expect(planningPixels(repaired)[0]).toBe(expectedPreview);
    expect(repaired.input.at(-1)).toEqual({ role: "user", content: olderInstruction });
    expect(Object.keys(repaired.profileContext.repairIssue).sort()).toEqual(["code", "message", "repairable", "submitted"]);
    expect(api.submissions).toHaveLength(5);
    const submitted = api.submissions[4];
    expect(submitted.parameters.inputArchive.references.map((item: any) => item.id)).toEqual([olderId]);
    expect(submitted.sourceUrls).toHaveLength(1);
    const submittedBytes = api.assetBytes.get(new URL(submitted.sourceUrls[0], "http://fixture.test").pathname.split("/")[3]);
    expect(submittedBytes).toEqual(olderBytes);
    const savedVersions = (await sessions(page))[0].messages.flatMap((message: any) => message.generatedImages || []);
    expect(savedVersions.slice(0, 4)).toEqual(versions);
    expect(savedVersions.at(-1)).toMatchObject({ parentId: olderId, workId: original.id });
    await expect(page.locator('[data-message-role="error"]')).toHaveCount(0);
    await expect(page.getByText(/需要先查看较早图片|未预览/)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("chat-older-branch-pixel-repair.png"), animations: "disabled" });
    await page.reload(); await expect(generated(page)).toHaveCount(5);
    expect(api.submissions).toHaveLength(5); expect(plans).toHaveLength(6);
});

test("旧图像素补载：读取图3时取消不重发repair或提交图像且原版本保留", async ({ page, api }) => {
    const plans: any[] = [];
    const { versions, olderBytes } = await prepareOlderBranch(page, api, plans);
    // Hold only the detached decoder for this exact old PNG. The stored original,
    // displayed images and all other decodes remain unchanged; the real Stop
    // button must abort the loader before it can send a repair request.
    await page.evaluate(dataUrl => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
        Object.defineProperty(HTMLImageElement.prototype, "src", { ...descriptor, set(value: string) {
            if (!this.isConnected && value === dataUrl) { (window as any).__olderPreviewHeld = true; return; }
            descriptor.set!.call(this, value);
        } });
    }, `data:image/png;base64,${olderBytes.toString("base64")}`);
    await send(page, olderInstruction);
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__olderPreviewHeld))).toBe(true);
    expect(plans).toHaveLength(5);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
    expect(plans).toHaveLength(5); expect(api.submissions).toHaveLength(4);
    const saved = (await sessions(page))[0];
    expect(saved.messages.flatMap((message: any) => message.generatedImages || [])).toEqual(versions);
    expect(saved.focusImageId).toBe(versions[3].id);
    await page.reload(); await expect(generated(page)).toHaveCount(4);
    expect(plans).toHaveLength(5); expect(api.submissions).toHaveLength(4);
});

test("只用对话连续改当前图、上一版、原图和图号，刷新后继续且原件与谱系正确", async ({ page, api }, info) => {
    const plans: any[] = [];
    await setup(page, plans, (body, _index, route) => {
        const text = body.profileContext.currentUserText;
        const firstVersion = body.profileContext.imageCatalog.find((image: any) => image.label === "图2");
        if (text.includes("图2") && body.profileContext.stage === "plan") return route.fulfill({ json: { content: "先看图2的原件。", toolCalls: [{ id: "look-old", type: "function", function: { name: "look_at_images", arguments: JSON.stringify({ image_ids: [firstVersion.id] }) } }] } });
        return route.fulfill({ json: answer({ base: text.includes("图2") ? firstVersion.id : text.includes("上一版") ? "previous" : text.includes("原图") ? "original" : "focus", prompt: text, edit_spec: { changes: [text] } }) });
    });
    const noSelectionControls = async () => {
        await expect(page.locator("[data-image-agent-focus]")).toHaveCount(0);
        await expect(page.getByTestId("chat-edit-base")).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^(在此基础上改|回原图重做|作为参考|上一版|当前图|新创作)$/ })).toHaveCount(0);
        await expect(page.getByRole("listbox", { name: "选择图片引用" })).toHaveCount(0);
    };
    await upload(page);
    const inputs = ["把标题改为蓝色", "文字再细一点", "回上一版，只调整标题位置", "回原图，把标题移到右侧", "在当前图加一个小圆点", "回到图2，蓝色保留，标题居中"];
    const parents: string[] = [], resultIds: string[] = [];
    let originalId = "";
    for (let index = 0; index < inputs.length; index++) {
        if (index === 4) { await page.reload(); await expect(generated(page)).toHaveCount(4); }
        await noSelectionControls(); await send(page, inputs[index]);
        await expect(generated(page)).toHaveCount(index + 1);
        await expect.poll(() => api.submissions.length).toBe(index + 1);
        const snapshot = (await sessions(page))[0], images = snapshot.messages.flatMap((message: any) => message.generatedImages || []);
        originalId ||= plans[0].profileContext.focusImageId;
        const expectedParent = index === 0 || index === 3 ? originalId : index === 2 || index === 5 ? resultIds[0] : resultIds[index - 1];
        const result = images.at(-1); parents.push(expectedParent); resultIds.push(result.id);
        expect(result.parentId).toBe(expectedParent); expect(result.spec.changes).toEqual([inputs[index]]);
        const submission = api.submissions[index];
        expect(submission.parameters.inputArchive.references.map((image: any) => image.id)).toEqual([expectedParent]);
        expect(submission.sourceUrls).toHaveLength(1);
        const actualBytes = api.assetBytes.get(new URL(submission.sourceUrls[0], "http://fixture.test").pathname.split("/")[3]);
        const expectedBytes = expectedParent === originalId ? IMAGE : api.assetBytes.get(expectedParent.split(":")[0]);
        expect(actualBytes).toEqual(expectedBytes);
        const currentPlan = plans.findLast(plan => plan.profileContext.currentUserText === inputs[index]);
        expect(currentPlan.profileContext.lockedImageId).toBeUndefined();
        expect(snapshot.focusLocked).toBe(false);
    }
    expect(plans).toHaveLength(7); expect(plans.map(plan => plan.profileContext.stage)).not.toContain("review");
    expect(plans.at(-1).profileContext.stage).toBe("continue");
    expect(plans.at(-1).profileContext.previewImageIds).toContain(resultIds[0]);
    expect(parents).toEqual([originalId, resultIds[0], resultIds[0], originalId, resultIds[3], resultIds[0]]);
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("@图2 只是文字，不弹出选图器");
    await noSelectionControls();
    await page.screenshot({ path: info.outputPath("chat-conversation-desktop.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.locator("aside").getByRole("button", { name: "收起会话", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("chat-conversation-mobile.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(6);
});

test("规划校验只修一次，规格经pending和结果持久化，所选版本简报不串版", async ({ page, api }, info) => {
    const plans: any[] = []; api.taskStatus = "processing";
    await setup(page, plans, (body, index, route) => route.fulfill(index === 1
        ? { status: 422, json: { error: "IMAGE_AGENT_SPEC_INVALID", message: "规格changes不完整，尚未提交", repairable: true, submitted: false } }
        : { json: body.profileContext.currentUserText === "只讨论这版" ? { content: "只讨论当前版本。", toolCalls: [] } : answer(index === 3 ? { edit_spec: { changes: ["领口改绿色"], assumptions: ["只处理领口"] } } : {}) }));
    await upload(page); await send(page, "左袖口改罗纹");
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(plans).toHaveLength(2); expect(plans[1].profileContext.stage).toBe("repair");
    expect(plans[1].requestId).not.toBe(plans[0].requestId);
    expect(api.submissions[0].prompt).toContain("完整规划：左袖口罗纹过渡自然，保留真实棉纱纹理。");
    expect(api.submissions[0].prompt).toContain("除本次明确修改外，其余保持底图不变。");
    expect(api.submissions[0].prompt).toContain("左袖口改为罗纹");
    expect(api.submissions[0].prompt).toContain("修改区域：左袖口");
    await expect(page.getByTestId("chat-image-spec")).toContainText("本轮假设：只处理左袖口");
    await expect(page.getByTestId("chat-edit-base")).toHaveCount(0);
    await expect.poll(async () => (await sessions(page))[0]?.messages.find((m: any) => m.pendingImageTask)?.pendingImageTask.spec).toEqual(spec);
    for (const task of api.tasks.values()) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    await expect(generated(page)).toHaveCount(1);
    await page.reload(); await expect(generated(page)).toHaveCount(1);
    expect((await sessions(page))[0].messages.find((m: any) => m.generatedImages)?.generatedImages[0].spec).toEqual(spec);
    api.taskStatus = "success"; await send(page, "改绿色领口"); await expect(generated(page)).toHaveCount(2);
    await send(page, "只讨论这版"); await expect(page.getByText("只讨论当前版本。", { exact: true })).toBeVisible();
    const last = plans.at(-1).profileContext, selected = last.imageCatalog.find((item: any) => item.id === last.focusImageId);
    expect(selected.designBrief).toContain("绿色"); expect(selected.designBrief).not.toContain("左袖口"); expect(selected.designBrief.length).toBeLessThanOrEqual(1600);
    expect(last.imageCatalog.find((item: any) => item.id === selected.parentId).designBrief).toContain("左袖口");
    expect(api.submissions).toHaveLength(2);
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebar = page.locator("aside").getByRole("button", { name: "收起会话", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("chat-spec-mobile.png"), animations: "disabled" });
});

test("检查失败不修复或重绘，新创作缺底图明确提示不可核验", async ({ page, api }) => {
    const plans: any[] = []; let failReview = true;
    await setup(page, plans, (body, _index, route) => route.fulfill({ json: body.profileContext.stage === "review"
        ? { content: "", toolCalls: [{ id: "review", type: "function", function: { name: "report_image_review", arguments: JSON.stringify(failReview ? { summary: "invalid", checks: [] } : review) } }] }
        : answer() }));
    await send(page, "新建针织上衣"); await expect(generated(page)).toHaveCount(1);
    // Ant Design's leaving loading icon can prefix the accessible name even
    // after completion. Wait for enabled state, not a decorative icon's removal.
    const reviewButton = page.getByRole("button", { name: /检查结果$/ });
    await reviewButton.click();
    await expect(page.getByText(/检查未返回|检查报告|结果检查/).first()).toBeVisible();
    expect(plans).toHaveLength(2); expect(api.submissions).toHaveLength(1);
    expect(await page.getByTestId("chat-image-review").count()).toBe(0);
    failReview = false;
    await expect(reviewButton).toBeEnabled();
    await reviewButton.click();
    await expect(page.getByTestId("chat-image-review")).toContainText("未取得本轮底图");
    await expect(page.getByRole("button", { name: "准备纠正草稿", exact: true })).toBeDisabled();
    expect(plans).toHaveLength(3); expect(api.submissions).toHaveLength(1);
});

for (const destination of ["session", "owner"] as const) test(`检查迟到响应在切换${destination}后不得写入报告`, async ({ page, api, context }) => {
    const plans: any[] = []; let held: Route | undefined;
    await setup(page, plans, (body, _index, route) => {
        if (body.profileContext.stage === "review") { held = route; return Promise.resolve(); }
        return route.fulfill({ json: answer() });
    });
    await upload(page); await send(page, "左袖口改罗纹"); await expect(generated(page)).toHaveCount(1);
    await page.getByRole("button", { name: "检查结果", exact: true }).click();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (destination === "session") await page.getByRole("button", { name: "新对话", exact: true }).click();
    else {
        let sessionReads = 0;
        await context.route("**/api/auth/session", route => { sessionReads++; return route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "second", displayName: "第二员工", role: "designer", status: "active", creditBalance: 999 } } }); });
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => sessionReads).toBeGreaterThan(0);
    }
    await expect(generated(page)).toHaveCount(0);
    await held!.fulfill({ json: { content: "", toolCalls: [{ id: "review", type: "function", function: { name: "report_image_review", arguments: JSON.stringify(review) } }] } }).catch(() => undefined);
    if (destination === "owner") {
        await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "重新加载", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
        expect((await sessions(page)).flatMap((session: any) => session.messages)).toEqual([]);
        // Return through normal authenticated loading, never bypass the paused
        // workspace's storage guard to inspect another employee's records.
        await context.unroute("**/api/auth/session"); await page.reload();
        await expect(generated(page)).toHaveCount(1);
    }
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toBeEnabled();
    expect((await sessions(page)).flatMap((session: any) => session.messages).some((message: any) => message.generatedImages?.some((image: any) => image.review))).toBe(false);
    expect(await page.getByTestId("chat-image-review").count()).toBe(0);
    expect(plans).toHaveLength(2); expect(api.submissions).toHaveLength(1);
});

for (const mode of ["invalid-twice", "network", "privacy"] as const) test(`${mode}不循环修复也不提交图像任务`, async ({ page, api }) => {
    const plans: any[] = [];
    await setup(page, plans, (_body, _index, route) => mode === "invalid-twice" ? route.fulfill({ json: answer({ edit_spec: { changes: [] } }) }) : route.fulfill({ status: mode === "network" ? 500 : 422, json: { error: mode === "privacy" ? "PROMPT_PROFILE_PRIVACY_REJECTED" : "UPSTREAM_ERROR", message: "隔离拒绝", repairable: true, submitted: false } }));
    await send(page, "新画一件上衣"); await expect(page.locator('[data-message-role="error"]')).toBeVisible();
    expect(plans).toHaveLength(mode === "invalid-twice" ? 2 : 1); expect(api.submissions).toHaveLength(0);
});

test("检查只在手动点击后调用，报告随版本保存，准备纠正锁定实际底图且不发送", async ({ page, api }, info) => {
    const plans: any[] = [];
    await setup(page, plans, (body, _index, route) => route.fulfill({ json: body.profileContext.stage === "review" ? { content: "", toolCalls: [{ id: "review", type: "function", function: { name: "report_image_review", arguments: JSON.stringify(review) } }] } : answer() }));
    await upload(page); await send(page, "左袖口改罗纹"); await expect(generated(page)).toHaveCount(1);
    expect(plans).toHaveLength(1);
    await page.getByRole("button", { name: "检查结果", exact: true }).click();
    await expect(page.getByTestId("chat-image-review")).toContainText("非像素级认证");
    await expect(page.getByTestId("chat-image-review")).toContainText("发现疑点 · 纽扣数量");
    expect(plans).toHaveLength(2); expect(plans[1].profileContext.stage).toBe("review"); expect(api.submissions).toHaveLength(1);
    await page.reload(); await expect(page.getByTestId("chat-image-review")).toContainText(review.summary);
    const source = plans[1].profileContext.reviewContext.baseImageId;
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("保留我的草稿");
    await page.getByRole("button", { name: "准备纠正草稿", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toHaveValue("保留我的草稿");
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("");
    await page.getByRole("button", { name: "准备纠正草稿", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "对话内容", exact: true })).toHaveValue(/待核对线索/);
    expect((await sessions(page))[0].focusImageId).toBe(source);
    expect((await sessions(page))[0].focusLocked).toBe(true);
    await expect(page.locator("[data-image-agent-focus]")).toHaveCount(0);
    expect(plans).toHaveLength(2); expect(api.submissions).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("chat-review-correction.png"), animations: "disabled" });
    const latest = (await sessions(page))[0].messages.findLast((message: any) => message.generatedImages)?.generatedImages[0].id;
    await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("");
    await send(page, "继续当前图，加一个小圆点");
    await expect(generated(page)).toHaveCount(2);
    expect(plans[2].profileContext.lockedImageId).toBeUndefined();
    expect(plans[2].profileContext.focusImageId).toBe(latest);
    expect(api.submissions[1].parameters.inputArchive.references.map((image: any) => image.id)).toEqual([latest]);
});
