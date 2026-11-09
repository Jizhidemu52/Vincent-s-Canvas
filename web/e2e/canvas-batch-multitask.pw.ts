import { createHash, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect, fixturePng, newCanvas, type MockCanvasApi } from "./fixtures";

const ownerId = "00000000-0000-4000-8000-000000000099";
const promptA = "BATCH_A_只把圆形包改成绿色，保留A原图结构";
const promptB = "BATCH_B_只把三角包改成橙色，保留B原图结构";
const sourcesA = [{ name: "A-1.png", bytes: fixturePng(27) }, { name: "A-2.png", bytes: fixturePng(73) }];
const sourcesB = [{ name: "B-1.png", bytes: fixturePng(137) }];
const dialog = (page: Page) => page.getByRole("dialog", { name: "批量一键改图", exact: true });
const prompt = (page: Page) => dialog(page).getByRole("textbox", { name: "批量改图提示词", exact: true });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function batchApi(page: Page, api: MockCanvasApi) {
    const batches = new Map<string, any[]>();
    const controls: Array<{ batchId: string; action: string }> = [];
    const resultBytes = new Map<string, Buffer>();
    await page.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        const task = [...api.tasks.values()].find(task => task.requestId === requestId);
        return route.fulfill({ status: task ? 200 : 404, json: task ? { task } : { error: "NOT_FOUND" } });
    });
    await page.route(/\/api\/tasks(?:\?.*)?$/, route => {
        if (route.request().method() !== "GET") return route.fallback();
        const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",");
        return route.fulfill({ json: { tasks: [...api.tasks.values()].filter(task => !ids || ids.includes(task.id)), nextCursor: null } });
    });
    await page.route("**/api/tasks/batch", route => {
        const input = route.request().postDataJSON();
        api.batchSubmissions.push(input);
        const index = batches.size;
        const batchId = index === 0 ? "a1000000-0000-4000-8000-000000000001" : "b2000000-0000-4000-8000-000000000002";
        if (batches.has(batchId)) throw new Error("Unexpected third batch submission");
        const tasks = input.items.map((item: any, itemIndex: number) => {
            const id = randomUUID();
            const task = { ...input, ...item, id, requestId: `${input.requestId}:${itemIndex}`, userId: ownerId, itemIndex, batchId,
                status: "queued", resultUrls: [], failureReason: null, createdAt: new Date().toISOString() };
            const bytes = fixturePng(173 + index * 40 + itemIndex * 13);
            resultBytes.set(id, bytes);
            api.assetBytes.set(id, bytes);
            api.assets.set(id, { id, ownerUserId: ownerId, status: "ready", kind: "image", mimeType: "image/png", contentUrl: `/api/assets/${id}/content` });
            api.tasks.set(id, task);
            return task;
        });
        batches.set(batchId, tasks);
        return route.fulfill({ status: 201, json: { batchId, tasks, failures: [], prompt: input.prompt, optimized: false } });
    });
    await page.route(/\/api\/tasks\/batches\/[^/]+\/(pause|resume|cancel)$/, route => {
        const parts = new URL(route.request().url()).pathname.split("/");
        const batchId = parts.at(-2)!, action = parts.at(-1)!;
        controls.push({ batchId, action });
        let changed = 0;
        for (const task of batches.get(batchId) || []) {
            if (action === "pause" && task.status === "queued") { task.status = "paused"; changed++; }
            else if (action === "resume" && task.status === "paused") { task.status = "queued"; changed++; }
            else if (action === "cancel" && ["queued", "paused"].includes(task.status)) { task.status = "cancelled"; changed++; }
        }
        return route.fulfill({ json: { changed } });
    });
    await page.route(/\/api\/tasks\/[^/]+\/cancel$/, route => {
        controls.push({ batchId: new URL(route.request().url()).pathname.split("/")[3], action: "single-cancel" });
        return route.fulfill({ json: { changed: 0 } });
    });
    return { batches, controls, resultBytes, finish(batchId: string) {
        for (const task of batches.get(batchId)!) { task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`]; }
    } };
}

async function open(page: Page) {
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "批量改图", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
}

async function selectBatch(page: Page, number: number) {
    await dialog(page).getByRole("combobox", { name: "切换批次", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText(new RegExp(`^批次 ${number} ·`)).click();
}

async function fill(page: Page, text: string, sources: typeof sourcesA) {
    const chooser = page.waitForEvent("filechooser");
    await dialog(page).getByRole("button", { name: "选择图片（可多选）", exact: true }).click();
    await (await chooser).setFiles(sources.map(source => ({ name: source.name, mimeType: "image/png", buffer: source.bytes })));
    for (const source of sources) await expect(dialog(page).getByText(source.name, { exact: true })).toBeVisible();
    await prompt(page).fill(text);
    await expect(dialog(page).getByRole("switch", { name: "批量统一优化提示词", exact: true })).not.toBeChecked();
}

async function submit(page: Page, api: MockCanvasApi, count: number) {
    await dialog(page).getByRole("button", { name: "一键生图", exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => api.batchSubmissions.length).toBe(count);
    await expect(prompt(page)).toBeDisabled();
}

async function originalNodes(page: Page, projectId: string) {
    return page.evaluate(async id => {
        const { useCanvasStore } = await import("/src/stores/canvas/use-canvas-store.ts");
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const project = useCanvasStore.getState().projects.find(project => project.id === id);
        if (!project) throw new Error("Expected persisted project");
        return Promise.all(project.nodes.map(async node => {
            const blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
            const sha256 = blob ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("") : null;
            return { id: node.id, title: node.title, prompt: node.metadata?.prompt, sourceTaskId: node.metadata?.sourceTaskId,
                sourceNodeId: node.metadata?.generationOrigin?.sourceNodeId, originalFileName: node.metadata?.originalFileName, sha256, bytes: blob?.size };
        }));
    }, projectId);
}

test("two canvas batches run independently, keep targeted controls and preserve originals through reverse completion and close/reopen", async ({ page, api }, info) => {
    const f = await batchApi(page, api), projectId = await newCanvas(page);
    await open(page);
    await fill(page, promptA, sourcesA);
    await submit(page, api, 1);
    const aId = [...f.batches.keys()][0];
    await expect(dialog(page).getByText(`服务端批次${aId.slice(0, 8)}`, { exact: true })).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "新批次", exact: true })).toBeEnabled();
    await dialog(page).getByRole("button", { name: "新批次", exact: true }).click();
    await expect(prompt(page)).toHaveValue("");
    await expect(dialog(page).getByText("还没有选择图片", { exact: true })).toBeVisible();
    expect(f.batches.get(aId)!.every(task => task.status === "queued")).toBe(true);
    await fill(page, promptB, sourcesB);
    await submit(page, api, 2);
    const bId = [...f.batches.keys()][1];
    await expect(dialog(page).getByText(`服务端批次${bId.slice(0, 8)}`, { exact: true })).toBeVisible();
    expect(f.batches.get(aId)!.every(task => task.status === "queued")).toBe(true);
    expect(new Set(api.batchSubmissions.map(batch => batch.requestId)).size).toBe(2);
    for (const [index, sources] of [sourcesA, sourcesB].entries()) {
        const input = api.batchSubmissions[index];
        expect(input.prompt).toBe(index === 0 ? promptA : promptB);
        expect(input.items).toHaveLength(sources.length);
        for (const [itemIndex, source] of sources.entries()) expect(sha(api.assetBytes.get(input.items[itemIndex].sourceUrls[0].split("/")[3])!)).toBe(sha(source.bytes));
    }

    await selectBatch(page, 1);
    await expect(prompt(page)).toHaveValue(promptA);
    await expect(dialog(page).getByText("B-1.png", { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByText(`服务端批次${aId.slice(0, 8)}`, { exact: true })).toBeVisible();
    await dialog(page).getByRole("button", { name: "暂停等待项", exact: true }).click();
    await expect(dialog(page).getByText("已暂停", { exact: true })).toHaveCount(2);
    expect(f.controls).toEqual([{ batchId: aId, action: "pause" }]);
    expect(f.batches.get(bId)!.every(task => task.status === "queued")).toBe(true);
    await selectBatch(page, 2);
    await expect(prompt(page)).toHaveValue(promptB);
    await expect(dialog(page).getByText("A-1.png", { exact: true })).toHaveCount(0);
    await dialog(page).getByRole("button", { name: /^关\s*闭$/ }).click();
    await expect(dialog(page)).toBeHidden();
    await open(page);
    await expect(prompt(page)).toHaveValue(promptB);
    await expect(dialog(page).getByText(`服务端批次${bId.slice(0, 8)}`, { exact: true })).toBeVisible();
    expect(api.batchSubmissions).toHaveLength(2);
    expect(f.controls).toEqual([{ batchId: aId, action: "pause" }]);

    f.finish(bId);
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.metadata?.sourceTaskId === f.batches.get(bId)![0].id).length).toBe(1);
    await expect(dialog(page).getByText("成功", { exact: true })).toHaveCount(1);
    expect(f.batches.get(aId)!.every(task => task.status === "paused")).toBe(true);
    await page.screenshot({ path: info.outputPath("batch-b-complete-a-paused.png") });
    await selectBatch(page, 1);
    await expect(prompt(page)).toHaveValue(promptA);
    await expect(dialog(page).getByText("已暂停", { exact: true })).toHaveCount(2);
    await dialog(page).getByRole("button", { name: "恢复", exact: true }).click();
    await expect(dialog(page).getByText("等待中", { exact: true })).toHaveCount(2);
    expect(f.controls).toEqual([{ batchId: aId, action: "pause" }, { batchId: aId, action: "resume" }]);
    expect(f.batches.get(bId)![0].status).toBe("success");
    f.finish(aId);
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.metadata?.sourceTaskId).length).toBe(3);
    await expect(dialog(page).getByText("成功", { exact: true })).toHaveCount(2);
    const nodes = await originalNodes(page, projectId);
    expect(nodes).toHaveLength(6);
    for (const source of [...sourcesA, ...sourcesB]) expect(nodes.find(node => node.title === source.name)).toMatchObject({ sha256: sha(source.bytes), bytes: source.bytes.length });
    for (const [batchId, tasks] of f.batches) for (const task of tasks) {
        const output = nodes.find(node => node.sourceTaskId === task.id)!;
        const source = (batchId === aId ? sourcesA : sourcesB)[task.itemIndex];
        expect(output).toMatchObject({ prompt: batchId === aId ? promptA : promptB, originalFileName: source.name, sha256: sha(f.resultBytes.get(task.id)!) });
        expect(nodes.find(node => node.id === output.sourceNodeId)?.sha256).toBe(sha(source.bytes));
    }
    await selectBatch(page, 2);
    await expect(prompt(page)).toHaveValue(promptB);
    await expect(dialog(page).getByText("成功", { exact: true })).toHaveCount(1);
    await dialog(page).getByRole("button", { name: /^关\s*闭$/ }).click();
    await open(page);
    await expect(prompt(page)).toHaveValue(promptB);
    expect(api.batchSubmissions).toHaveLength(2);
    expect(api.submissions).toHaveLength(0);
    expect(f.controls.some(control => control.action.includes("cancel"))).toBe(false);
});

test("leaving a live batch via SPA project creation does not cancel it or write its late result into the new canvas", async ({ page, api }) => {
    const f = await batchApi(page, api), firstProject = await newCanvas(page);
    await open(page);
    await fill(page, promptA, sourcesA.slice(0, 1));
    await submit(page, api, 1);
    const aId = [...f.batches.keys()][0];
    await expect(dialog(page).getByText(`服务端批次${aId.slice(0, 8)}`, { exact: true })).toBeVisible();
    await expect.poll(() => api.document(firstProject)?.nodes.some((node: any) => node.metadata?.imageTask?.requestId)).toBe(true);
    await dialog(page).getByRole("button", { name: /^关\s*闭$/ }).click();
    await page.getByRole("button", { name: "打开画布菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建画布", exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/canvas/${firstProject}$`));
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
    const secondProject = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(secondProject).not.toBe(firstProject);
    f.finish(aId);
    await open(page);
    await expect(prompt(page)).toHaveValue("");
    await expect(dialog(page).getByText("还没有选择图片", { exact: true })).toBeVisible();
    await fill(page, promptB, sourcesB);
    await submit(page, api, 2);
    const bId = [...f.batches.keys()][1];
    f.finish(bId);
    await expect.poll(() => api.document(secondProject)?.nodes.filter((node: any) => node.metadata?.sourceTaskId === f.batches.get(bId)![0].id).length).toBe(1);
    const second = api.document(secondProject)!;
    expect(second.nodes).toHaveLength(2);
    expect(second.nodes.every((node: any) => node.metadata?.prompt === promptB)).toBe(true);
    expect(second.nodes.some((node: any) => node.metadata?.sourceTaskId === f.batches.get(aId)![0].id)).toBe(false);
    const first = api.document(firstProject)!;
    expect(first.nodes).toHaveLength(2);
    expect(first.nodes.every((node: any) => node.metadata?.prompt === promptA)).toBe(true);
    expect(f.controls).toEqual([]);
    expect(api.batchSubmissions).toHaveLength(2);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions.map(input => input.projectId)).toEqual([firstProject, secondProject]);
});
