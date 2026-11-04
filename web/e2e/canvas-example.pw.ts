import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect, newCanvas, uploadImage, type MockCanvasApi } from "./fixtures";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog";
import { readCanvasViewState } from "./canvas-view-state";
import { canvasExampleControlSteps, canvasExampleControlPrefix } from "../src/lib/canvas/canvas-example-controls";
import { canvasExampleControlProof, canvasExamplePractices } from "../src/lib/canvas/canvas-example-practices";

const lessons = [
    ["view", "01", "导航与视图"], ["nodes", "02", "节点与素材"], ["config", "03", "配置节点与参考角色"],
    ["connections", "04", "连线与串行工作流"], ["batch", "05", "批量处理围巾"], ["versions", "06", "原图、版本与任务记录"],
    ["local", "07", "图片编辑与局部改色"], ["compare", "08", "对比、分组与排版"], ["assistant", "09", "助手与当前图"], ["delivery", "10", "交付与画布管理"],
] as const;
const graphOnly = (document: any) => JSON.stringify({ nodes: document.nodes, connections: document.connections, groups: document.groups, history: document.history, chatSessions: document.chatSessions });
const assetHashes = (api: MockCanvasApi) => [...api.assetBytes.entries()].map(([id, bytes]) => [id, createHash("sha256").update(bytes).digest("hex")]);

async function createTeachingCanvas(page: Page, api: MockCanvasApi) {
    await page.goto("/canvas");
    await page.getByRole("button", { name: "新建教学画布", exact: true }).click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    await expect(page.getByTestId("canvas-example-navigator")).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect.poll(() => api.document(id)?.nodes.length ?? 0).toBeGreaterThan(60);
    return id;
}

async function lessonArea(page: Page, number: string, title: string, area: "看案例" | "到练习") {
    const nav = page.getByTestId("canvas-example-navigator");
    await nav.getByRole("button", { name: "教学目录", exact: true }).click();
    await nav.getByRole("button", { name: `${number} ${title}：${area}`, exact: true }).click();
    await expect(nav.getByRole("button", { name: "教学目录", exact: true })).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(20, 130);
}

test("独立教学画布可定位十类图文案例，旧项目与原图字节保持不变，零生成提交", async ({ page, api }, testInfo) => {
    const oldId = await newCanvas(page);
    await uploadImage(page, "existing-original.png");
    await expect.poll(() => api.document(oldId)?.nodes.length).toBe(1);
    await expect.poll(async () => (await readCanvasViewState(page, oldId))?.history?.past.length ?? 0).toBeGreaterThan(0);
    await page.goto("/canvas");
    await expect(page.getByRole("button", { name: "新建教学画布", exact: true })).toBeEnabled();
    const originalHistory = JSON.stringify((await readCanvasViewState(page, oldId))?.history);
    const original = graphOnly(api.document(oldId));
    const originalBytes = assetHashes(api);
    const oldDocuments = api.documents.size;
    await page.getByRole("button", { name: "新建教学画布", exact: true }).click();
    await expect(page.getByTestId("canvas-example-navigator")).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(id).not.toBe(oldId);
    await expect.poll(() => api.document(id)?.nodes.length ?? 0).toBeGreaterThan(60);
    expect(api.documents.size).toBe(oldDocuments + 1);
    const graph = api.document(id)!;
    expect(graph.nodes.every((node: any) => node.metadata.status === "idle" && !node.metadata.sourceTaskId && !node.metadata.generationRecord && !node.metadata.imageTask && !node.metadata.mediaTask)).toBe(true);
    expect(graph.chatSessions).toEqual([]);
    expect(graph.connections.some((edge: any) => edge.kind === "config-sequence")).toBe(true);
    const initialGraph = graphOnly(graph);
    for (const [key, number, title] of lessons) {
        await lessonArea(page, number, title, "看案例");
        const cases = page.locator(`[data-node-id^="canvas-example-${key}-case-"]`);
        const practice = canvasExamplePractices[key];
        await expect(cases).toHaveCount(practice.resultImage ? 6 : 4);
        const explanationId = graph.nodes.find((node: any) => node.id.startsWith(`canvas-example-${key}-case-`) && node.title.includes("实操简注")).id;
        await expect(page.locator(`[data-node-id="${explanationId}"]`)).toContainText(practice.evidence);
        const images = cases.locator("img");
        await expect(images).toHaveCount(practice.resultImage ? 3 : 2);
        for (const image of graph.nodes.filter((node: any) => node.id.startsWith(`canvas-example-${key}-case-`) && node.type === "image")) await expect.poll(() => page.locator(`[data-node-id="${image.id}"] img`).first().evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(image.metadata.naturalWidth);
        const text = cases.locator("div.whitespace-pre-wrap");
        for (const node of await text.all()) {
            const size = await node.evaluate(element => ({ overflow: element.scrollHeight - element.clientHeight, text: element.textContent?.slice(0, 60) }));
            expect(size, JSON.stringify(size)).toMatchObject({ overflow: 0 });
        }
        if (key === "config") await page.screenshot({ path: testInfo.outputPath("03-configuration-case.png") });
    }
    await lessonArea(page, "05", "批量处理围巾", "到练习");
    const batch = page.locator('[data-node-id^="canvas-example-batch-practice-"]').filter({ has: page.getByRole("button", { name: "执行 3 个任务", exact: true }) });
    await expect(batch).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("05-batch-practice.png") });
    const nav = page.getByTestId("canvas-example-navigator");
    for (const [area, label, imageCount, configCount] of [["connections-branches", "一图多方案", 1, 3], ["batch-shared", "共享配置", 3, 1]] as const) {
        await nav.getByRole("button", { name: "教学目录", exact: true }).click();
        await nav.getByRole("button", { name: label, exact: true }).click();
        await page.mouse.move(20, 130);
        const section = page.locator(`[data-node-id^="canvas-example-${area}-"]`);
        const sourceNodes = graph.nodes.filter((node: any) => node.type === "image" && node.id.startsWith(`canvas-example-${area}-`));
        expect(sourceNodes).toHaveLength(imageCount);
        for (const source of sourceNodes) await expect.poll(() => page.locator(`[data-node-id="${source.id}"] img`).first().evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(1536);
        await expect(section.filter({ has: page.getByRole("radio", { name: "生图", exact: true }) })).toHaveCount(configCount);
        if (area === "batch-shared") await expect(section.getByRole("button", { name: "执行 3 个任务", exact: true })).toBeVisible();
        for (const note of graph.nodes.filter((node: any) => node.type === "text" && node.id.startsWith(`canvas-example-${area}-`))) {
            const size = await page.locator(`[data-node-id="${note.id}"] div.whitespace-pre-wrap`).evaluate(element => ({ overflow: element.scrollHeight - element.clientHeight, text: element.textContent?.slice(0, 60) }));
            expect(size, JSON.stringify(size)).toMatchObject({ overflow: 0 });
        }
        await page.screenshot({ path: testInfo.outputPath(`${area}.png`) });
    }
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.locator(".cw-workspace")).toHaveAttribute("data-theme", "dark");
    await nav.getByRole("button", { name: "教学目录", exact: true }).click();
    await page.mouse.move(20, 130);
    await page.screenshot({ path: testInfo.outputPath("shared-directory-dark.png") });
    await nav.getByRole("button", { name: "关闭教学目录", exact: true }).click();
    expect(graphOnly(api.document(oldId))).toBe(original);
    expect(JSON.stringify((await readCanvasViewState(page, oldId))?.history)).toBe(originalHistory);
    expect(assetHashes(api)).toEqual(originalBytes);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
    await page.reload();
    await expect(page.getByTestId("canvas-example-navigator")).toBeVisible();
    expect(graphOnly(api.document(id))).toBe(initialGraph);
    expect(graphOnly(api.document(oldId))).toBe(original);
    expect(JSON.stringify((await readCanvasViewState(page, oldId))?.history)).toBe(originalHistory);
    expect(assetHashes(api)).toEqual(originalBytes);
    const secondId = await createTeachingCanvas(page, api);
    expect(secondId).not.toBe(id);
    expect(secondId).not.toBe(oldId);
    expect(api.documents.size).toBe(oldDocuments + 2);
    expect(graphOnly(api.document(oldId))).toBe(original);
    expect(JSON.stringify((await readCanvasViewState(page, oldId))?.history)).toBe(originalHistory);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("教学不启用模型或付费模块，关闭能力时仍可读教程但生成禁用", async ({ page, context, api }) => {
    await context.route("**/api/modules", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: !["canvas-image", "canvas-batch", "canvas-chat", "canvas-local-tools"].includes(item.moduleKey) })) }) }));
    await context.route("**/api/models", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: false, modelConfigId: null, configurationVersion: 1 })) }) }));
    const id = await createTeachingCanvas(page, api);
    await lessonArea(page, "03", "配置节点与参考角色", "到练习");
    const configId = api.document(id)!.nodes.find((node: any) => node.type === "config" && node.id.startsWith("canvas-example-config-practice-")).id;
    const config = page.locator(`[data-node-id="${configId}"]`);
    await expect(config).toContainText("当前功能已停用");
    await expect(config.getByRole("button", { name: "合并参考生成 1 张", exact: true })).toBeDisabled();
    expect(api.document(id)!.nodes.find((node: any) => node.id === configId).metadata.model).toBeUndefined();
    await page.reload();
    await expect(page.getByTestId("canvas-example-navigator")).toBeVisible();
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("教学目录在手机宽度可键盘关闭且不遮住底部工具栏", async ({ page, api }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createTeachingCanvas(page, api);
    const nav = page.getByTestId("canvas-example-navigator");
    await nav.getByRole("button", { name: "教学目录", exact: true }).click();
    const panel = page.locator("#canvas-example-directory");
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThan(780);
    await page.screenshot({ path: testInfo.outputPath("mobile-directory.png") });
    await panel.getByRole("button", { name: "回到使用说明", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(nav.getByRole("button", { name: "教学目录", exact: true })).toBeFocused();
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("身份变化后教学目录随工作区暂停，不继续创建或修改前一员工画布", async ({ page, context, api }) => {
    const id = await createTeachingCanvas(page, api);
    const before = graphOnly(api.document(id));
    const count = api.documents.size;
    await context.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "00000000-0000-4000-8000-000000000088", username: "other", displayName: "教学隔离账号B", role: "designer", status: "active" } } }));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "登录状态已变化，工作区已暂停", exact: true })).toBeVisible();
    await expect(page.getByTestId("canvas-example-navigator")).toHaveCount(0);
    expect(api.documents.size).toBe(count);
    expect(graphOnly(api.document(id))).toBe(before);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("每个小功能可搜索定位，实操截图与未实测说明清楚区分且不截字", async ({ page, api }, testInfo) => {
    test.setTimeout(150_000);
    const id = await createTeachingCanvas(page, api);
    const graph = api.document(id)!;
    const before = graphOnly(graph);
    const nav = page.getByTestId("canvas-example-navigator");
    const openControls = async () => {
        await nav.getByRole("button", { name: "教学目录", exact: true }).click();
        await nav.getByRole("button", { name: /^按钮详解/ }).click();
    };
    await openControls();
    const controls = nav.locator("button[data-control-key]");
    await expect(controls).toHaveCount(canvasExampleControlSteps.length);
    expect(await controls.evaluateAll(buttons => buttons.filter(button => (button as HTMLButtonElement).disabled).length)).toBe(0);
    expect((await controls.evaluateAll(buttons => buttons.map(button => button.getAttribute("data-control-key")))).sort()).toEqual(canvasExampleControlSteps.map(item => item.key).sort());
    const search = nav.getByRole("textbox", { name: "搜索画布按钮或功能", exact: true });
    await search.fill("不存在的教学按钮ABC");
    await expect(nav).toContainText("未找到对应按钮");
    await search.fill("");
    await nav.getByRole("button", { name: "关闭教学目录", exact: true }).click();

    // Longest card in every topic catches real CJK wrapping; explicit settings
    // and comparison samples cover the user's two most important sub-controls.
    const longest = lessons.map(([lesson]) => canvasExampleControlSteps.filter(item => item.guide.lessonId === lesson).sort((a, b) => {
        const height = (key: string) => graph.nodes.find((node: any) => node.type === "text" && node.id.startsWith(canvasExampleControlPrefix(key)))?.height || 0;
        return height(b.key) - height(a.key);
    })[0]!);
    const important = ["detail-config-composer--0", "detail-crop-confirm--1", "detail-compare-picker--2", "detail-compare-modes--3", "detail-compare-modes--4", ...Array.from({ length: 7 }, (_, index) => `shell-copy-history--${index}`), "shell-delete--0"].map(key => canvasExampleControlSteps.find(item => item.key === key)!);
    const sample = [...new Map([...longest, ...important].map(item => [item.key, item])).values()];
    for (const { key, guide, step } of sample) {
        await openControls();
        await search.fill(step.control);
        const item = nav.locator(`button[data-control-key="${key}"]`);
        await expect(item).toBeVisible();
        await item.click();
        const card = page.locator(`[data-node-id^="${canvasExampleControlPrefix(key)}"]`);
        const proof = canvasExampleControlProof[key];
        await expect(card).toHaveCount(proof ? 2 : 1);
        const text = card.locator("div.whitespace-pre-wrap");
        await expect(text).toContainText(step.action);
        await expect(text).toContainText(proof?.evidence || "用法说明 · 未逐项实测");
        if (proof?.annotation) await expect(text).toContainText(proof.annotation);
        const size = await text.evaluate(element => ({ overflow: element.scrollHeight - element.clientHeight, width: element.scrollWidth - element.clientWidth }));
        expect(size, `${key}: ${step.control}`).toEqual({ overflow: 0, width: 0 });
        if (proof) await expect.poll(() => card.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(1366);
        if (["detail-config-composer--0", "detail-compare-modes--3", "shell-copy-history--0", "shell-delete--0"].includes(key)) {
            await page.mouse.move(20, 130);
            await page.screenshot({ path: testInfo.outputPath(`${key}.png`) });
        }
    }
    await openControls();
    await search.fill("改款后透明度");
    const guide = nav.locator('[data-guide-id="detail-compare-modes"]');
    await expect(guide).toContainText("改款后透明度");
    await guide.getByRole("button", { name: "到对应练习区", exact: true }).click();
    await expect(page.locator('[data-node-id^="canvas-example-compare-practice-"] img')).toHaveCount(2);
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await openControls();
    await search.fill("配置");
    await page.screenshot({ path: testInfo.outputPath("controls-directory-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = (await page.locator("#canvas-example-directory").boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThan(780);
    await page.screenshot({ path: testInfo.outputPath("controls-directory-mobile.png") });
    await search.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#canvas-example-directory")).toBeHidden();
    await expect(nav.getByRole("button", { name: "教学目录", exact: true })).toBeFocused();
    expect(graphOnly(api.document(id))).toBe(before);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});

test("已有作品左上操作案例新建独立教学板，包款高级对比可切换模式而不改原图", async ({ page, api }, testInfo) => {
    page.setDefaultTimeout(15_000);
    const oldId = await newCanvas(page);
    await uploadImage(page, "preserved-work.png");
    await expect.poll(() => api.document(oldId)?.nodes.length).toBe(1);
    const original = graphOnly(api.document(oldId));
    const originalBytes = assetHashes(api);
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "操作案例", exact: true }).click();
    await expect(page.getByTestId("canvas-example-navigator")).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(id).not.toBe(oldId);
    await expect.poll(() => api.document(id)?.nodes.length ?? 0).toBeGreaterThan(60);
    await lessonArea(page, "08", "对比、分组与排版", "到练习");
    const graph = api.document(id)!;
    const images = graph.nodes.filter((node: any) => node.type === "image" && node.id.startsWith("canvas-example-compare-practice-"));
    expect(images).toHaveLength(2);
    const before = graphOnly(graph);
    await page.locator(`[data-node-id="${images[1].id}"]`).click({ position: { x: 90, y: 70 } });
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "高级对比 · 差异图与导出", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "改款前后对比", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "选择改款前图片", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择改款前图片", exact: true });
    // The real picker deduplicates identical media, including locked teaching
    // images. Select the first visible representative of the same source bytes.
    const sourceCandidate = graph.nodes.find((node: any) => node.type === "image" && node.metadata.content === images[0].metadata.content);
    await picker.getByRole("textbox", { name: "搜索对比图片", exact: true }).fill(sourceCandidate.title);
    await picker.locator(`[data-compare-candidate="${sourceCandidate.id}"]`).click();
    const preview = dialog.getByLabel("改款前后对比预览", { exact: true });
    await expect(preview).toBeVisible();
    for (const mode of ["并排", "叠加", "差异图", "滑块"]) {
        await dialog.locator(".ant-segmented-item-label").filter({ hasText: new RegExp(`^${mode}$`) }).click();
        await expect(dialog.getByRole("radio", { name: mode, exact: true })).toBeChecked();
        await expect(preview).toBeVisible();
        await expect(dialog.getByRole("button", { name: "导出预览 PNG", exact: true })).toBeEnabled();
        if (mode === "叠加") {
            await expect(dialog.getByText("改款后透明度", { exact: true })).toBeVisible();
            await dialog.getByRole("slider").focus();
            await page.keyboard.press("ArrowRight");
            await expect(dialog.getByRole("slider")).toHaveAttribute("aria-valuenow", "51");
            await page.screenshot({ path: testInfo.outputPath("comparison-practice-overlay.png") });
        }
    }
    await dialog.getByRole("button", { name: "交换前后", exact: true }).click();
    await expect(preview).toBeVisible();
    await dialog.locator(".ant-modal-close").click();
    expect(graphOnly(api.document(id))).toBe(before);
    expect(graphOnly(api.document(oldId))).toBe(original);
    expect(assetHashes(api)).toEqual(originalBytes);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
