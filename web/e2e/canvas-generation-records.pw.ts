import type { Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { test, expect, MockCanvasApi, newCanvas } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { performanceRaster } from "./canvas-performance-fixture";
import { readCanvasViewState } from "./canvas-view-state";

const PROJECT = "70000000-0000-4000-8000-000000000001";
const ASSETS = { source: "71000000-0000-4000-8000-000000000001", a: "71000000-0000-4000-8000-000000000002", b: "71000000-0000-4000-8000-000000000003" };
const FINAL = "Exact archived prompt A\n保留原图轮廓；最终编译内容 / 100%";
const INPUT = "A 原始用户输入";
const provenanceModels = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].map((modelId, index) => ({
    id: `provenance-model-${index}`, modelId, name: modelId, publicName: `出图模型${index + 1}`, protocol: "openai", capabilities: ["generate", "edit"],
    isFeatured: true, creditCost: 0, rmbCost: 0,
}));
const assetUrl = (key: keyof typeof ASSETS) => `/api/assets/${ASSETS[key]}/content`;
const panel = (page: Page) => page.getByTestId("canvas-quick-generate-panel");
const editor = (page: Page) => panel(page).locator("textarea.cw-prompt");
const node = (api: MockCanvasApi, id: string) => api.document(PROJECT)!.nodes.find((item: any) => item.id === id);
async function select(page: Page, id: string, force = false) {
    await page.locator(`[data-node-id="${id}"]`).click({ force, position: { x: 30, y: 18 } });
    if (id === "original-reference") return;
    // A plain image click must restore that image's own inputs, without AI Edit.
    await editor(page).blur();
}
async function scene(page: Page, api: MockCanvasApi, legacy = false, referenceCount = 1) {
    for (const [index, id] of Object.values(ASSETS).entries()) api.assetBytes.set(id, performanceRaster(index, 256, 256));
    const references = Array.from({ length: referenceCount }, (_, index) => {
        const retained = index === referenceCount - 1, id = retained ? "original-reference" : `removed-reference-${index + 1}`;
        const assetId = retained ? ASSETS.source : `72000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        if (!retained) api.assetBytes.set(assetId, performanceRaster(index + 3, 256, 256));
        return { id, referenceKey: `node:${id}`, name: retained ? "原始参考.png" : `已离画布参考${index + 1}.png`, type: "image/png",
            content: `/api/assets/${assetId}/content`, sourceNodeId: id, origin: "canvas", order: index };
    });
    const record = (id: string, prompt: string, inputPrompt: string) => ({ version: 1, id: `run-${id}`, sourceNodeId: "original-reference", createdAt: "2026-10-01T00:00:00.000Z", prompt, inputPrompt,
        references,
        parameters: { model: "gpt-image-2", size: "1:1", quality: "medium", imageOptions: "", systemPrompt: "", count: 1, generationType: "edit" } });
    const image = (id: string, key: keyof typeof ASSETS, x: number, y: number) => ({ id, type: "image", title: id, position: { x, y }, width: 160, height: 160,
        metadata: { content: assetUrl(key), status: "success", naturalWidth: 256, naturalHeight: 256, mimeType: "image/png" } as Record<string, any> });
    const source = image("original-reference", "source", 0, 0), a = image("result-a", "a", 220, 0), b = image("result-b", "b", 440, 0);
    a.metadata = { ...a.metadata, prompt: FINAL, generationType: "edit", generationRecord: record("a", FINAL, INPUT), generationOrigin: { sourceNodeId: source.id, runId: "run-a", mode: "image" } };
    if (legacy) { delete a.metadata.generationRecord; a.metadata.model = "gpt-image-2"; a.metadata.generationType = "generation"; a.metadata.references = []; }
    b.metadata = { ...b.metadata, prompt: "Exact archived B", generationType: "edit", generationRecord: record("b", "Exact archived B", "B 原始用户输入"), generationOrigin: { sourceNodeId: source.id, runId: "run-b", mode: "image" } };
    const document = { id: PROJECT, title: "生成档案隔离验收", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", nodes: [source, a, b],
        connections: [{ id: "source-a", fromNodeId: source.id, toNodeId: a.id }, { id: "source-b", fromNodeId: source.id, toNodeId: b.id }], groups: [], chatSessions: [], activeChatId: null,
        backgroundMode: "dots", showImageInfo: false, viewport: { x: 480, y: 220, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    api.documents.set(PROJECT, { id: PROJECT, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    await page.goto(`/canvas/${PROJECT}`);
    await expect(page.locator('[data-node-id="result-a"]')).toBeVisible();
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await expect(panel(page)).toBeVisible();
    return structuredClone(document);
}
async function assertNoGeneration(api: MockCanvasApi) { expect(api.submissions).toEqual([]); expect(api.batchSubmissions).toEqual([]); }
async function assertReferencePreview(page: Page, key: keyof typeof ASSETS) {
    const preview = panel(page).locator("img.cw-reference-preview");
    await expect(preview).toHaveCount(1);
    await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    // Previews may be cached WebP blob URLs. Verify their image identity, not
    // that a thumbnail still uses the archive's original content URL.
    const errors = await preview.evaluate(async (image, candidates) => {
        const pixels = async (url: string) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
            const context = canvas.getContext("2d")!;
            context.drawImage(bitmap, 0, 0, 32, 32); bitmap.close();
            return context.getImageData(0, 0, 32, 32).data;
        };
        const actual = await pixels((image as HTMLImageElement).currentSrc);
        return await Promise.all(candidates.map(async candidate => {
            const expected = await pixels(candidate.url);
            const error = actual.reduce((sum, value, index) => sum + (index % 4 === 3 ? 0 : Math.abs(value - expected[index]!)), 0) / (32 * 32 * 3);
            return { key: candidate.key, error };
        }));
    }, (Object.keys(ASSETS) as Array<keyof typeof ASSETS>).map(key => ({ key, url: assetUrl(key) })));
    errors.sort((a, b) => a.error - b.error);
    expect(errors[0]!.key).toBe(key);
    expect(errors[0]!.error).toBeLessThan(8);
}
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

test("creation reference count includes 18 removed sources and recovers only after explicit removal", async ({ page, api }, info) => {
    const original = await scene(page, api, false, 19);
    const archived = structuredClone(original.nodes[1]!.metadata.generationRecord);
    await select(page, "result-a");
    const form = panel(page), action = form.getByRole("button", { name: /^生成修改图/ });
    await expect(editor(page)).toHaveValue(INPUT);
    await expect(form.locator(".cw-reference-heading")).toContainText("参考图 ·19");
    await expect(form.locator(".cw-reference-preview")).toHaveCount(19);
    expect(await form.locator(".cw-reference-number").allTextContents()).toEqual(Array.from({ length: 19 }, (_, index) => String(index + 1)));
    await expect(action).toBeDisabled();
    await expect(form.getByRole("alert")).toContainText("0 至 16 张参考图");
    await assertNoGeneration(api);
    await form.screenshot({ path: info.outputPath("all-19-request-references-visible.png") });
    const lastReference = form.getByRole("button", { name: "参考图 19：原始参考.png，点击调整顺序", exact: true });
    await lastReference.scrollIntoViewIfNeeded();
    await expect(lastReference).toBeVisible();
    await expect(lastReference.locator(".cw-reference-number")).toHaveText("19");
    await form.screenshot({ path: info.outputPath("last-reference-19-is-scrollable.png") });

    for (let removed = 0; removed < 3; removed++) await form.getByRole("button", { name: "移除参考图 1", exact: true }).click();
    await expect(form.locator(".cw-reference-heading")).toContainText("参考图 ·16");
    await expect(form.locator(".cw-reference-preview")).toHaveCount(16);
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(action).toBeEnabled();
    await expect(editor(page)).toHaveValue(INPUT);
    await expect.poll(() => node(api, "result-a").metadata.draftImageReferences?.length).toBe(16);
    expect(node(api, "result-a").metadata.generationRecord).toEqual(archived);
    expect(node(api, "result-a").metadata.draftImageReferences.map((reference: any) => reference.content)).toEqual(archived.references.slice(3).map((reference: any) => reference.content));
    await action.click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]!.sourceUrls).toHaveLength(16);
    for (const [index, url] of api.submissions[0]!.sourceUrls.entries()) {
        const submitted = api.assetBytes.get(url.split("/")[3]);
        const expected = api.assetBytes.get(archived.references[index + 3].content.split("/")[3]);
        expect(submitted?.equals(expected!), `Reference ${index + 1} keeps its displayed order and original bytes`).toBe(true);
    }
    expect(api.submissions[0]!.modelConfigId).toBe("10000000-0000-4000-8000-000000000001");
    expect(api.submissions[0]!.prompt).toContain(INPUT);
    expect(node(api, "result-a").metadata.generationRecord).toEqual(archived);
    expect(node(api, "original-reference")).toEqual(original.nodes[0]);
});

test("one retained reference remains valid and submits exactly the displayed image", async ({ page, api }) => {
    const original = await scene(page, api);
    await select(page, "original-reference"); await page.keyboard.press("Delete");
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(2);
    await select(page, "result-a");
    const form = panel(page), action = form.getByRole("button", { name: /^生成修改图/ });
    await expect(form.locator(".cw-reference-heading")).toContainText("参考图 ·1");
    await expect(form.locator(".cw-reference-preview")).toHaveCount(1);
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(action).toBeEnabled();
    await action.click();
    await expect.poll(() => api.submissions.length).toBe(1);
    assertSubmittedReference(api, "source");
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
});

test("clearing retained references persists an empty draft and submits no hidden images", async ({ page, api }) => {
    const original = await scene(page, api, false, 19);
    await select(page, "result-a");
    await panel(page).getByRole("button", { name: "清空", exact: true }).click();
    await expect(panel(page).locator(".cw-reference-preview")).toHaveCount(0);
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
    await expect(editor(page)).toHaveValue(INPUT);
    await expect.poll(() => node(api, "result-a").metadata.draftImageReferences).toEqual([]);
    await assertNoGeneration(api);

    await page.reload();
    await select(page, "result-a");
    await expect(panel(page).locator(".cw-reference-preview")).toHaveCount(0);
    const action = panel(page).getByRole("button", { name: /^生成(?:\s|$)/ });
    await expect(action).toBeEnabled();
    await action.click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]!.sourceUrls || []).toEqual([]);
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    expect(node(api, "original-reference")).toEqual(original.nodes[0]);
});

test("three concurrent models keep their own prompt/model through out-of-order completion, plain selection and reload", async ({ page, context, api }) => {
    const models = provenanceModels;
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    const projectId = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    api.taskStatus = "queued";
    const prompts = ["第一张蓝色围巾", "第二张绿色围巾", "第三张紫色围巾"];
    for (let index = 0; index < models.length; index++) {
        await panel(page).getByRole("combobox", { name: "选择模型", exact: true }).click();
        await page.getByTestId("canvas-model-picker-menu").getByRole("option", { name: models[index]!.publicName, exact: true }).click();
        await editor(page).fill(prompts[index]!);
        await panel(page).getByRole("button", { name: /^生成(?:\s|$)/ }).click();
        await expect.poll(() => api.submissions.length).toBe(index + 1);
        await expect(editor(page)).toBeEnabled();
    }
    expect(api.tasks.size).toBe(3);
    expect([...api.tasks.values()].every(task => task.status === "queued")).toBe(true);
    const tasks = [...api.tasks.values()];
    for (const index of [2, 0, 1]) {
        const task = tasks[index]!;
        task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`];
        await expect.poll(() => api.document(projectId)?.nodes.some((item: any) => item.metadata?.sourceTaskId === task.id && item.metadata.status === "success")).toBe(true);
    }
    const outputs = tasks.map(task => api.document(projectId)!.nodes.find((item: any) => item.metadata?.sourceTaskId === task.id));
    expect(outputs).toHaveLength(3);
    for (const [index, output] of outputs.entries()) {
        expect(output.metadata.generationRecord.parameters.model).toBe(models[index]!.modelId);
        expect(output.metadata.generationRecord.prompt).toBe(prompts[index]);
    }
    // Frame all results so every selection is a real visible-node click.
    await page.keyboard.press("Shift+1");
    const check = async () => {
        for (const index of [1, 0, 2, 1]) {
            await select(page, outputs[index].id);
            await expect(panel(page).getByTestId("canvas-generation-model")).toHaveText(`生成时模型${models[index]!.publicName}`);
            await expect(panel(page).getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText(prompts[index]!);
        }
    };
    await check();
    await page.reload();
    await expect(panel(page)).toBeVisible();
    await check();
    expect(api.submissions).toHaveLength(3);
});

test("a selected new result retains its prompt through delayed completion, cloud acknowledgement and idle time without reselection", async ({ page, api }, info) => {
    const projectId = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const input = "等待完成及自动保存后也必须保留的围巾提示词";
    const finalPrompt = `${input}\n服务器最终记录：保留蓝色条纹。`;
    api.taskStatus = "queued";
    await editor(page).fill(input);
    await panel(page).getByRole("button", { name: /^生成(?:\s|$)/ }).click();
    await expect.poll(() => api.tasks.size).toBe(1);
    const task = [...api.tasks.values()][0]!;
    await expect.poll(() => api.document(projectId)?.nodes.find((item: any) => item.metadata?.sourceTaskId === task.id)?.metadata.prompt).toBe(input);
    const outputId = api.document(projectId)!.nodes.find((item: any) => item.metadata?.sourceTaskId === task.id).id;
    // Keep the automatically selected placeholder selected for the entire completion/save lifecycle.
    await expect(editor(page)).toHaveValue(input);
    await expect(panel(page).getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText(input);
    await expect(panel(page).getByTestId("canvas-generation-model")).toHaveText("生成时模型出图模型");
    api.holdWrites = true;
    task.prompt = finalPrompt;
    task.status = "success";
    task.resultUrls = [`/api/assets/${task.id}/content`];
    await expect(page.locator(`[data-node-id="${outputId}"] img`).first()).toBeVisible();
    await expect(editor(page)).toHaveValue(input);
    await expect(panel(page).getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText(finalPrompt);
    await expect.poll(() => api.pendingWrites()).toBeGreaterThan(0);
    await api.releaseWrites();
    await expect.poll(() => api.document(projectId)?.nodes.find((item: any) => item.id === outputId)?.metadata.status).toBe("success");
    // Sample across multiple autosave/observer ticks rather than hiding a transient clear with a later click.
    const samples = await page.evaluate(async () => {
        const rows: Array<{ input: string; original: string; model: string }> = [];
        const started = performance.now();
        while (performance.now() - started < 5_000) {
            const rail = document.querySelector('[data-testid="canvas-quick-generate-panel"]')!;
            rows.push({ input: (rail.querySelector("textarea.cw-prompt") as HTMLTextAreaElement)?.value || "", original: rail.querySelector('[aria-label="复制生成时提示词"]')?.textContent || "", model: rail.querySelector('[data-testid="canvas-generation-model"]')?.textContent || "" });
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return rows;
    });
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.every(sample => sample.input === input && sample.original === finalPrompt && sample.model === "生成时模型出图模型")).toBe(true);
    const saved = structuredClone(api.document(projectId)!.nodes.find((item: any) => item.id === outputId).metadata);
    expect(saved).toMatchObject({ prompt: finalPrompt, generationRecord: { prompt: finalPrompt, inputPrompt: input, parameters: { model: "gpt-image-2" } } });
    expect(saved.draftPrompt).not.toBe("");
    await page.reload();
    await expect(editor(page)).toHaveValue(input);
    await expect(panel(page).getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText(finalPrompt);
    await expect(panel(page).getByTestId("canvas-generation-model")).toHaveText("生成时模型出图模型");
    // An intentionally empty continuation draft is not a missing generation record.
    await panel(page).getByRole("button", { name: "基于此图继续", exact: true }).click();
    await expect(editor(page)).toHaveValue("");
    await expect.poll(() => api.document(projectId)!.nodes.find((item: any) => item.id === outputId).metadata.draftPrompt).toBe("");
    const continued = structuredClone(api.document(projectId)!.nodes.find((item: any) => item.id === outputId).metadata);
    expect(continued.generationRecord).toEqual(saved.generationRecord);
    await page.reload();
    await expect(editor(page)).toHaveValue("");
    await expect(panel(page).getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText(finalPrompt);
    await expect(panel(page).getByTestId("canvas-generation-model")).toHaveText("生成时模型出图模型");
    const evidence = info.outputPath("delayed-result-prompt-lifecycle.json");
    await writeFile(evidence, JSON.stringify({ sampleCount: samples.length, samples, saved, continued }, null, 2));
    await info.attach("delayed-result-prompt-lifecycle", { path: evidence, contentType: "application/json" });
    expect(api.submissions).toHaveLength(1);
});

test("selecting a pure upload clears the previous result prompt and labels missing generation evidence", async ({ page, api }) => {
    const original = await scene(page, api);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await select(page, "original-reference");
    await expect(editor(page)).toHaveValue("");
    await expect(panel(page).getByTestId("canvas-generation-model")).toContainText("未记录，无法确认");
    await expect(panel(page).getByTestId("canvas-generation-prompt-missing")).toHaveText("未记录生成提示词");
    expect(api.document(PROJECT)!.nodes).toEqual(original.nodes);
    await assertNoGeneration(api);
});

test("changing a legacy or uploaded image draft model never rewrites historical model evidence", async ({ page, context, api }) => {
    await context.route("**/api/models", route => route.fulfill({ json: { models: provenanceModels, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) } }));
    await scene(page, api, true);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(FINAL);
    await expect(panel(page).getByTestId("canvas-generation-model")).toContainText("出图模型1");
    await panel(page).getByRole("combobox", { name: "选择模型", exact: true }).click();
    await page.getByTestId("canvas-model-picker-menu").getByRole("option", { name: "出图模型2", exact: true }).click();
    await expect.poll(() => node(api, "result-a").metadata.draftModel).toBe("gpt-image-2.5-flare");
    expect(node(api, "result-a").metadata.model).toBe("gpt-image-2");
    await expect(panel(page).getByTestId("canvas-generation-model")).toContainText("出图模型1");
    await select(page, "original-reference");
    await panel(page).getByRole("combobox", { name: "选择模型", exact: true }).click();
    await page.getByTestId("canvas-model-picker-menu").getByRole("option", { name: "出图模型3", exact: true }).click();
    await expect.poll(() => node(api, "original-reference").metadata.draftModel).toBe("gpt-image-2.5-sunburst");
    expect(node(api, "original-reference").metadata.model).toBeUndefined();
    await expect(panel(page).getByTestId("canvas-generation-model")).toContainText("未记录，无法确认");
    await page.reload();
    await select(page, "result-a");
    await expect(panel(page).getByRole("combobox", { name: "选择模型", exact: true })).toContainText("出图模型2");
    await expect(panel(page).getByTestId("canvas-generation-model")).toContainText("出图模型1");
    await expect(editor(page)).toHaveValue(FINAL);
    await assertNoGeneration(api);
});

test("plain image selection restores archived inputs, rapid A/B draft switches are scoped and saved across reload", async ({ page, api }) => {
    const original = await scene(page, api);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await expect(panel(page).getByRole("button", { name: "复制生成时提示词", exact: true })).toHaveText(FINAL);
    await assertReferencePreview(page, "source");
    await panel(page).locator(".cw-reference-preview").scrollIntoViewIfNeeded();
    await expect(panel(page).locator(".cw-reference-preview")).toBeInViewport();
    await page.evaluate(() => {
        const samples: { input: number; selection: number }[] = []; (window as any).__draftSwitchSamples = samples;
        document.addEventListener("input", event => { if ((event.target as Element).matches("textarea.cw-prompt")) samples.push({ input: performance.now(), selection: 0 }); }, true);
        document.addEventListener("pointerdown", event => { if ((event.target as Element).closest("[data-node-id]") && samples.at(-1) && !samples.at(-1)!.selection) samples.at(-1)!.selection = performance.now(); }, true);
    });
    await editor(page).fill("A 独立快速草稿");
    await select(page, "result-b", true);
    await expect(editor(page)).toHaveValue("B 原始用户输入");
    await editor(page).fill("B 独立快速草稿");
    await select(page, "result-a", true);
    await expect(editor(page)).toHaveValue("A 独立快速草稿");
    const elapsed = await page.evaluate(() => (window as any).__draftSwitchSamples.map((sample: any) => sample.selection - sample.input));
    expect(elapsed).toHaveLength(2); for (const duration of elapsed) { expect(duration).toBeGreaterThan(0); expect(duration).toBeLessThan(180); }
    console.log(`Draft selection delays: ${elapsed.map((value: number) => `${value.toFixed(1)} ms`).join(", ")}`);
    await expect.poll(() => node(api, "result-a").metadata.draftPrompt).toBe("A 独立快速草稿");
    await expect.poll(() => node(api, "result-b").metadata.draftPrompt).toBe("B 独立快速草稿");
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    await page.reload(); await select(page, "result-a"); await expect(editor(page)).toHaveValue("A 独立快速草稿");
    await select(page, "result-b"); await expect(editor(page)).toHaveValue("B 独立快速草稿");
    await assertNoGeneration(api);
});

test("viewing and normalizing settings leaves source metadata untouched; intentional settings changes persist only to that draft", async ({ page, api }) => {
    const original = await scene(page, api);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    const ratio = panel(page).getByRole("button", { name: "宽高比", exact: true });
    await expect(ratio).toHaveText("1:1");
    await panel(page).getByRole("button", { name: "更多设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "图像高级设置", exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "返回创建面板", exact: true }).click();
    await expect(settings).toBeHidden();
    await select(page, "result-b");
    await expect(editor(page)).toHaveValue("B 原始用户输入");
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await expect.poll(async () => (await readCanvasViewState(page, PROJECT))?.selectedNodeIds).toEqual(["result-a"]);
    expect(api.document(PROJECT)!.nodes).toEqual(original.nodes);

    await ratio.click();
    await page.locator('[data-usage-control="size"][data-usage-value="1536x1024"]').click();
    await expect.poll(() => node(api, "result-a").metadata.size).toBe("1536x1024");
    expect(node(api, "result-a").metadata.generationRecord).toEqual(original.nodes[1]!.metadata.generationRecord);
    expect(node(api, "result-b")).toEqual(original.nodes[2]);
    await page.reload();
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await expect(ratio).toHaveText("3:2");
    await assertNoGeneration(api);
});

test("deleted source remains an editable reference; replay uses exact archived input and one undo/redo includes result and edge", async ({ page, api }, info) => {
    const original = await scene(page, api);
    await select(page, "original-reference"); await page.keyboard.press("Delete");
    await expect.poll(() => api.document(PROJECT)!.nodes.length).toBe(2);
    await select(page, "result-a");
    await expect(editor(page)).toHaveValue(INPUT);
    await expect(panel(page).locator(".cw-reference-preview")).toHaveCount(1);
    // Display normalization must not turn viewing the archived input into a node edit.
    await expect(panel(page).getByRole("button", { name: "宽高比", exact: true })).toHaveText("1:1");
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
    await page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => api.document(PROJECT)!.nodes).toEqual(before.nodes);
    expect(api.document(PROJECT)!.connections).toEqual(before.connections);
    await page.getByTestId("canvas-top-tool-rail").getByRole("button", { name: "重做", exact: true }).click();
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
    await assertReferencePreview(page, "a");
    await assertNoGeneration(api);
    await editor(page).fill("这个草稿会被 E 清空");
    await select(page, "result-b"); await select(page, "result-a");
    await page.keyboard.press("e");
    await expect(editor(page)).toHaveValue("");
    await assertReferencePreview(page, "a");
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
    await editor(page).blur();
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
            await assertReferencePreview(page, "source");
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
    const undoBox = await undo.boundingBox();
    if (!undoBox) throw new Error("Undo button is missing");
    await page.evaluate(() => {
        const sample = { input: 0, undo: 0 }; (window as any).__draftUndoSample = sample;
        document.addEventListener("input", event => { if ((event.target as Element).matches("textarea.cw-prompt")) sample.input = performance.now(); }, true);
        document.addEventListener("click", event => { if ((event.target as Element).closest('[data-usage-control="undo"]')) sample.undo = performance.now(); }, true);
    });
    await editor(page).fill("不到180毫秒就撤销的新草稿");
    await page.mouse.click(undoBox.x + undoBox.width / 2, undoBox.y + undoBox.height / 2);
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
