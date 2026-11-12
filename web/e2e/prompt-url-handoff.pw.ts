import type { Page } from "@playwright/test";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";
import { generalPromptTemplates } from "../../shared/general-prompt-templates";
import { toolDefinitions } from "../../shared/feature-catalog";
import { antSelect, chooseAntSelect } from "./antd-select-helpers";

const OWNER = "00000000-0000-4000-8000-000000000099";
const TEMPLATE = generalPromptTemplates.find(item => item.id === "precise-local-recolor")!;
const FIRST = "URL_HANDOFF_TASK_1：原有领口调整，不得覆盖";
const SECOND = "URL_HANDOFF_TASK_2：原有袖口调整，不得覆盖";
const THIRD = "URL_HANDOFF_TASK_3：已有草稿，取消替换后必须保留";
const REFERENCE = "task-3-original-reference.png";
const MODELS = [
    { id: "10000000-0000-4000-8000-000000000026", name: "aplmart-gpt2.6-flare" },
    { id: "10000000-0000-4000-8000-000000000027", name: "aplmart-gpt2.6-sunburst" },
].map(model => ({ ...model, modelId: model.id, publicName: model.name, imageParameterProfile: "quality-resolution-v2", imageSupportsMask: true, capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 }));
const active = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
const input = (page: Page) => active(page).getByRole("textbox", { name: "图像提示词", exact: true });

async function settings(page: Page) {
    await active(page).getByRole("button", { name: "切换生成图片模型", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^切换生成图片模型/ });
    await expect(dialog).toBeVisible();
    return dialog;
}

/** Observe only: all task creation, draft input, settings and upload use the UI. */
async function readDrafts(page: Page) {
    return page.evaluate(async owner => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const registry = createWorkspaceStorage("generation_workbench_tasks");
        const boardKey = JSON.stringify(["image-edit", null, null]);
        const state = await registry.getItem<{ activeId: string; tasks: Array<{ id: string; number: number }> }>(JSON.stringify([owner, boardKey]));
        if (!state) throw new Error("Expected the UI-created image-edit task registry");
        const drafts = createWorkspaceStorage("generation_drafts");
        return { activeId: state.activeId, tasks: await Promise.all(state.tasks.map(async task => {
            const scope = task.id === "default" ? "image-edit" : `image-edit:task:${task.id}`;
            return { ...task, scope, prompt: (await drafts.getItem<string>(`${scope}:prompt`)) ?? "",
                settings: await drafts.getItem<Record<string, unknown>>(`${scope}:settings`),
                references: (await drafts.getItem<Array<Record<string, unknown>>>(`${scope}:references`)) ?? [] };
        })) };
    }, OWNER);
}

async function prepareThreeTasks(page: Page, targetPrompt = "") {
    await page.goto("/image?tool=image-edit");
    await expect(tabs(page).first()).toContainText("草稿");
    await input(page).fill(FIRST);
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs(page).nth(1)).toContainText("草稿");
    await input(page).fill(SECOND);
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(tabs(page).nth(2)).toContainText("草稿");
    await expect(input(page)).toHaveValue("");
    if (targetPrompt) await input(page).fill(targetPrompt);

    const dialog = await settings(page);
    await dialog.locator('[data-usage-control="model"][role="combobox"]').click();
    await page.locator(`[role="option"][data-usage-value="${MODELS[1].id}"]`).click();
    await chooseAntSelect(dialog.getByRole("combobox", { name: "宽高比", exact: true }), "16:9");
    await chooseAntSelect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }), "2K");
    await chooseAntSelect(dialog.getByRole("combobox", { name: "图片质量", exact: true }), "高");
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    await chooseAntSelect(dialog.getByRole("combobox", { name: "输出格式", exact: true }), "PNG");
    await dialog.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await active(page).getByRole("button", { name: "上传图片", exact: true }).click();
    await (await chooser).setFiles({ name: REFERENCE, mimeType: "image/png", buffer: IMAGE });
    await expect(active(page).getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: REFERENCE, exact: true })).toBeVisible();
    await expect.poll(async () => {
        const draft = await readDrafts(page);
        return { active: draft.activeId === draft.tasks[2]?.id, prompts: draft.tasks.map(item => item.prompt), refs: draft.tasks[2]?.references.length,
            model: draft.tasks[2]?.settings?.imageModel, size: draft.tasks[2]?.settings?.size, quality: draft.tasks[2]?.settings?.quality };
    }).toEqual({ active: true, prompts: [FIRST, SECOND, targetPrompt], refs: 1, model: MODELS[1].id, size: "16:9", quality: "high" });
    const before = await readDrafts(page);
    expect(JSON.parse(String(before.tasks[2].settings!.imageOptions))).toMatchObject({ resolution: "2k", output_format: "png" });
    return before;
}

async function fillFromRealTemplateDetails(page: Page, template = TEMPLATE) {
    await page.goto("/prompts");
    await page.getByPlaceholder("搜索标题、完整提示词或分类").fill(template.title);
    const card = page.locator(`[data-general-prompt-id="${template.id}"]`);
    await card.getByRole("button", { name: `查看完整提示词：${template.title}`, exact: true }).click();
    const detail = page.getByRole("dialog", { name: template.title, exact: true });
    await expect(detail.getByText(template.prompt, { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: template.targetTool === "video" ? "填入 视频生成" : "填入 图片编辑", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(template.targetTool === "video" ? "/video" : "/image");
    expect(new URL(page.url()).searchParams.get("tool")).toBe(template.targetTool === "video" ? null : "image-edit");
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
}

function expectNoGeneration(api: MockCanvasApi) {
    expect(api.submissions, "Template handoff must not submit a model task").toEqual([]);
    expect(api.batchSubmissions, "Template handoff must not submit a model batch").toEqual([]);
}

async function expectTargetOptions(page: Page) {
    await expect(active(page).getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: REFERENCE, exact: true })).toBeVisible();
    const dialog = await settings(page);
    await expect(dialog.locator('[data-usage-control="model"][role="combobox"]')).toContainText(/sunburst/i);
    await expect(antSelect(dialog.getByRole("combobox", { name: "宽高比", exact: true }))).toHaveText("16:9");
    await expect(antSelect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }))).toHaveText("2K");
    await expect(antSelect(dialog.getByRole("combobox", { name: "图片质量", exact: true }))).toHaveText("高");
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    await expect(antSelect(dialog.getByRole("combobox", { name: "输出格式", exact: true }))).toHaveText("PNG");
    await dialog.getByRole("button", { name: "关闭模型设置", exact: true }).click();
}

async function holdDraftDelivery(page: Page, scope: string) {
    // Hold delivery after the real IndexedDB read/access.run has settled. Holding
    // IDB onsuccess would keep storage-access's shared transaction barrier busy
    // and prevent the task-registry writes that this race is supposed to exercise.
    await page.route("**/src/lib/workspace-storage.ts*", async route => {
        const response = await route.fetch();
        const source = await response.text();
        expect(source.match(/return value;/g), "Inject only the completed getItem return, never the database transaction").toHaveLength(1);
        await route.fulfill({ response, body: source.replace("return value;", "await window.__promptUrlReadGate?.wait(storeName, key);\nreturn value;") });
    });
    await page.addInitScript(targetScope => {
        const holding = new Set([`${targetScope}:prompt`, `${targetScope}:settings`]);
        const callbacks: Array<{ key: string; resolve: () => void }> = [];
        const gate = (window as any).__promptUrlReadGate = {
            pending: [] as string[],
            wait(storeName: string, key: string) {
                if (storeName !== "generation_drafts" || !holding.has(key)) return Promise.resolve();
                gate.pending.push(key);
                return new Promise<void>(resolve => callbacks.push({ key, resolve }));
            },
            release(field?: "prompt" | "settings") {
                const keys = field ? [`${targetScope}:${field}`] : [...holding];
                for (const key of keys) holding.delete(key);
                for (const item of callbacks.filter(item => keys.includes(item.key))) {
                    callbacks.splice(callbacks.indexOf(item), 1);
                    item.resolve();
                }
            },
        };
    }, scope);
}

test.beforeEach(async ({ context, api }) => {
    // Install overrides after the safety fixture's catch-all interception.
    expectNoGeneration(api);
    await context.route("**/api/models", route => route.fulfill({ json: { models: MODELS, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    await context.route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0, page: 1, pageSize: 24 } }));
});

test("ordinary prompt URL fills only active task 3, preserves its inputs, and is consumed once", async ({ page, api }, info) => {
    const before = await prepareThreeTasks(page);
    await fillFromRealTemplateDetails(page);
    await expect.soft(input(page), "The full template belongs to the navigation-time active task 3, not hidden default task 1").toHaveValue(TEMPLATE.prompt);
    const after = await readDrafts(page);
    await info.attach("prompt-url-handoff-before-after", { body: JSON.stringify({ before, after, url: page.url(), modelPosts: api.submissions, batchPosts: api.batchSubmissions }, null, 2), contentType: "application/json" });
    expect.soft(after.tasks[0], "Hidden task 1 must retain its sentinel and all draft fields").toEqual(before.tasks[0]);
    expect.soft(after.tasks[1], "Hidden task 2 must retain its sentinel and all draft fields").toEqual(before.tasks[1]);
    expect.soft(after.tasks[2].settings, "Target model and parameters are not template inputs").toEqual(before.tasks[2].settings);
    expect.soft(after.tasks[2].references, "Target original reference must remain unchanged").toEqual(before.tasks[2].references);
    expectNoGeneration(api);
    // Keep a failing baseline focused on the actual ownership defect.
    if (info.errors.length) return;
    await expect.poll(() => new URL(page.url()).searchParams.has("prompt")).toBe(false);
    await expectTargetOptions(page);
    const edited = "URL_HANDOFF_AFTER_EDIT：我已修改模板，不得重新灌入";
    await input(page).fill(edited);
    await expect.poll(async () => (await readDrafts(page)).tasks[2].prompt).toBe(edited);
    for (const [index, text] of [[0, FIRST], [1, SECOND], [2, edited]] as const) {
        await tabs(page).nth(index).click();
        await expect(input(page)).toHaveValue(text);
    }
    await page.reload();
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(input(page)).toHaveValue(edited);
    await expectTargetOptions(page);
    const restored = await readDrafts(page);
    expect(restored.tasks[0]).toEqual(before.tasks[0]);
    expect(restored.tasks[1]).toEqual(before.tasks[1]);
    expect(restored.tasks[2]).toEqual({ ...before.tasks[2], prompt: edited });
    expectNoGeneration(api);
});

test("ordinary prompt URL confirms an occupied active draft; cancel keeps it and consumes the URL", async ({ page, api }) => {
    const before = await prepareThreeTasks(page, THIRD);
    await fillFromRealTemplateDetails(page);
    const confirmation = page.getByRole("dialog", { name: "替换当前草稿？", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(input(page)).toHaveValue(THIRD);
    await confirmation.getByRole("button", { name: "保留草稿", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.has("prompt")).toBe(false);
    expect(await readDrafts(page)).toEqual(before);
    await tabs(page).nth(1).click();
    await expect(input(page)).toHaveValue(SECOND);
    await tabs(page).nth(2).click();
    await expect(input(page)).toHaveValue(THIRD);
    await page.reload();
    await expect(tabs(page).nth(2)).toContainText("草稿");
    await expect(input(page)).toHaveValue(THIRD);
    await expect(confirmation).toHaveCount(0);
    expect(await readDrafts(page)).toEqual(before);
    await expectTargetOptions(page);
    expectNoGeneration(api);
});

test("ordinary prompt URL freezes task 3 while its prompt and settings reads are delayed", async ({ page, api }) => {
    const before = await prepareThreeTasks(page);
    const target = before.tasks[2];
    await holdDraftDelivery(page, target.scope);
    await fillFromRealTemplateDetails(page);
    await expect.poll(() => page.evaluate(() => (window as any).__promptUrlReadGate.pending)).toEqual(expect.arrayContaining([`${target.scope}:prompt`, `${target.scope}:settings`]));
    await expect(tabs(page).nth(2)).toContainText("读取中");
    await expect(input(page)).toHaveValue("");
    expect(new URL(page.url()).searchParams.get("prompt")).toBe(TEMPLATE.prompt);
    await tabs(page).nth(1).click();
    await expect(input(page)).toHaveValue(SECOND);
    await page.evaluate(() => (window as any).__promptUrlReadGate.release("prompt"));
    await tabs(page).nth(2).click();
    await expect(tabs(page).nth(2)).toContainText("读取中");
    await expect(input(page)).toHaveValue("");
    await tabs(page).nth(1).click();
    await page.evaluate(() => (window as any).__promptUrlReadGate.release("settings"));
    await expect(tabs(page).nth(2)).toContainText("草稿");
    await expect(input(page), "Changing tabs during restoration must not retarget the URL to task 2").toHaveValue(SECOND);
    await tabs(page).nth(2).click();
    await expect(input(page)).toHaveValue(TEMPLATE.prompt);
    await expect.poll(() => new URL(page.url()).searchParams.has("prompt")).toBe(false);
    const after = await readDrafts(page);
    expect(after.tasks[0]).toEqual(before.tasks[0]);
    expect(after.tasks[1]).toEqual(before.tasks[1]);
    expect(after.tasks[2]).toEqual({ ...target, prompt: TEMPLATE.prompt });
    await expectTargetOptions(page);
    expectNoGeneration(api);
});

const VIDEO_TEMPLATE = generalPromptTemplates.find(item => item.id === "video-product-subtle-motion")!;
const VIDEO_MODELS = [
    { id: "10000000-0000-4000-8000-000000000003", name: "E2E Wan Video", modelId: "wan2.7" },
    { id: "10000000-0000-4000-8000-000000000004", name: "E2E Seedance Video", modelId: "doubao-seedance-2.5" },
].map(model => ({ ...model, capabilities: ["video"], creditCost: 0, rmbCost: 0 }));
const videoInput = (page: Page) => active(page).getByRole("textbox", { name: "视频提示词", exact: true });

async function readVideoDrafts(page: Page) {
    return page.evaluate(async owner => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const state = await createWorkspaceStorage("generation_workbench_tasks").getItem<{ activeId: string; tasks: Array<{ id: string; number: number }> }>(JSON.stringify([owner, "video"]));
        if (!state) throw new Error("Expected the UI-created video task registry");
        const drafts = createWorkspaceStorage("generation_drafts");
        return { activeId: state.activeId, tasks: await Promise.all(state.tasks.map(async task => {
            const key = (field: string) => task.id === "default" ? `video:${field}` : `video:${field}:task:${task.id}`;
            return { ...task, prompt: (await drafts.getItem<string>(key("prompt"))) ?? "",
                settings: await drafts.getItem<Record<string, unknown>>(key("settings")),
                references: (await drafts.getItem<Array<Record<string, unknown>>>(key("references"))) ?? [],
                motion: await drafts.getItem(key("motion")), rawPrompt: await drafts.getItem(key("raw-prompt")) };
        })) };
    }, OWNER);
}

async function prepareVideoTasks(page: Page, targetPrompt: string) {
    await page.route("**/api/models", route => route.fulfill({ json: { models: VIDEO_MODELS, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    await page.goto("/video");
    for (const [index, value] of [FIRST, SECOND, targetPrompt].entries()) {
        if (index) await page.getByRole("button", { name: "新建任务", exact: true }).click();
        await expect(tabs(page).nth(index)).toHaveAttribute("aria-selected", "true");
        await expect(tabs(page).nth(index)).toContainText("草稿");
        await expect(videoInput(page)).toHaveValue("");
        if (value) await videoInput(page).fill(value);
    }
    await active(page).getByRole("button", { name: "调整", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "参数", exact: true });
    await dialog.locator('[data-usage-control="model"][role="combobox"]').click();
    await page.locator(`[role="option"][data-usage-value="${VIDEO_MODELS[0].id}"]`).click();
    await dialog.getByRole("button", { name: /^720p$/i }).click();
    await dialog.getByRole("combobox", { name: "视频时长", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: /^7 秒$/ }).click();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(async () => {
        const result = await readVideoDrafts(page);
        return { prompts: result.tasks.map(task => task.prompt), model: result.tasks[2].settings?.videoModel,
            seconds: result.tasks[2].settings?.videoSeconds, quality: result.tasks[2].settings?.vquality };
    }).toEqual({ prompts: [FIRST, SECOND, targetPrompt], model: "wan2.7", seconds: "7", quality: "720P" });
    return readVideoDrafts(page);
}

for (const occupied of [false, true]) test(`video template URL ${occupied ? "cancel preserves occupied" : "fills empty"} active task 3 without changing hidden tasks or submitting`, async ({ page, api }) => {
    const before = await prepareVideoTasks(page, occupied ? THIRD : "");
    await fillFromRealTemplateDetails(page, VIDEO_TEMPLATE);
    const confirmation = page.getByRole("dialog", { name: "替换当前草稿？", exact: true });
    if (occupied) {
        await expect(confirmation).toBeVisible();
        await expect(videoInput(page)).toHaveValue(THIRD);
        await confirmation.getByRole("button", { name: "保留草稿", exact: true }).click();
        await expect(confirmation).toBeHidden();
    } else await expect(videoInput(page)).toHaveValue(VIDEO_TEMPLATE.prompt);
    await expect.poll(() => new URL(page.url()).searchParams.has("prompt")).toBe(false);
    const expected = occupied ? before : { ...before, tasks: before.tasks.map((task, index) => index === 2 ? { ...task, prompt: VIDEO_TEMPLATE.prompt } : task) };
    await expect.poll(() => readVideoDrafts(page)).toEqual(expected);
    expectNoGeneration(api);
    const edited = occupied ? THIRD : "VIDEO_AFTER_TEMPLATE_EDIT：只保留我的后续调整";
    if (!occupied) await videoInput(page).fill(edited);
    await expect.poll(async () => (await readVideoDrafts(page)).tasks[2].prompt).toBe(edited);
    for (const [index, value] of [[0, FIRST], [1, SECOND], [2, edited]] as const) {
        await tabs(page).nth(index).click();
        await expect(videoInput(page)).toHaveValue(value);
    }
    await page.reload();
    await expect(tabs(page).nth(2)).toContainText("草稿");
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(videoInput(page)).toHaveValue(edited);
    await expect(confirmation).toHaveCount(0);
    const afterReload = await readVideoDrafts(page);
    expect(afterReload.tasks[0]).toEqual(before.tasks[0]);
    expect(afterReload.tasks[1]).toEqual(before.tasks[1]);
    expect(afterReload.tasks[2]).toEqual({ ...before.tasks[2], prompt: edited });
    expectNoGeneration(api);
});

test("ordinary prompt/model URL stays with loading task 3 when task 4 is created; confirm changes only its prompt/model and consumes only those query fields", async ({ page, api }) => {
    const before = await prepareThreeTasks(page, THIRD);
    const target = before.tasks[2];
    const fourth = "URL_HANDOFF_NEW_TASK_4：后创建任务不得接收原交接";
    await holdDraftDelivery(page, target.scope);
    // Unlike a generic template, an ordinary recreate URL may also carry a model.
    // Keep unrelated repeated query values and the fragment throughout consumption.
    const params = new URLSearchParams({ tool: "image-edit", prompt: TEMPLATE.prompt, model: MODELS[0].id, source: "ordinary-url-boundary" });
    params.append("keep", "first value");
    params.append("keep", "第二个值");
    await page.goto(`/image?${params}#reference-panel`);
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => page.evaluate(() => (window as any).__promptUrlReadGate.pending)).toEqual(expect.arrayContaining([`${target.scope}:prompt`, `${target.scope}:settings`]));
    await expect(tabs(page).nth(2)).toContainText("读取中");
    const confirmation = page.getByRole("dialog", { name: "替换当前草稿？", exact: true });
    await expect(confirmation).toHaveCount(0);

    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(tabs(page)).toHaveCount(4);
    await expect(tabs(page).nth(3)).toHaveAttribute("aria-selected", "true");
    await expect(tabs(page).nth(3)).toContainText("草稿");
    await expect(input(page), "A newly mounted task must not inherit the pending URL").toHaveValue("");
    await input(page).fill(fourth);
    await page.evaluate(() => (window as any).__promptUrlReadGate.release());
    await expect(tabs(page).nth(2)).toContainText("草稿");
    await expect(tabs(page).nth(3)).toHaveAttribute("aria-selected", "true");
    await expect(input(page)).toHaveValue(fourth);
    await expect(confirmation, "Do not ask task 4 to confirm replacement of task 3").toHaveCount(0);
    await expect.poll(async () => (await readDrafts(page)).tasks[3]?.prompt).toBe(fourth);
    const ready = await readDrafts(page);
    expect(ready.tasks.slice(0, 3)).toEqual(before.tasks);
    expect(ready.tasks[3].settings, "Task 4 must not receive even the model part of the URL").toBeNull();
    expect(ready.tasks[3].references).toEqual([]);
    expect(new URL(page.url()).searchParams.get("prompt")).toBe(TEMPLATE.prompt);
    expect(new URL(page.url()).searchParams.get("model")).toBe(MODELS[0].id);

    await tabs(page).nth(2).click();
    await expect(confirmation).toBeVisible();
    await expect(input(page)).toHaveValue(THIRD);
    expect((await readDrafts(page)).tasks[2]).toEqual(target);
    await confirmation.getByRole("button", { name: "确认替换", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(input(page)).toHaveValue(TEMPLATE.prompt);
    await expect.poll(() => {
        const url = new URL(page.url());
        return { pathname: url.pathname, query: [...url.searchParams.entries()], hash: url.hash };
    }).toEqual({ pathname: "/image", query: [["tool", "image-edit"], ["source", "ordinary-url-boundary"], ["keep", "first value"], ["keep", "第二个值"]], hash: "#reference-panel" });
    await expect.poll(async () => (await readDrafts(page)).tasks[2]).toEqual({
        ...target, prompt: TEMPLATE.prompt, settings: { ...target.settings, imageModel: MODELS[0].id },
    });
    const after = await readDrafts(page);
    expect(after.tasks[0]).toEqual(before.tasks[0]);
    expect(after.tasks[1]).toEqual(before.tasks[1]);
    expect(after.tasks[3]).toEqual(ready.tasks[3]);
    await expect(active(page).getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name: REFERENCE, exact: true })).toBeVisible();
    const dialog = await settings(page);
    await expect(dialog.locator('[data-usage-control="model"][role="combobox"]')).toContainText(/flare/i);
    await expect(antSelect(dialog.getByRole("combobox", { name: "宽高比", exact: true }))).toHaveText("16:9");
    await expect(antSelect(dialog.getByRole("combobox", { name: "清晰度 / 分辨率", exact: true }))).toHaveText("2K");
    await expect(antSelect(dialog.getByRole("combobox", { name: "图片质量", exact: true }))).toHaveText("高");
    await dialog.locator("summary", { hasText: "高级参数" }).click();
    await expect(antSelect(dialog.getByRole("combobox", { name: "输出格式", exact: true }))).toHaveText("PNG");
    await dialog.getByRole("button", { name: "关闭模型设置", exact: true }).click();
    await tabs(page).nth(3).click();
    await expect(input(page)).toHaveValue(fourth);
    await expect(confirmation).toHaveCount(0);
    expectNoGeneration(api);
});
