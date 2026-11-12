import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, fixturePng, newCanvas, type MockCanvasApi } from "./fixtures";

const OWNER = "00000000-0000-4000-8000-000000000099";
const SEED = 0x5525381;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Source = { name: string; mimeType: string; bytes: Buffer; width: number; height: number; alpha: boolean };
type Task = Record<string, any>;
const batchDialog = (page: Page) => page.getByRole("dialog", { name: "批量一键改图", exact: true });
const batchPrompt = (page: Page) => batchDialog(page).getByRole("textbox", { name: "批量改图提示词", exact: true });
const mixedPrompt = (tag: string, index: number) => [
    `${tag} 改蓝色。`, `${tag} Keep every seam; change only the background to pale green.`,
    `${tag} 产品主体不变 / keep original geometry.\n仅调整背景：ivory #F7F3EB；中文标识不要增删。`,
    `${tag} ${"保留主体轮廓、提手连接与材质纹理。Only change the specified accent; do not merge references.\n".repeat(24)}`,
    `${tag} 引号“产品A”、emoji 🧵 / 50% opacity background; punctuation <>&'\" and \t spaces.`,
    `${tag} ${"保持原图结构，主体无变形。".repeat(55)} End / 最后仅改浅灰背景。`,
][index % 6]!;

function shuffled<T>(items: T[], seed: number) {
    const result = [...items]; let state = seed >>> 0;
    for (let i = result.length - 1; i > 0; i--) { state = (Math.imul(1664525, state) + 1013904223) >>> 0; const j = state % (i + 1); [result[i], result[j]] = [result[j]!, result[i]!]; }
    return result;
}

async function sources(page: Page, tag: string, count: number): Promise<Source[]> {
    const values = await page.evaluate(({ tag, count }) => Array.from({ length: count }, (_, i) => {
        const dimensions = [[96, 64], [64, 113], [127, 127], [320, 181], [31, 49]][i % 5]!;
        const mimeType = ["image/png", "image/jpeg", "image/webp", "image/png", "image/webp"][i % 5]!;
        const canvas = document.createElement("canvas"); [canvas.width, canvas.height] = dimensions;
        const ctx = canvas.getContext("2d")!; const alpha = i % 5 === 0 || i % 5 === 4;
        if (!alpha) { ctx.fillStyle = "#e6d7b1"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        let hash = 0; for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        ctx.fillStyle = `rgba(${hash % 230},${(hash >> 8) % 230},${(i * 61 + 37) % 230},${alpha ? 0.55 : 1})`;
        ctx.fillRect(3, 4, canvas.width - 9, canvas.height - 11); ctx.fillStyle = "#180c4f"; ctx.font = "11px sans-serif";
        ctx.fillText(`${tag}/${i}`, 4, 17); ctx.fillRect((hash % 20) + i, 23, 4 + i * 2, 7);
        const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
        return { name: `${tag}-${i + 1}.${ext}`, mimeType, width: canvas.width, height: canvas.height, alpha, base64: canvas.toDataURL(mimeType, 0.87).split(",")[1]! };
    }), { tag, count });
    return values.map(({ base64, ...item }) => ({ ...item, bytes: Buffer.from(base64, "base64") }));
}

async function pressureApi(page: Page, api: MockCanvasApi) {
    const batches = new Map<string, Task[]>(), controls: Array<{ batchId: string; action: string; changed: string[] }> = [];
    const events: Array<{ event: string; id: string; requestId?: string; status?: string; at: number }> = [];
    const resultBytes = new Map<string, Buffer>(); let peakInflight = 0;
    const updatePeak = () => { peakInflight = Math.max(peakInflight, [...api.tasks.values()].filter(task => ["queued", "processing", "paused"].includes(task.status)).length); };
    function add(input: Task, item: Task = {}, batchId?: string, itemIndex?: number) {
        const id = randomUUID(), ordinal = api.tasks.size;
        const task = { ...input, ...item, id, userId: OWNER, ...(batchId ? { batchId, itemIndex } : {}), requestId: batchId ? `${input.requestId}:${itemIndex}` : input.requestId,
            status: batchId ? "queued" : "processing", resultUrls: [], failureReason: null, createdAt: new Date().toISOString() };
        const bytes = fixturePng((ordinal * 7 + 19) % 256); resultBytes.set(id, bytes); api.assetBytes.set(id, bytes);
        api.assets.set(id, { id, ownerUserId: OWNER, status: "ready", kind: "image", mimeType: "image/png", contentUrl: `/api/assets/${id}/content` });
        api.tasks.set(id, task); events.push({ event: "accepted", id, requestId: task.requestId, status: task.status, at: Date.now() }); updatePeak(); return task;
    }
    await page.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        const task = [...api.tasks.values()].find(task => task.requestId === requestId);
        events.push({ event: "read-request", id: task?.id || "missing", requestId, at: Date.now() });
        return route.fulfill({ status: task ? 200 : 404, json: task ? { task } : { error: "NOT_FOUND" } });
    });
    await page.route(/\/api\/tasks(?:\?.*)?$/, route => {
        if (route.request().method() === "POST") { const input = route.request().postDataJSON(); api.submissions.push(input); return route.fulfill({ status: 201, json: { task: add(input) } }); }
        const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",");
        return route.fulfill({ json: { tasks: [...api.tasks.values()].filter(task => !ids || ids.includes(task.id)), nextCursor: null } });
    });
    await page.route("**/api/tasks/batch", route => {
        const input = route.request().postDataJSON(); api.batchSubmissions.push(input); const batchId = randomUUID();
        const tasks = input.items.map((item: Task, i: number) => add(input, item, batchId, i)); batches.set(batchId, tasks);
        return route.fulfill({ status: 201, json: { batchId, tasks, failures: [], prompt: input.prompt, optimized: false } });
    });
    await page.route(/\/api\/tasks\/batches\/[^/]+\/(pause|resume|cancel)$/, route => {
        const parts = new URL(route.request().url()).pathname.split("/"), batchId = parts.at(-2)!, action = parts.at(-1)!, changed: string[] = [];
        for (const task of batches.get(batchId) || []) {
            if (action === "pause" && task.status === "queued") { task.status = "paused"; changed.push(task.id); }
            if (action === "resume" && task.status === "paused") { task.status = "queued"; changed.push(task.id); }
        }
        controls.push({ batchId, action, changed }); return route.fulfill({ json: { changed: changed.length } });
    });
    await page.route(/\/api\/tasks\/[^/]+\/cancel$/, route => {
        const id = new URL(route.request().url()).pathname.split("/")[3]!;
        controls.push({ batchId: id, action: "single-cancel-processing-noop", changed: [] }); return route.fulfill({ json: { changed: 0 } });
    });
    await page.route(/\/api\/assets\/[^/]+\/(content|thumb)$/, route => {
        const id = new URL(route.request().url()).pathname.split("/")[3]!;
        return route.fulfill({ contentType: api.assets.get(id)?.mimeType || "image/png", body: api.assetBytes.get(id)! });
    });
    return { batches, controls, events, resultBytes, peak: () => peakInflight, settle(task: Task, success = true) {
        task.status = success ? "success" : "failed"; task.resultUrls = success ? [`/api/assets/${task.id}/content`] : [];
        task.failureReason = success ? null : `FIXED_SEED_FAILURE_${task.id.slice(0, 8)}`;
        events.push({ event: "terminal", id: task.id, requestId: task.requestId, status: task.status, at: Date.now() });
    } };
}

async function openBatch(page: Page) {
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "批量改图", exact: true }).click(); await expect(batchDialog(page)).toBeVisible();
}
async function closeBatch(page: Page) { await batchDialog(page).getByRole("button", { name: /^关\s*闭$/ }).click(); await expect(batchDialog(page)).toBeHidden(); }
async function chooseBatch(page: Page, index: number) {
    const select = batchDialog(page).getByRole("combobox", { name: "切换批次", exact: true }); await select.click();
    await page.locator(".ant-select-dropdown:visible").getByText(new RegExp(`^批次 ${index} ·`)).click();
}
async function fillBatch(page: Page, prompt: string, input: Source[]) {
    const chooser = page.waitForEvent("filechooser"); await batchDialog(page).getByRole("button", { name: "选择图片（可多选）", exact: true }).click();
    await (await chooser).setFiles(input.map(item => ({ name: item.name, mimeType: item.mimeType, buffer: item.bytes })));
    for (const item of input) await expect(batchDialog(page).getByText(item.name, { exact: true })).toBeVisible();
    await batchPrompt(page).fill(prompt);
}
async function nodesWithBytes(page: Page, projectId: string) {
    return page.evaluate(async id => {
        const { useCanvasStore } = await import("/src/stores/canvas/use-canvas-store.ts"); const { getImageBlob } = await import("/src/services/image-storage.ts");
        const project = useCanvasStore.getState().projects.find(project => project.id === id); if (!project) throw new Error("Missing persisted project");
        return Promise.all(project.nodes.map(async node => {
            const blob = node.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
            const sha256 = blob ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("") : null;
            return { id: node.id, title: node.title, metadata: { ...node.metadata, content: undefined }, sha256, bytes: blob?.size };
        }));
    }, projectId);
}
async function evidence(info: TestInfo, file: string, value: unknown) {
    const path = info.outputPath(file); await writeFile(path, JSON.stringify(value, null, 2)); await info.attach(file, { path, contentType: "application/json" });
}

test("fixed-seed pressure: 3 rounds of 6 independent mixed-format batches with targeted controls and out-of-order terminals", async ({ page, api }, info) => {
    test.setTimeout(240_000);
    const started = Date.now(), f = await pressureApi(page, api), rounds: any[] = [];
    for (let round = 0; round < 3; round++) {
        const roundStarted = Date.now(), projectId = await newCanvas(page), entries: Array<{ id: string; input: Source[]; prompt: string }> = [];
        await openBatch(page);
        for (let batch = 0; batch < 6; batch++) {
            if (batch) await batchDialog(page).getByRole("button", { name: "新批次", exact: true }).click();
            const input = await sources(page, `R${round + 1}B${batch + 1}`, 3 + batch % 3), prompt = mixedPrompt(`R${round + 1}B${batch + 1}`, batch);
            await fillBatch(page, prompt, input);
            await batchDialog(page).getByRole("button", { name: "一键生图", exact: true }).evaluate(button => { button.click(); button.click(); });
            await expect.poll(() => api.batchSubmissions.length).toBe(round * 6 + batch + 1);
            const id = [...f.batches.keys()].at(-1)!; entries.push({ id, input, prompt });
            await expect(batchDialog(page).getByText(`服务端批次${id.slice(0, 8)}`, { exact: true })).toBeVisible();
            expect(entries.flatMap(entry => f.batches.get(entry.id)!).every(task => task.status === "queued")).toBe(true);
            if (batch === 2 || batch === 5) { await closeBatch(page); await openBatch(page); await expect(batchPrompt(page)).toHaveValue(prompt); }
        }
        expect(entries.flatMap(entry => f.batches.get(entry.id)!)).toHaveLength(24);
        const targetIndex = round % 6, target = entries[targetIndex]!;
        await chooseBatch(page, targetIndex + 1); await expect(batchPrompt(page)).toHaveValue(target.prompt);
        await batchDialog(page).getByRole("button", { name: "暂停等待项", exact: true }).click();
        await expect(batchDialog(page).getByText("已暂停", { exact: true })).toHaveCount(target.input.length);
        for (const entry of entries) expect(f.batches.get(entry.id)!.every(task => task.status === (entry.id === target.id ? "paused" : "queued"))).toBe(true);
        for (const index of shuffled([0, 1, 2, 3, 4, 5], SEED + round)) { await chooseBatch(page, index + 1); await expect(batchPrompt(page)).toHaveValue(entries[index]!.prompt); }
        await closeBatch(page); await openBatch(page); await chooseBatch(page, targetIndex + 1);
        await batchDialog(page).getByRole("button", { name: "恢复", exact: true }).click(); await expect(batchDialog(page).getByText("等待中", { exact: true })).toHaveCount(target.input.length);
        expect(f.controls.slice(round * 2)).toEqual([{ batchId: target.id, action: "pause", changed: f.batches.get(target.id)!.map(task => task.id) }, { batchId: target.id, action: "resume", changed: f.batches.get(target.id)!.map(task => task.id) }]);
        const order = shuffled(entries.flatMap(entry => f.batches.get(entry.id)!), SEED + 100 + round);
        for (const [index, task] of order.entries()) f.settle(task, index % 6 !== 0);
        await expect.poll(() => api.document(projectId)?.nodes.filter((node: Task) => node.metadata?.sourceTaskId).length).toBe(20);
        await expect.poll(() => api.document(projectId)?.nodes.filter((node: Task) => node.metadata?.status === "error").length).toBe(4);
        const nodes = await nodesWithBytes(page, projectId); expect(nodes).toHaveLength(48);
        for (const [index, entry] of entries.entries()) {
            const submission = api.batchSubmissions[round * 6 + index]!; expect(submission.prompt).toBe(entry.prompt.trim()); expect(submission.items).toHaveLength(entry.input.length);
            for (const [itemIndex, source] of entry.input.entries()) {
                const task = f.batches.get(entry.id)![itemIndex]!, uploadedId = submission.items[itemIndex].sourceUrls[0].split("/")[3];
                expect(sha(api.assetBytes.get(uploadedId)!)).toBe(sha(source.bytes));
                const original = nodes.find(node => node.title === source.name)!; expect(original).toMatchObject({ sha256: sha(source.bytes), bytes: source.bytes.length });
                const output = nodes.find(node => node.metadata?.generationOrigin?.sourceNodeId === original.id)!; expect(output).toBeDefined(); expect(output.metadata?.prompt).toBe(entry.prompt.trim());
                if (task.status === "success") expect(output).toMatchObject({ metadata: { sourceTaskId: task.id, originalFileName: source.name }, sha256: sha(f.resultBytes.get(task.id)!) });
                else { expect(output.metadata?.status).toBe("error"); expect(output.sha256).toBeNull(); expect(output.metadata?.imageTask?.requestId).toBe(task.requestId); }
            }
        }
        await closeBatch(page); await page.reload(); await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
        await expect.poll(() => api.document(projectId)?.nodes.length).toBe(48);
        const recovered = await nodesWithBytes(page, projectId); expect(recovered.map(node => [node.id, node.sha256])).toEqual(nodes.map(node => [node.id, node.sha256]));
        expect(api.batchSubmissions).toHaveLength((round + 1) * 6); expect(api.submissions).toHaveLength(0);
        rounds.push({ round: round + 1, projectId, durationMs: Date.now() - roundStarted, batches: entries.map(entry => ({ id: entry.id, promptLength: entry.prompt.length, sources: entry.input.map(({ bytes, ...source }) => ({ ...source, bytes: bytes.length, sha256: sha(bytes) })) })), successes: 20, injectedFailures: 4, terminalOrder: order.map(task => ({ id: task.id, status: task.status })), outputNodes: recovered });
        await evidence(info, `batch-round-${round + 1}.json`, rounds.at(-1));
    }
    expect(new Set(api.batchSubmissions.map(input => input.requestId)).size).toBe(18);
    expect(new Set([...api.tasks.values()].map(task => task.requestId)).size).toBe(72); expect(api.tasks.size).toBe(72); expect(f.peak()).toBe(24);
    await evidence(info, "batch-pressure-summary.json", { seed: SEED, durationMs: Date.now() - started, rounds: 3, batches: 18, uniqueTasks: 72, peakInflight: f.peak(), successes: 60, injectedFailures: 12, extraPosts: 0, controls: f.controls, events: f.events, inputFormats: ["PNG", "JPEG", "WebP"], alpha: ["opaque", "transparent", "semi-transparent"], externalRequests: api.blocked, unmocked: api.unexpected, pageErrors: api.pageErrors });
});

async function panTo(page: Page, target: Locator) {
    await expect(target).toBeAttached(); const box = await target.boundingBox(); if (!box) throw new Error("Missing UI target bounds");
    let dx = 900 - (box.x + box.width / 2), dy = 430 - (box.y + box.height / 2);
    if (Math.abs(dx) > 300 || Math.abs(dy) > 180) {
        // This workflow test is not a native-middle-button test. Its old grab
        // could release outside Chromium, importing Linux's shared selection.
        // Use the visible hand tool and keep each left-button drag in bounds.
        const viewport = page.locator("[data-canvas-viewport]");
        await page.getByRole("button", { name: "移动画布", exact: true }).click();
        while (Math.hypot(dx, dy) > 1) {
            const grab = await viewport.evaluate((element, delta) => {
                const bounds = element.getBoundingClientRect();
                const left = Math.max(24, bounds.left + 24), right = Math.min(innerWidth - 24, bounds.right - 24);
                const top = Math.max(140, bounds.top + 24), bottom = Math.min(innerHeight - 100, bounds.bottom - 24);
                let best: { x: number; y: number; toX: number; toY: number; progress: number } | undefined;
                for (let y = top; y <= bottom; y += 80) for (let x = left; x <= right; x += 80) {
                    const hit = document.elementFromPoint(x, y);
                    if (!hit?.closest("[data-canvas-viewport]") || hit.closest("[data-node-id],[data-canvas-group-id],[data-canvas-no-zoom],button,input,textarea")) continue;
                    const toX = Math.min(right, Math.max(left, x + delta.dx)), toY = Math.min(bottom, Math.max(top, y + delta.dy));
                    const progress = Math.hypot(delta.dx, delta.dy) - Math.hypot(delta.dx - (toX - x), delta.dy - (toY - y));
                    if (!best || progress > best.progress) best = { x, y, toX, toY, progress };
                }
                if (!best || best.progress <= 0) throw new Error("No in-bounds canvas background drag can approach the target");
                return best;
            }, { dx, dy });
            const remaining = Math.hypot(dx, dy);
            await page.mouse.move(grab.x, grab.y); await page.mouse.down({ button: "left" });
            await expect(viewport).toHaveAttribute("data-cursor-panning", "true");
            await page.mouse.move(grab.toX, grab.toY, { steps: 12 }); await page.mouse.up({ button: "left" });
            await expect(viewport).toHaveAttribute("data-cursor-panning", "false");
            await expect.poll(async () => {
                const current = await target.boundingBox();
                if (!current) return remaining;
                dx = 900 - (current.x + current.width / 2); dy = 430 - (current.y + current.height / 2);
                return Math.hypot(dx, dy);
            }).toBeLessThan(remaining - Math.min(0.5, grab.progress / 2));
        }
        await page.getByRole("button", { name: "选择 / 框选", exact: true }).click();
        await expect(target).toBeInViewport();
    }
}
async function workflowRecord(page: Page, groupId: string) {
    const button = page.locator(`[data-canvas-group-id="${groupId}"]`).getByRole("button", { name: /^连续改图 / }); await panTo(page, button); await button.click();
    const record = page.getByRole("dialog", { name: "图片工作流 · 运行记录", exact: true }); await expect(record).toBeVisible();
    // Antd can remain at scale(.2) for two frames before its entrance animation starts.
    await expect(record).not.toHaveClass(/ant-zoom-(?:appear|enter)/);
    return record;
}
async function closeWorkflow(record: Locator) { await record.getByRole("button", { name: "Close", exact: true }).click(); await expect(record).toBeHidden(); }
async function buildWorkflow(page: Page, api: MockCanvasApi, projectId: string, round: number, group: number) {
    const input = (await sources(page, `WF${round + 1}G${group + 1}`, 1))[0]!;
    // Start each independent source with no pending connection or previous selection.
    await page.getByRole("button", { name: "移动画布", exact: true }).click();
    await page.getByRole("button", { name: "选择 / 框选", exact: true }).click();
    const chooser = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: input.name, mimeType: input.mimeType, buffer: input.bytes });
    await expect.poll(() => api.document(projectId)?.nodes.some((node: Task) => node.title === input.name)).toBe(true);
    const sourceId = api.document(projectId)!.nodes.find((node: Task) => node.title === input.name).id, node = page.locator(`[data-node-id="${sourceId}"]`);
    // The 40px input-port hit area overlaps x=15 on this 96x64 image: select its center.
    await panTo(page, node);
    expect(await node.evaluate(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { nodeId: hit?.closest("[data-node-id]")?.getAttribute("data-node-id"), isHandle: Boolean(hit?.closest("[data-canvas-connection-handle],[data-canvas-resize-handle]")) };
    })).toEqual({ nodeId: sourceId, isHandle: false });
    await node.click();
    const collapse = page.getByRole("button", { name: "收起创建面板", exact: true }); if (await collapse.isVisible()) await collapse.click();
    await node.hover(); await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "图片工作流 · 快速搭建", exact: true }).click();
    const create = page.getByRole("dialog", { name: "快速搭建图片工作流", exact: true }); await expect(create).toBeVisible();
    await create.getByRole("button", { name: "删除步骤 3", exact: true }).click();
    const prompts = [mixedPrompt(`WF${round + 1}G${group + 1}S1`, group), mixedPrompt(`WF${round + 1}G${group + 1}S2`, group + 3)];
    for (let step = 1; step <= 2; step++) {
        await create.getByRole("textbox", { name: `步骤 ${step} 名称`, exact: true }).fill(`WF${round + 1}G${group + 1}S${step}`);
        await create.getByRole("textbox", { name: `步骤 ${step} 提示词`, exact: true }).fill(prompts[step - 1]!);
        const type = create.getByRole("combobox", { name: `步骤 ${step} 类型`, exact: true }); await type.click();
        // Real keyboard selection also reaches the last virtual option when a long textarea clips the popup.
        for (let down = 0; down < 6 - step; down++) await type.press("ArrowDown");
        await type.press("Enter"); await expect(create.locator(".ant-select").nth(step - 1)).toContainText("自定义");
    }
    await create.getByRole("button", { name: "创建并连接节点", exact: true }).click(); await expect(create).toBeHidden();
    await expect.poll(() => api.document(projectId)?.groups?.filter((item: Task) => item.imageSequence).length).toBe(group + 1);
    const saved = api.document(projectId)!.groups.find((item: Task) => item.imageSequence?.sourceNodeId === sourceId);
    expect(api.document(projectId)!.connections.filter((edge: Task) => edge.kind === "config-target")).toEqual([]);
    return { id: saved.id as string, input, prompts, sourceId, configIds: saved.imageSequence.steps.map((step: Task) => step.configNodeId) as string[] };
}

test("fixed-seed workflows: 3 rounds of 3 UI-built two-step groups, independent stop and original-task recovery", async ({ page, api }, info) => {
    test.setTimeout(240_000);
    const started = Date.now(), f = await pressureApi(page, api), rounds: any[] = [];
    for (let round = 0; round < 3; round++) {
        const roundStarted = Date.now(), projectId = await newCanvas(page), groups: Awaited<ReturnType<typeof buildWorkflow>>[] = [];
        for (let group = 0; group < 3; group++) groups.push(await buildWorkflow(page, api, projectId, round, group));
        expect(new Set(groups.flatMap(group => [group.sourceId, ...group.configIds])).size).toBe(9);
        expect(api.document(projectId)!.connections).toHaveLength(6);
        for (const group of groups) {
            expect(api.document(projectId)!.connections.filter((edge: Task) => edge.toNodeId === group.configIds[0]).map((edge: Task) => edge.fromNodeId)).toEqual([group.sourceId]);
            expect(api.document(projectId)!.connections.filter((edge: Task) => edge.kind === "config-sequence" && edge.toNodeId === group.configIds[1]).map((edge: Task) => edge.fromNodeId)).toEqual([group.configIds[0]]);
        }
        const taskFor = (group: number, step: number) => [...api.tasks.values()].find(task => task.prompt.includes(`WF${round + 1}G${group + 1}S${step}`));
        for (const [index, group] of groups.entries()) {
            const record = await workflowRecord(page, group.id); await record.getByRole("button", { name: "按连线运行", exact: true }).click();
            await expect.poll(() => Boolean(taskFor(index, 1))).toBe(true);
            await expect(record.getByRole("button", { name: "停止后续步骤", exact: true })).toBeVisible(); await closeWorkflow(record);
            expect(groups.slice(0, index + 1).every((_, prior) => taskFor(prior, 1)?.status === "processing")).toBe(true);
        }
        expect(api.submissions).toHaveLength(round * 6 + 3); expect(groups.every((_, group) => !taskFor(group, 2))).toBe(true);
        const stoppedIndex = round % 3, stopped = groups[stoppedIndex]!, original = taskFor(stoppedIndex, 1)!;
        const stopRecord = await workflowRecord(page, stopped.id); await stopRecord.getByRole("button", { name: "停止后续步骤", exact: true }).click();
        await expect(stopRecord.getByRole("button", { name: "核查并继续", exact: true })).toBeVisible(); await closeWorkflow(stopRecord);
        expect(groups.filter((_, index) => index !== stoppedIndex).every(group => api.document(projectId)!.groups.find((item: Task) => item.id === group.id).imageSequence.status === "running")).toBe(true);
        const order = shuffled([0, 1, 2].filter(index => index !== stoppedIndex), SEED + round);
        for (const groupIndex of order) { f.settle(taskFor(groupIndex, 1)!); await expect.poll(() => Boolean(taskFor(groupIndex, 2))).toBe(true); }
        expect(taskFor(stoppedIndex, 2)).toBeUndefined();
        for (const groupIndex of order.reverse()) f.settle(taskFor(groupIndex, 2)!);
        for (const groupIndex of order) await expect.poll(() => api.document(projectId)!.groups.find((item: Task) => item.id === groups[groupIndex]!.id).imageSequence.status).toBe("success");
        f.settle(original);
        const before = api.submissions.length, continueRecord = await workflowRecord(page, stopped.id);
        await continueRecord.getByRole("button", { name: "核查并继续", exact: true }).click(); await expect.poll(() => Boolean(taskFor(stoppedIndex, 2))).toBe(true);
        expect(api.submissions.length).toBe(before + 1); expect([...api.tasks.values()].filter(task => task.prompt.includes(`WF${round + 1}G${stoppedIndex + 1}S1`))).toHaveLength(1);
        expect(taskFor(stoppedIndex, 1)!.requestId).toBe(original.requestId); f.settle(taskFor(stoppedIndex, 2)!);
        await expect(continueRecord.getByRole("status")).toContainText("全部完成"); await closeWorkflow(continueRecord);
        await expect.poll(() => api.document(projectId)!.groups.filter((group: Task) => group.imageSequence?.status === "success").length).toBe(3);
        const nodes = await nodesWithBytes(page, projectId);
        for (const [groupIndex, group] of groups.entries()) {
            const first = taskFor(groupIndex, 1)!, second = taskFor(groupIndex, 2)!;
            expect(sha(api.assetBytes.get(first.sourceUrls[0].split("/")[3])!)).toBe(sha(group.input.bytes));
            expect(sha(api.assetBytes.get(second.sourceUrls[0].split("/")[3])!)).toBe(sha(f.resultBytes.get(first.id)!));
            const saved = api.document(projectId)!.groups.find((item: Task) => item.id === group.id);
            for (const [stepIndex, step] of saved.imageSequence.steps.entries()) {
                const task = stepIndex === 0 ? first : second, output = nodes.find(node => node.id === step.outputNodeId)!;
                expect(output.sha256).toBe(sha(f.resultBytes.get(task.id)!)); expect(output.metadata?.sourceTaskId).toBe(task.id);
                expect(api.document(projectId)!.connections.some((edge: Task) => edge.kind === "generation-output" && edge.fromNodeId === group.configIds[stepIndex] && edge.toNodeId === output.id)).toBe(true);
            }
            const firstTerminal = f.events.find(event => event.id === first.id && event.event === "terminal")!, secondAccepted = f.events.find(event => event.id === second.id && event.event === "accepted")!;
            expect(secondAccepted.at).toBeGreaterThanOrEqual(firstTerminal.at);
        }
        await page.reload(); await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
        expect(api.submissions).toHaveLength((round + 1) * 6); expect(api.batchSubmissions).toHaveLength(0);
        const recovered = await nodesWithBytes(page, projectId); expect(recovered.map(node => [node.id, node.sha256])).toEqual(nodes.map(node => [node.id, node.sha256]));
        rounds.push({ round: round + 1, projectId, durationMs: Date.now() - roundStarted, stoppedGroup: stopped.id, originalTaskId: original.id, groups: groups.map(group => ({ id: group.id, sourceId: group.sourceId, sourceSha256: sha(group.input.bytes), configIds: group.configIds })), uniqueTasks: 6, extraPosts: 0, nodes: recovered });
        await evidence(info, `workflow-round-${round + 1}.json`, rounds.at(-1));
    }
    expect(api.tasks.size).toBe(18); expect(new Set(api.submissions.map(input => input.requestId)).size).toBe(18); expect(f.peak()).toBe(3);
    await evidence(info, "workflow-pressure-summary.json", { seed: SEED, rounds: 3, groups: 9, dependencySteps: 18, uniqueTasks: 18, peakInflight: f.peak(), originalTaskRecoveries: 3, extraPosts: 0, durationMs: Date.now() - started, controls: f.controls, events: f.events, externalRequests: api.blocked, unmocked: api.unexpected, pageErrors: api.pageErrors });
});

test("invalid inputs are local rejections, not generated tasks: corrupt, empty, over 20 MiB and 101 images", async ({ page, api }, info) => {
    const started = Date.now(); await pressureApi(page, api); const projectId = await newCanvas(page); await openBatch(page);
    const good = (await sources(page, "boundary-original", 1))[0]!; await fillBatch(page, "BOUNDARY 仅作为合法原列表", [good]);
    const choose = async (files: Array<{ name: string; mimeType: string; buffer: Buffer }>) => { const chooser = page.waitForEvent("filechooser"); await batchDialog(page).getByRole("button", { name: "选择图片（可多选）", exact: true }).click(); await (await chooser).setFiles(files); };
    await choose([{ name: "over-20MiB.png", mimeType: "image/png", buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 9) }]);
    await expect(page.getByText(/over-20MiB.*超过 20 MB/)).toBeVisible(); await expect(batchDialog(page).getByText(good.name, { exact: true })).toBeVisible();
    await choose(Array.from({ length: 101 }, (_, index) => ({ name: `limit-${index}.png`, mimeType: "image/png", buffer: good.bytes })));
    await expect(page.getByText("每批最多处理 100 张图片，请分批选择；原列表未改变。", { exact: true })).toBeVisible(); await expect(batchDialog(page).getByText(good.name, { exact: true })).toBeVisible();
    for (const [name, buffer] of [["empty.png", Buffer.alloc(0)], ["corrupt.png", Buffer.from("not a decodable image\u0000\u0001")]] as const) {
        await choose([{ name, mimeType: "image/png", buffer }]); await batchPrompt(page).fill(`REJECT ${name}`);
        await batchDialog(page).getByRole("button", { name: "一键生图", exact: true }).click();
        await expect(batchDialog(page).getByText("失败", { exact: true })).toHaveCount(1);
        expect(api.batchSubmissions).toHaveLength(0); expect(api.submissions).toHaveLength(0); expect(api.tasks.size).toBe(0);
        await batchDialog(page).getByRole("button", { name: "新批次", exact: true }).click();
    }
    expect(api.document(projectId)?.nodes || []).toHaveLength(0);
    await evidence(info, "local-rejections.json", { boundaries: ["20MiB+1 byte", "101 images", "zero-byte image", "corrupt image bytes"], previousValidListPreserved: true, generatedTasks: 0, batchPosts: 0, singlePosts: 0, durationMs: Date.now() - started, externalRequests: api.blocked, unmocked: api.unexpected, pageErrors: api.pageErrors });
});
