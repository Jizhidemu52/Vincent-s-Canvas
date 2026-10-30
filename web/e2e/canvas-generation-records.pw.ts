import type { Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { test, expect, MockCanvasApi } from "./fixtures";
import { performanceRaster } from "./canvas-performance-fixture";

const PROJECT = "70000000-0000-4000-8000-000000000001";
const ASSETS = { source: "71000000-0000-4000-8000-000000000001", a: "71000000-0000-4000-8000-000000000002", b: "71000000-0000-4000-8000-000000000003" };
const FINAL = "Exact archived prompt A\n保留原图轮廓；最终编译内容 / 100%";
const INPUT = "A 原始用户输入";
const assetUrl = (key: keyof typeof ASSETS) => `/api/assets/${ASSETS[key]}/content`;
const panel = (page: Page) => page.getByTestId("canvas-quick-generate-panel");
const editor = (page: Page) => panel(page).locator("textarea.cw-prompt");
const node = (api: MockCanvasApi, id: string) => api.document(PROJECT)!.nodes.find((item: any) => item.id === id);
async function select(page: Page, id: string) { await page.locator(`[data-node-id="${id}"]`).click({ position: { x: 30, y: 18 } }); }
async function scene(page: Page, api: MockCanvasApi) {
    for (const [index, id] of Object.values(ASSETS).entries()) api.assetBytes.set(id, performanceRaster(index, 256, 256));
    const record = (id: string, prompt: string, inputPrompt: string) => ({ version: 1, id: `run-${id}`, sourceNodeId: "original-reference", createdAt: "2026-10-01T00:00:00.000Z", prompt, inputPrompt,
        references: [{ id: "original-reference", referenceKey: "node:original-reference", name: "原始参考.png", type: "image/png", content: assetUrl("source"), sourceNodeId: "original-reference", origin: "canvas", order: 0 }],
        parameters: { model: "gpt-image-2", size: "1:1", quality: "medium", imageOptions: "", systemPrompt: "", count: 1, generationType: "edit" } });
    const image = (id: string, key: keyof typeof ASSETS, x: number, y: number) => ({ id, type: "image", title: id, position: { x, y }, width: 160, height: 160,
        metadata: { content: assetUrl(key), status: "success", naturalWidth: 256, naturalHeight: 256, mimeType: "image/png" } as Record<string, any> });
    const source = image("original-reference", "source", 0, 0), a = image("result-a", "a", 220, 0), b = image("result-b", "b", 440, 0);
    a.metadata = { ...a.metadata, prompt: FINAL, generationType: "edit", generationRecord: record("a", FINAL, INPUT), generationOrigin: { sourceNodeId: source.id, runId: "run-a", mode: "image" } };
    b.metadata = { ...b.metadata, prompt: "Exact archived B", generationType: "edit", generationRecord: record("b", "Exact archived B", "B 原始用户输入"), generationOrigin: { sourceNodeId: source.id, runId: "run-b", mode: "image" } };
    const document = { id: PROJECT, title: "生成档案隔离验收", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", nodes: [source, a, b],
        connections: [{ id: "source-a", fromNodeId: source.id, toNodeId: a.id }, { id: "source-b", fromNodeId: source.id, toNodeId: b.id }], groups: [], chatSessions: [], activeChatId: null,
        backgroundMode: "dots", showImageInfo: false, viewport: { x: 480, y: 220, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    api.documents.set(PROJECT, { id: PROJECT, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    await page.goto(`/canvas/${PROJECT}`);
    await expect(page.locator('[data-node-id="result-a"]')).toBeVisible();
    return structuredClone(document);
}
async function assertNoGeneration(api: MockCanvasApi) { expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]); }
function assertSubmittedReference(api: MockCanvasApi, key: keyof typeof ASSETS) {
    const urls = api.submissions[0]!.sourceUrls;
    expect(urls).toHaveLength(1);
    const submittedAsset = urls[0].split("/")[3];
    expect(api.assetBytes.get(submittedAsset)?.equals(api.assetBytes.get(ASSETS[key])!)).toBe(true);
    for (const other of (Object.keys(ASSETS) as Array<keyof typeof ASSETS>).filter(item => item !== key)) {
        expect(api.assetBytes.get(submittedAsset)?.equals(api.assetBytes.get(ASSETS[other])!)).toBe(false);
    }
}
async function completeDelayedTask(page: Page, api: MockCanvasApi) {
    await expect.poll(() => api.tasks.size).toBe(1);
    // Deliberately beyond the history debounce: completion must update the existing transaction.
    await page.waitForTimeout(450);
    const task = [...api.tasks.values()][0]!;
    task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`];
    return task;
}

test("selection restores archived inputs, rapid A/B draft switches are scoped and saved across reload", async ({ page, api }) => {
    const original = await scene(page, api);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await expect(panel(page).getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText(FINAL);
    await expect(panel(page).locator(".cw-reference-preview")).toHaveAttribute("src", assetUrl("source"));
    await panel(page).locator(".cw-reference-preview").scrollIntoViewIfNeeded();
    await expect(panel(page).locator(".cw-reference-preview")).toBeInViewport();
    expect(await panel(page).locator(".cw-reference-preview").getAttribute("src")).not.toBe(assetUrl("a"));
    await page.evaluate(() => {
        const samples: { input: number; selection: number }[] = []; (window as any).__draftSwitchSamples = samples;
        document.addEventListener("input", event => { if ((event.target as Element).matches("textarea.cw-prompt")) samples.push({ input: performance.now(), selection: 0 }); }, true);
        document.addEventListener("pointerdown", event => { if ((event.target as Element).closest("[data-node-id]") && samples.at(-1) && !samples.at(-1)!.selection) samples.at(-1)!.selection = performance.now(); }, true);
    });
    await editor(page).fill("A 独立快速草稿");
    await page.locator('[data-node-id="result-b"]').click({ force: true, position: { x: 30, y: 18 } });
    await expect(editor(page)).toHaveValue("B 原始用户输入");
    await editor(page).fill("B 独立快速草稿");
    await page.locator('[data-node-id="result-a"]').click({ force: true, position: { x: 30, y: 18 } });
    await expect(editor(page)).toHaveValue("A 独立快速草稿");
    const elapsed = await page.evaluate(() => (window as any).__draftSwitchSamples.map((sample: any) => sample.selection - sample.input));
    expect(elapsed).toHaveLength(2); for (const duration of elapsed) { expect(duration).toBeGreaterThan(0); expect(duration).toBeLessThan(180); }
    console.log(`Draft selection delays: ${elapsed.map((value: number) => `${value.toFixed(1)} ms`).join(", ")}`);
    await expect.poll(() => node(api, "result-a").metadata.draftPrompt).toBe("A 独立快速草稿");
    await expect.poll(() => node(api, "result-b").metadata.draftPrompt).toBe("B 独立快速草稿");
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    await page.reload(); await expect(editor(page)).toHaveValue("A 独立快速草稿");
    await select(page, "result-b"); await expect(editor(page)).toHaveValue("B 独立快速草稿");
    await assertNoGeneration(api);
});

test("viewing and normalizing settings leaves source metadata untouched; intentional settings changes persist only to that draft", async ({ page, api }) => {
    const original = await scene(page, api);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    const ratio = panel(page).getByRole("button", { name: "宽高比", exact: true });
    await expect(ratio).toHaveAttribute("title", "宽高比：1:1");
    await panel(page).getByRole("button", { name: "更多设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "图像高级设置", exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "返回创建面板", exact: true }).click();
    await expect(settings).toBeHidden();
    await select(page, "result-b");
    await expect(editor(page)).toHaveValue("B 原始用户输入");
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await expect.poll(() => api.document(PROJECT)!.selectedNodeIds).toEqual(["result-a"]);
    expect(api.document(PROJECT)!.nodes).toEqual(original.nodes);

    await ratio.click();
    await page.locator('[data-usage-control="size"][data-usage-value="1536x1024"]').click();
    await expect.poll(() => node(api, "result-a").metadata.size).toBe("1536x1024");
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    expect(node(api, "result-b")).toEqual(original.nodes[2]);
    await page.reload();
    await expect(editor(page)).toHaveValue(INPUT);
    await expect(ratio).toHaveAttribute("title", "宽高比：3:2");
    await assertNoGeneration(api);
});

test("deleted source only hides the reference; replay uses exact archived input and one undo/redo includes result and edge", async ({ page, api }, info) => {
    const original = await scene(page, api);
    await select(page, "original-reference"); await page.keyboard.press("Delete");
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(2);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await expect(panel(page).locator(".cw-reference-preview")).toHaveCount(0);
    // Display normalization must not turn viewing the archived input into a node edit.
    await expect(panel(page).getByRole("button", { name: "宽高比", exact: true })).toHaveAttribute("title", "宽高比：1:1");
    expect(node(api, "result-a").metadata.size).toBeUndefined();
    const before = structuredClone(api.document(PROJECT)!);
    before.nodes.find((item: any) => item.id === "result-a").metadata.draftPrompt = "新草稿不得污染再来一张";
    await page.evaluate(() => {
        const sample = { input: 0, replay: 0 }; (window as any).__rapidReplaySample = sample;
        document.addEventListener("input", event => { if ((event.target as Element).matches("textarea.cw-prompt")) sample.input = performance.now(); }, true);
        document.addEventListener("click", event => { if ((event.target as Element).closest("button")?.textContent?.includes("再来一张")) sample.replay = performance.now(); }, true);
    });
    await editor(page).fill("新草稿不得污染再来一张");
    api.taskStatus = "queued";
    await panel(page).getByRole("button", { name: "再来一张", exact: true }).click({ force: true });
    const elapsed = await page.evaluate(() => { const sample = (window as any).__rapidReplaySample; return sample.replay - sample.input; });
    expect(elapsed).toBeGreaterThan(0); expect(elapsed).toBeLessThan(180);
    console.log(`Rapid archived replay: ${elapsed.toFixed(1)} ms`);
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]!.prompt).toBe(FINAL);
    assertSubmittedReference(api, "source");
    await completeDelayedTask(page, api);
    await expect.poll(() => api.document(PROJECT)!.nodes.filter((item: any) => !before.nodes.some((old: any) => old.id === item.id) && item.metadata.status === "success").length).toBe(1);
    const after = structuredClone(api.document(PROJECT)!);
    expect(after.nodes.slice(0, 2)).toEqual(before.nodes);
    const created = after.nodes.find((item: any) => !before.nodes.some((old: any) => old.id === item.id));
    expect(created.metadata.generationRecord.prompt).toBe(FINAL);
    expect(created.metadata.generationRecord.references[0].content).toBe(assetUrl("source"));
    expect(after.connections).toHaveLength(before.connections.length + 1);
    expect(after.connections.some((edge: any) => edge.fromNodeId === "result-a" && edge.toNodeId === created.id)).toBe(true);
    await page.screenshot({ path: info.outputPath("archived-replay-appends.png") });
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(PROJECT)!.nodes).toEqual(before.nodes);
    expect(api.document(PROJECT)!.connections).toEqual(before.connections);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => api.document(PROJECT)!.nodes).toEqual(after.nodes);
    expect(api.document(PROJECT)!.connections).toEqual(after.connections);
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    expect(api.submissions).toHaveLength(1); expect(api.batchSubmissions).toEqual([]);
});

test("continue and E only prepare A as a draft reference; delayed quick generation appends in one history step", async ({ page, api }) => {
    const original = await scene(page, api);
    await select(page, "result-a");
    await panel(page).getByRole("button", { name: "基于此图继续", exact: true }).click();
    await expect(editor(page)).toHaveValue("");
    await expect(panel(page).locator(".cw-reference-preview")).toHaveAttribute("src", assetUrl("a"));
    await assertNoGeneration(api);
    await editor(page).fill("这个草稿会被 E 清空");
    await select(page, "result-b"); await select(page, "result-a");
    await page.keyboard.press("e");
    await expect(editor(page)).toHaveValue("");
    await expect(panel(page).locator(".cw-reference-preview")).toHaveAttribute("src", assetUrl("a"));
    await assertNoGeneration(api);
    await editor(page).fill("基于 A 的新草稿");
    await select(page, "result-b"); await select(page, "result-a");
    await expect.poll(() => node(api, "result-a").metadata.draftPrompt).toBe("基于 A 的新草稿");
    const before = structuredClone(api.document(PROJECT)!);
    api.taskStatus = "queued";
    await panel(page).getByRole("button", { name: /^生成修改图/ }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    assertSubmittedReference(api, "a");
    expect(api.submissions[0]!.prompt).toContain("基于 A 的新草稿");
    expect(api.submissions[0]!.prompt).not.toContain(FINAL);
    await completeDelayedTask(page, api);
    await expect.poll(() => api.document(PROJECT)!.nodes.filter((item: any) => !before.nodes.some((old: any) => old.id === item.id) && item.metadata.status === "success").length).toBe(1);
    const after = structuredClone(api.document(PROJECT)!);
    expect(after.nodes.slice(0, 3)).toEqual(before.nodes);
    const created = after.nodes.find((item: any) => !before.nodes.some((old: any) => old.id === item.id));
    expect(created.metadata.generationRecord.prompt).toBe(api.submissions[0]!.prompt);
    expect(created.metadata.generationRecord.inputPrompt).toBe("基于 A 的新草稿");
    expect(after.connections).toHaveLength(before.connections.length + 1);
    await page.keyboard.press("Control+z");
    await expect.poll(() => api.document(PROJECT)!.nodes).toEqual(before.nodes);
    expect(api.document(PROJECT)!.connections).toEqual(before.connections);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => api.document(PROJECT)!.nodes).toEqual(after.nodes);
    expect(api.document(PROJECT)!.connections).toEqual(after.connections);
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    expect(api.submissions).toHaveLength(1); expect(api.batchSubmissions).toEqual([]);
});

test("record controls remain usable in both languages and themes without changing the archive", async ({ page, api }, info) => {
    const original = await scene(page, api);
    await select(page, "result-a");
    await editor(page).fill("可编辑草稿；保存原档案");
    for (const locale of ["zh-CN", "en"] as const) {
        if (locale === "en") await page.getByTestId("language-switch").filter({ visible: true }).first().click();
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        for (const dark of [false, true]) {
            const darkButton = page.getByRole("button", { name: locale === "en" ? "Switch to dark theme" : "切换到深色主题", exact: true });
            const lightButton = page.getByRole("button", { name: locale === "en" ? "Switch to light theme" : "切换到浅色主题", exact: true });
            if (dark && await darkButton.isVisible()) await darkButton.click();
            if (!dark && await lightButton.isVisible()) await lightButton.click();
            await expect(dark ? lightButton : darkButton).toBeVisible();
            await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
            await expect(panel(page).getByRole("button", { name: locale === "en" ? "Generate again" : "再来一张", exact: true })).toBeInViewport();
            await expect(panel(page).getByRole("button", { name: locale === "en" ? "Continue from this image" : "基于此图继续", exact: true })).toBeInViewport();
            await expect(editor(page)).toHaveValue("可编辑草稿；保存原档案");
            await page.screenshot({ path: info.outputPath(`record-${locale}-${dark ? "dark" : "light"}.png`), animations: "disabled" });
            await panel(page).locator(".cw-reference-preview").scrollIntoViewIfNeeded();
            await expect(panel(page).locator(".cw-reference-preview")).toBeInViewport();
            await expect(panel(page).locator(".cw-reference-preview")).toHaveAttribute("src", assetUrl("source"));
            await panel(page).getByTestId("canvas-generation-record").scrollIntoViewIfNeeded();
        }
    }
    await panel(page).getByRole("button", { name: "Restore original prompt", exact: true }).click();
    await expect(editor(page)).toHaveValue(INPUT);
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    await assertNoGeneration(api);
});

test("toolbar undo flushes a sub-180ms draft before undoing and preserves the prior move and redo", async ({ page, api }, info) => {
    await scene(page, api);
    await select(page, "result-a");
    const box = await page.locator('[data-node-id="result-a"]').boundingBox();
    if (!box) throw new Error("A node is missing");
    await page.mouse.move(box.x + 30, box.y + 18);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 58, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => node(api, "result-a").position).toEqual({ x: 280, y: 40 });
    const moved = structuredClone(node(api, "result-a"));
    const movedBox = await page.locator('[data-node-id="result-a"]').boundingBox();
    const undo = page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "撤销", exact: true });
    const redo = page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "重做", exact: true });
    await expect(undo).toBeEnabled();
    await page.evaluate(() => {
        const sample = { input: 0, undo: 0 }; (window as any).__draftUndoSample = sample;
        document.addEventListener("input", event => { if ((event.target as Element).matches("textarea.cw-prompt")) sample.input = performance.now(); }, true);
        document.addEventListener("click", event => { if ((event.target as Element).closest('[data-usage-control="undo"]')) sample.undo = performance.now(); }, true);
    });
    await editor(page).fill("不到180毫秒就撤销的新草稿");
    await undo.click({ force: true });
    const elapsed = await page.evaluate(() => { const sample = (window as any).__draftUndoSample; return sample.undo - sample.input; });
    expect(elapsed).toBeGreaterThan(0); expect(elapsed).toBeLessThan(180);
    // Allow the old draft/history timer to settle; DOM checks do not depend on the longer cloud-save debounce.
    await page.waitForTimeout(750);
    const afterUndo = structuredClone(api.document(PROJECT)!);
    const afterUndoBox = await page.locator('[data-node-id="result-a"]').boundingBox();
    const evidence = info.outputPath("rapid-toolbar-undo-state.json");
    await writeFile(evidence, JSON.stringify({ elapsedMs: elapsed, moved, movedBox, afterUndoBox, afterUndo, redoEnabled: await redo.isEnabled() }, null, 2));
    await info.attach("rapid-toolbar-undo-state", { path: evidence, contentType: "application/json" });
    console.log(`Rapid toolbar undo: ${elapsed.toFixed(1)} ms; position=${JSON.stringify(node(api, "result-a").position)}; draft=${JSON.stringify(node(api, "result-a").metadata.draftPrompt)}; redo=${await redo.isEnabled()}`);
    expect(afterUndoBox?.x).toBe(movedBox?.x); expect(afterUndoBox?.y).toBe(movedBox?.y);
    await expect(redo).toBeEnabled();
    await select(page, "result-a"); await expect(editor(page)).toHaveValue(INPUT);
    await redo.click();
    await expect.poll(() => node(api, "result-a").metadata.draftPrompt).toBe("不到180毫秒就撤销的新草稿");
    expect(node(api, "result-a").position).toEqual(moved.position);
    await select(page, "result-a"); await expect(editor(page)).toHaveValue("不到180毫秒就撤销的新草稿");
    await assertNoGeneration(api);
});
