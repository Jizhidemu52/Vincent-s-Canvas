import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { test, expect, fixturePng, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { seedRetiredRecipes, snapshotRetiredRecipes, expectRecipeRetired } from "./retired-recipe-fixtures";

// Each pressure case performs up to ten independent uploads, submissions,
// reconciliations and original-byte checks. Keep this bounded when the main CI
// auto-discovers the file instead of relying on its shorter generic timeout.
test.setTimeout(120_000);

type Source = { name: string; mimeType: string; buffer: Buffer; width?: number; height?: number };
type Expected = { marker: string; sources: Source[] };
type Receipt = { title: string; startedAt: string; started: number; peakInflight: number; events: Array<Record<string, unknown>>; inputs: Array<Record<string, unknown>>; verifiedResults: Array<Record<string, unknown>>; rejections: string[]; queryFailures: number; controls: string[]; expected: Map<string, Expected>; failReads: Map<string, number> };
const receipts = new WeakMap<MockCanvasApi, Receipt>();
const active = (page: Page) => page.getByRole("tabpanel");
const tabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const owner = "00000000-0000-4000-8000-000000000099";
const imageModel = { id: "10000000-0000-4000-8000-000000000001", name: "Pressure GPT Image", modelId: "gpt-image-2", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
const videoModel = { id: "10000000-0000-4000-8000-000000000003", name: "Pressure Wan", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const videos = [readFileSync(new URL("./media/video.mp4", import.meta.url)), readFileSync(new URL("./media/video-control.mp4", import.meta.url))];
const promptCases = ["绿色圆领包", "A navy knitted bag, preserve shape.", "中文标点：领口、袖口；不变！", "Unicode：棉麻 🧵 🌈 café naïve 你好", "第一行保持结构\n第二行改变配色\n第三行保留纹理", "长说明：" + "保留产品原始轮廓，准确对应参考图；keep original texture. ".repeat(45), '引号与符号 "A&B" <参考> [1] {色号:#3a5f79}', "中 English 文 mixed — 不更改 logo®", "短：红。", "多图角色：图一结构、图二色彩；请勿交换 / preserve roles."];

async function setup(context: BrowserContext, api: MockCanvasApi, info: TestInfo, model = imageModel, allowVideoRawPrompt = false) {
    const r: Receipt = { title: info.title, startedAt: new Date().toISOString(), started: Date.now(), peakInflight: 0, events: [], inputs: [], verifiedResults: [], rejections: [], queryFailures: 0, controls: [], expected: new Map(), failReads: new Map() };
    receipts.set(api, r);
    await context.route("**/api/models", route => route.fulfill({ json: { models: [model, videoModel], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: ["video", "canvas-video"].includes(tool.toolKey) ? videoModel.id : model.id, configurationVersion: 1, ...(allowVideoRawPrompt && tool.toolKey === "video" ? { allowRawPrompt: true } : {}) })) } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/prompt-compilations/by-request/*", route => route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }));
    await context.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        const task = [...api.tasks.values()].find(task => task.requestId === requestId);
        r.events.push({ at: Date.now() - r.started, event: "query-request", requestId, taskId: task?.id });
        return route.fulfill({ status: task ? 200 : 404, json: task ? { task } : { error: "NOT_FOUND" } });
    });
    await context.route(/\/api\/tasks\/(?!by-request\/|events|preflight|batch)[^/?]+$/, route => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
        api.taskReads.push(`/api/tasks/${id}`);
        if ((r.failReads.get(id) || 0) > 0) {
            r.failReads.set(id, r.failReads.get(id)! - 1); r.queryFailures++;
            return route.fulfill({ status: 503, json: { message: "PRESSURE_TRANSIENT_QUERY_ONLY" } });
        }
        return route.fulfill({ json: { task: api.tasks.get(id) } });
    });
    await context.route(/\/api\/tasks(?:\?.*)?$/, route => {
        if (route.request().method() !== "POST") {
            const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",");
            return route.fulfill({ json: { tasks: [...api.tasks.values()].filter(task => !ids || ids.includes(task.id)), nextCursor: null } });
        }
        const input = route.request().postDataJSON(), id = randomUUID(), index = api.submissions.length;
        api.submissions.push(input);
        const task = { ...input, id, userId: owner, status: index % 2 ? "processing" : "queued", resultUrls: [], failureReason: null, createdAt: new Date().toISOString() };
        const video = input.operationType === "video_generation";
        api.tasks.set(id, task); api.assetBytes.set(id, video ? videos[index % videos.length] : fixturePng(23 + index * 19));
        api.assets.set(id, { id, ownerUserId: owner, status: "ready", kind: video ? "video" : "image", mimeType: video ? "video/mp4" : "image/png", contentUrl: `/api/assets/${id}/content` });
        const inflight = [...api.tasks.values()].filter(task => ["queued", "processing"].includes(task.status)).length;
        r.peakInflight = Math.max(r.peakInflight, inflight);
        r.events.push({ at: Date.now() - r.started, event: "accepted", id, requestId: input.requestId, inflight, operationType: input.operationType });
        return route.fulfill({ status: 201, json: { task } });
    });
    await context.route(/\/api\/tasks\/[^/]+\/(?:cancel|recover)$/, route => { r.controls.push(new URL(route.request().url()).pathname); return route.fulfill({ json: { changed: 0 } }); });
    await context.route(/\/api\/assets\/[^/]+\/(?:content|playback)$/, route => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        return api.tasks.get(id)?.operationType === "video_generation" ? route.fulfill({ contentType: "video/mp4", body: api.assetBytes.get(id) }) : route.fallback();
    });
    return r;
}

test.afterEach(async ({ api }, info) => {
    const r = receipts.get(api); if (!r) return;
    await info.attach("pressure-ledger", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        title: r.title, startedAt: r.startedAt, durationMs: Date.now() - r.started, status: info.status,
        submissions: api.submissions.length, uniqueRequestIds: new Set(api.submissions.map(input => input.requestId)).size,
        uniqueTaskIds: api.tasks.size, peakInflight: r.peakInflight, success: [...api.tasks.values()].filter(task => task.status === "success").length,
        intentionalFailed: [...api.tasks.values()].filter(task => task.status === "failed").length, terminalPending: [...api.tasks.values()].filter(task => ["queued", "processing"].includes(task.status)).length,
        queryCount: api.taskReads.length, uniqueQueriedTaskIds: new Set(api.taskReads).size, queryFailures: r.queryFailures,
        controls: r.controls, inputs: r.inputs, verifiedResults: r.verifiedResults, rejections: r.rejections, events: r.events,
        blocked: api.blocked, unexpected: api.unexpected, pageErrors: api.pageErrors,
    }, null, 2)) });
});

async function fixtures(page: Page) {
    const data = await page.evaluate(() => [
        { type: "image/png", width: 768, height: 96, alpha: false }, { type: "image/png", width: 96, height: 768, alpha: false },
        { type: "image/png", width: 240, height: 180, alpha: true }, { type: "image/jpeg", width: 320, height: 200, alpha: false },
        { type: "image/webp", width: 180, height: 320, alpha: false },
    ].map((item, index) => {
        const canvas = document.createElement("canvas"); canvas.width = item.width; canvas.height = item.height;
        const ctx = canvas.getContext("2d")!; if (!item.alpha) { ctx.fillStyle = `rgb(${30 + index * 35},90,170)`; ctx.fillRect(0, 0, item.width, item.height); }
        ctx.fillStyle = "rgba(240,120,20,.55)"; ctx.fillRect(8, 8, item.width / 2, item.height / 2); ctx.fillStyle = "black"; ctx.fillText(`fixture-${index}`, 12, 24);
        return { ...item, data: canvas.toDataURL(item.type, .87).split(",")[1] };
    }));
    const result: Source[] = data.map((item, index) => ({ name: `fixture-${index}.${item.type.split("/")[1]}`, mimeType: item.type, buffer: Buffer.from(item.data, "base64"), width: item.width, height: item.height }));
    result.push({ name: "fixture.gif", mimeType: "image/gif", buffer: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"), width: 1, height: 1 });
    for (const source of result) {
        expect(await page.evaluate(async data => { const image = new Image(); image.src = data; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }, `data:${source.mimeType};base64,${source.buffer.toString("base64")}`)).toEqual([source.width, source.height]);
    }
    return result;
}

function sourcesFor(pool: Source[], prefix: string, index: number, video = false) {
    const source = pool[index % (video ? 5 : pool.length)];
    const sources = [{ ...source, name: `${prefix}-${index}.${source.name.split(".").at(-1)}` }];
    if (index % 3 === 2) { const other = pool[(index + 1) % 5]; sources.push({ ...other, name: `${prefix}-${index}-detail.${other.name.split(".").at(-1)}` }); }
    return sources;
}

async function upload(page: Page, sources: Source[], video = false) {
    if (video) await active(page).locator('input[type="file"][accept^="image/"]').setInputFiles(sources);
    else { const chooser = page.waitForEvent("filechooser"); await active(page).getByRole("button", { name: "上传图片", exact: true }).click(); await (await chooser).setFiles(sources); }
    for (const source of sources) await expect(active(page).getByRole("img", { name: source.name, exact: true })).toBeVisible();
}

async function select(page: Page, index: number) { await tabs(page).nth(index).click(); await expect(tabs(page).nth(index)).toHaveAttribute("aria-selected", "true"); }
async function next(page: Page, count: number, entry: "history" | "footer" | "top" | "mobile" = "top") {
    if (entry === "mobile" && new URL(page.url()).pathname === "/video") { await active(page).getByRole("button", { name: "记录", exact: true }).click(); const drawer = page.getByRole("dialog", { name: "生成记录", exact: true }); await drawer.getByRole("button", { name: "新建", exact: true }).click(); await expect(drawer).toHaveCount(0); }
    else if (entry === "history" || entry === "mobile") {
        // The synthetic double-submit leaves the pointer over the prior result
        // layout. Move it away so the live queue tooltip closes before navigation.
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await active(page).getByRole("tab", { name: /^历史记录/ }).click();
        await active(page).getByRole("button", { name: "新建", exact: true }).click();
    }
    else if (entry === "footer") await active(page).getByRole("button", { name: "新建任务，继续创作", exact: true }).click();
    else await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(tabs(page)).toHaveCount(count); await expect(tabs(page).last()).toHaveAttribute("aria-selected", "true");
}

function sourceProof(api: MockCanvasApi, r: Receipt, marker: string, sources: Source[]) {
    const input = api.submissions.at(-1)!, task = [...api.tasks.values()].at(-1)!;
    const urls = input.sourceUrls || []; expect(urls).toHaveLength(sources.length);
    for (const [index, source] of sources.entries()) {
        const bytes = api.assetBytes.get(urls[index].split("/")[3]); expect(bytes).toBeTruthy(); expect(hash(bytes!)).toBe(hash(source.buffer));
    }
    r.expected.set(task.id, { marker, sources });
    r.inputs.push({ taskId: task.id, requestId: task.requestId, marker, promptCharacters: String(input.prompt || input.promptInput?.fields?.description || "").length,
        sources: sources.map(source => ({ name: source.name, mimeType: source.mimeType, width: source.width, height: source.height, bytes: source.buffer.length, sha256: hash(source.buffer) })) });
    return task.id as string;
}

function finish(api: MockCanvasApi, r: Receipt, id: string, failed = false) {
    const task = api.tasks.get(id)!; task.status = failed ? "failed" : "success"; task.failureReason = failed ? `PRESSURE_CONFIRMED_FAILURE_${id}` : null;
    task.resultUrls = failed ? [] : [`/api/assets/${id}/content`]; r.events.push({ at: Date.now() - r.started, event: task.status, id });
}

async function readResults(page: Page, kind: "image" | "video" | "creative") {
    return page.evaluate(async kind => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const { getMediaBlob } = await import("/src/services/file-storage.ts");
        const records: any[] = [];
        await createWorkspaceStorage(kind === "image" ? "image_generation_logs" : kind === "video" ? "video_generation_logs" : "creative_scene_workspaces").iterate((value: any, key) => {
            if (kind === "creative" && !key.startsWith("history-record:")) return; records.push(value);
        });
        const output: Array<{ taskId: string; workspaceId: string; prompt: string; references: string[]; sha256: string; bytes: number; storage: string }> = [];
        for (const log of records) {
            const images = kind === "video" ? log.video ? [{ ...log.video, sourceTaskId: log.task?.id }] : [] : log.images || [];
            for (const image of images) {
                if (!image.sourceTaskId) continue;
                const blob = image.storageKey ? await (kind === "video" ? getMediaBlob(image.storageKey) : getImageBlob(image.storageKey)) : image.dataUrl?.startsWith("data:") ? await (await fetch(image.dataUrl)).blob() : null;
                if (!blob) throw new Error(`No persisted original: ${kind}:${image.sourceTaskId}`);
                const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
                output.push({ taskId: image.sourceTaskId, workspaceId: log.workspaceId || "default", prompt: log.prompt || "", references: (log.references || log.submittedReferences || []).map((item: any) => item.name), sha256, bytes: blob.size, storage: "local-original" });
            }
        }
        return output;
    }, kind);
}

async function verifyResults(page: Page, api: MockCanvasApi, r: Receipt, kind: "image" | "video" | "creative", expectedSuccess: string[]) {
    await expect.poll(async () => (await readResults(page, kind)).length).toBe(expectedSuccess.length);
    const records = await readResults(page, kind); expect(records.map(record => record.taskId).sort()).toEqual([...expectedSuccess].sort());
    for (const record of records) {
        expect(record.sha256).toBe(hash(api.assetBytes.get(record.taskId)!)); expect(record.bytes).toBe(api.assetBytes.get(record.taskId)!.length);
        const expected = r.expected.get(record.taskId)!;
        if (kind === "image" || kind === "video") { expect(record.prompt).toContain(expected.marker); expect(record.references).toEqual(expected.sources.map(source => source.name)); }
        r.verifiedResults.push(record);
    }
    expect(new Set(records.map(record => record.workspaceId)).size).toBe(expectedSuccess.length);
}

for (const kind of ["image", "video"] as const) for (let round = 0; round < 5; round++) {
    test(`pressure ${kind} round ${round + 1}: ten mixed inputs, live new-entry, reverse completion, durable isolation`, async ({ page, context, api }, info) => {
        const r = await setup(context, api, info), pool = await fixtures(page), ids: string[] = [], markers: string[] = [];
        await page.goto(`/${kind}`);
        for (let index = 0; index < 10; index++) {
            const mobile = round === 4 && index >= 8;
            if (mobile) await page.setViewportSize({ width: 390, height: 844 });
            if (index) await next(page, index + 1, mobile ? "mobile" : round === 1 ? "footer" : round === 3 ? "top" : "history");
            const input = active(page).getByRole("textbox", { name: kind === "image" ? "图像提示词" : "视频提示词", exact: true });
            await expect(input).toHaveValue("");
            const marker = `${kind.toUpperCase()}_R${round + 1}_T${index + 1}_`, text = marker + promptCases[(index + round) % promptCases.length]; markers.push(text);
            const sources = index === 0 && round === 0 ? [] : sourcesFor(pool, marker, index + round, kind === "video");
            if (sources.length) await upload(page, sources, kind === "video"); await input.fill(text);
            await active(page).getByRole("button", { name: kind === "image" ? "开始生成" : "生成视频", exact: true }).evaluate(button => { button.click(); button.click(); });
            await expect.poll(() => api.submissions.length).toBe(index + 1); await expect(tabs(page).nth(index)).toContainText("处理中");
            expect(api.submissions.at(-1)!.prompt).toContain(text.trim()); ids.push(sourceProof(api, r, marker, sources));
            if (index > 0 && index % 3 === 0) { await select(page, 0); await expect(active(page).getByRole("textbox", { name: kind === "image" ? "图像提示词" : "视频提示词", exact: true })).toHaveValue(markers[0]); await select(page, index); }
            expect([...api.tasks.values()].every(task => ["queued", "processing"].includes(task.status))).toBe(true);
        }
        expect(r.peakInflight).toBe(10); expect(new Set(api.submissions.map(input => input.requestId)).size).toBe(10);
        await expect(page.getByRole("button", { name: "关闭任务 10 页签", exact: true })).toBeDisabled();
        if (round >= 2) {
            await page.reload(); await expect(tabs(page)).toHaveCount(10);
            await expect.poll(() => ids.every(id => api.taskReads.includes(`/api/tasks/${id}`))).toBe(true);
            expect(api.submissions).toHaveLength(10);
        }
        const failed = new Set(round === 1 || round === 3 ? [ids[2], ids[7]] : []);
        for (const index of [9, 7, 5, 3, 1, 8, 6, 4, 2, 0]) finish(api, r, ids[index], failed.has(ids[index]));
        for (let index = 0; index < 10; index++) await expect(tabs(page).nth(index)).toContainText(failed.has(ids[index]) ? "已失败" : "已完成");
        await verifyResults(page, api, r, kind, ids.filter(id => !failed.has(id)));
        await select(page, 9); await expect(active(page).getByRole("textbox", { name: kind === "image" ? "图像提示词" : "视频提示词", exact: true })).toHaveValue(markers[9]);
        await page.getByRole("button", { name: "关闭任务 10 页签", exact: true }).click(); await expect(tabs(page)).toHaveCount(9);
        await page.reload(); await expect(tabs(page)).toHaveCount(9); expect(api.submissions).toHaveLength(10); expect(r.controls).toEqual([]);
        expect((await readResults(page, kind)).length).toBe(10 - failed.size);
    });
}

const scenes = ["text-to-style", "style-to-sketch", "local-restyle", "garment-colorway", "back-design", "pattern-extract", "pattern-colorway", "pattern-craft", "accessory-design", "virtual-try-on", "sketch-to-photo"];
for (const [sceneIndex, scene] of scenes.entries()) test(`pressure creative ${scene}: three simultaneous mixed-source tasks`, async ({ page, context, api }, info) => {
    const r = await setup(context, api, info), pool = await fixtures(page), ids: string[] = [];
    await page.goto(`/creative/${scene}`);
    for (let index = 0; index < 3; index++) {
        if (index) await next(page, index + 1);
        const marker = `CREATIVE_${scene}_${index}_`, sources: Source[] = [];
        if (scene !== "text-to-style") {
            const label = scene === "accessory-design" ? "辅料图" : scene === "back-design" ? "服装正面图" : scene.startsWith("pattern-") ? "图案参考图" : scene === "virtual-try-on" ? "产品图" : scene === "sketch-to-photo" ? "线稿图" : "服装参考图";
            const source = { ...pool[(index + sceneIndex) % 5], name: `${marker}source.${pool[(index + sceneIndex) % 5].name.split(".").at(-1)}` }; sources.push(source);
            await active(page).getByLabel(`上传${label}`, { exact: true }).setInputFiles(source);
            if (scene === "accessory-design") { const other = { ...pool[2], name: `${marker}pattern.png` }; sources.push(other); await active(page).getByLabel("上传图案图", { exact: true }).setInputFiles(other); }
        }
        if (!["text-to-style", "virtual-try-on"].includes(scene)) await active(page).getByText("补充说明（可选）", { exact: true }).click();
        await active(page).locator(`textarea[id^="cs-${scene}-description-"]`).fill(marker + promptCases[index + 2]);
        if (scene === "local-restyle") await active(page).getByRole("textbox", { name: "要改成什么样", exact: true }).fill(`${marker}圆领改V领`);
        if (scene === "sketch-to-photo") { await active(page).getByRole("textbox", { name: "材质方向", exact: true }).fill("棉针织，纹理可见"); await active(page).getByRole("textbox", { name: "颜色方向", exact: true }).fill("海军蓝 / navy"); }
        await active(page).locator(".cs-generate").evaluate(button => { button.click(); button.click(); });
        await expect.poll(() => api.submissions.length).toBe(index + 1); await expect(tabs(page).nth(index)).toContainText("处理中");
        expect(api.submissions.at(-1)!.promptInput.fields.description).toBe(marker + promptCases[index + 2]); ids.push(sourceProof(api, r, marker, sources));
    }
    expect(r.peakInflight).toBe(3);
    finish(api, r, ids[2]); await expect(tabs(page).nth(2)).toContainText("已完成");
    await select(page, 0); await expect(active(page).getByRole("button", { name: "下载原图", exact: true })).toHaveCount(0);
    finish(api, r, ids[0]); finish(api, r, ids[1]);
    for (let index = 0; index < 3; index++) await expect(tabs(page).nth(index)).toContainText("已完成");
    await verifyResults(page, api, r, "creative", ids);
    await page.reload(); await expect(tabs(page)).toHaveCount(3); await select(page, 2);
    await expect(active(page).locator(`textarea[id^="cs-${scene}-description-"]`)).toHaveValue(`CREATIVE_${scene}_2_` + promptCases[4]);
    expect(api.submissions).toHaveLength(3); expect(r.controls).toEqual([]);
});

for (const tool of [
    { path: "/image?tool=image-edit", button: "开始编辑", prompt: true }, { path: "/item-extract", button: "提取产品图", prompt: false },
    { path: "/hd-upscale", button: "高清放大", prompt: false }, { path: "/remove-background", button: "一键去背景", prompt: false },
]) test(`pressure tool ${tool.path}: three independent sources, no lost work after reload`, async ({ page, context, api }, info) => {
    const r = await setup(context, api, info), pool = await fixtures(page), ids: string[] = [];
    await page.goto(tool.path);
    for (let index = 0; index < 3; index++) {
        if (index) await next(page, index + 1); const marker = `TOOL_${index}_`, sources = [sourcesFor(pool, marker, index + 2)[0]];
        await upload(page, sources); if (tool.prompt) await active(page).getByRole("textbox", { name: "图像提示词", exact: true }).fill(marker + promptCases[index + 2]);
        await active(page).getByRole("button", { name: tool.button, exact: true }).click(); await expect.poll(() => api.submissions.length).toBe(index + 1); ids.push(sourceProof(api, r, marker, sources));
    }
    expect(r.peakInflight).toBe(3); for (const index of [2, 0, 1]) finish(api, r, ids[index]);
    for (let index = 0; index < 3; index++) await expect(tabs(page).nth(index)).toContainText("已完成");
    const records = await readResults(page, "image"); expect(records.map(record => record.taskId).sort()).toEqual([...ids].sort());
    for (const record of records) { expect(record.sha256).toBe(hash(api.assetBytes.get(record.taskId)!)); expect(record.references).toEqual(r.expected.get(record.taskId)!.sources.map(source => source.name)); r.verifiedResults.push(record); }
    await page.reload(); await expect(tabs(page)).toHaveCount(3); await select(page, 0); await expect(active(page).getByRole("img", { name: "生成结果 1", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(3); expect(r.controls).toEqual([]);
});

test("retired recipe preserves six frozen projects and original bytes without executing their branches", async ({ page, context, api }, info) => {
    const r = await setup(context, api, info);
    const before = await seedRetiredRecipes(page, 6);
    expect(before.projects).toHaveLength(6);
    expect(before.files).toHaveLength(6);
    for (let index = 0; index < 6; index++) {
        await page.goto(`/creative/series-recipe?task=${index ? `retired-${index}` : "default"}`);
        await expectRecipeRetired(page);
    }
    await page.reload();
    await expectRecipeRetired(page);
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    expect(api.submissions).toHaveLength(0);
    expect(api.taskReads).toEqual([]);
    expect(r.controls).toEqual([]);
});

test("pressure seamless: six independent pending sources survive reload and reverse completion", async ({ page, context, api }, info) => {
    const r = await setup(context, api, info), pool = await fixtures(page), ids: string[] = [];
    await page.goto("/image?tool=seamless-stitch");
    for (let index = 0; index < 6; index++) {
        if (index) await next(page, index + 1); const marker = `SEAMLESS_${index}`, source = sourcesFor(pool, marker, index % 5)[0];
        await active(page).locator('input[type="file"]').setInputFiles(source); await expect(active(page).getByRole("img", { name: source.name, exact: true })).toBeVisible();
        await active(page).getByRole("button", { name: "开始无缝拼接", exact: true }).click(); await expect.poll(() => api.submissions.length).toBe(index + 1); ids.push(sourceProof(api, r, marker, [source]));
    }
    expect(r.peakInflight).toBe(6); await page.reload(); await expect(tabs(page)).toHaveCount(6);
    for (const index of [5, 2, 4, 1, 3, 0]) finish(api, r, ids[index]);
    for (let index = 0; index < 6; index++) {
        await select(page, index); const source = r.expected.get(ids[index])!.sources[0]; await expect(active(page).getByRole("img", { name: source.name, exact: true })).toBeVisible();
        const image = active(page).getByRole("img", { name: "无缝拼接结果", exact: true }); await expect(image).toBeVisible();
        const originalUrl = await image.getAttribute("src"); expect(originalUrl).toBe(api.tasks.get(ids[index])!.resultUrls[0]);
        // Native same-origin <a download> bypasses this local HTTP-route double.
        // Verify the exact original bound by the real result UI, not a thumbnail;
        // OS-native downloading remains an explicit production acceptance item.
        const original = await page.evaluate(async url => {
            const response = await fetch(url!); if (!response.ok) throw new Error(`Original read failed: ${response.status}`);
            const bytes = await response.arrayBuffer(); return { bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("") };
        }, originalUrl);
        expect(original.sha256).toBe(hash(api.assetBytes.get(ids[index])!)); expect(original.bytes).toBe(api.assetBytes.get(ids[index])!.length);
        r.verifiedResults.push({ taskId: ids[index], originalUrl, ...original });
    }
    expect(api.submissions).toHaveLength(6); expect(r.controls).toEqual([]);
});

test("input boundary: video rejects GIF, empty, oversized, corrupt and excessive references without a task POST", async ({ page, context, api }, info) => {
    const r = await setup(context, api, info, imageModel, true), pool = await fixtures(page);
    await page.goto("/video"); await active(page).getByRole("textbox", { name: "视频提示词", exact: true }).fill("INPUT_REJECTION_不得产生服务端任务");
    const fileInput = active(page).locator('input[type="file"][accept^="image/"]');
    for (const source of [pool[5], { name: "empty.png", mimeType: "image/png", buffer: Buffer.alloc(0) }, { name: "oversized.png", mimeType: "image/png", buffer: Buffer.concat([pool[0].buffer, Buffer.alloc(10 * 1024 * 1024)]) }, { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not-a-real-image") }]) {
        await fileInput.setInputFiles(source); await expect(active(page).getByRole("alert")).toBeVisible(); await expect(active(page).getByRole("img", { name: source.name, exact: true })).toHaveCount(0);
        expect(api.submissions).toHaveLength(0); r.rejections.push(source.name);
    }
    await fileInput.setInputFiles(pool.slice(0, 3)); await expect(active(page).getByRole("alert")).toContainText("最多使用 2 张图片"); expect(api.submissions).toHaveLength(0); r.rejections.push("3 images exceeds Wan2.7 maximum 2");
    await active(page).getByRole("textbox", { name: "视频提示词", exact: true }).fill(" \n\t ");
    await expect(active(page).getByText("想要的效果（可选）", { exact: true })).toBeVisible();
    await expect(active(page).getByRole("button", { name: "生成视频", exact: true })).toBeEnabled();
    expect(api.submissions).toHaveLength(0); r.events.push({ event: "optional-empty-planning-description-is-valid-no-auto-post" });
    await active(page).getByRole("checkbox", { name: "不经 AI 整理，直接发送", exact: true }).check();
    await expect(active(page).getByText("视频提示词", { exact: true })).toBeVisible();
    await expect(active(page).getByRole("button", { name: "生成视频", exact: true })).toBeDisabled();
    await active(page).getByRole("textbox", { name: "视频提示词", exact: true }).press("Control+Enter");
    expect(api.submissions).toHaveLength(0); r.rejections.push("empty/whitespace raw video prompt, button and keyboard");
});

test("input boundary: model-specific GIF/size/count policy and missing image remain fail-closed", async ({ page, context, api }, info) => {
    const grok = { ...imageModel, modelId: "grok-imagine-image", imageParameterProfile: "grok-image", name: "Pressure Grok" };
    const r = await setup(context, api, info, grok), pool = await fixtures(page);
    await page.goto("/image"); const input = active(page).getByRole("textbox", { name: "图像提示词", exact: true });
    await input.fill(" \n "); await expect(active(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled(); r.rejections.push("empty/whitespace image prompt");
    await input.fill("GROK_UNSUPPORTED_GIF"); await upload(page, [pool[5]]); await expect(active(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
    await expect(active(page).getByRole("region", { name: "参考图", exact: true }).getByText(/格式不支持，请使用 JPEG、PNG 或 WebP/)).toBeVisible(); r.rejections.push("Grok valid GIF unsupported");
    await next(page, 2); await input.fill("GROK_EXCESS_REFERENCES"); await upload(page, pool.slice(0, 4)); await expect(active(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled(); r.rejections.push("Grok 4 references exceeds maximum 3");
    await page.goto("/item-extract"); await expect(active(page).getByRole("button", { name: "提取产品图", exact: true })).toBeDisabled(); r.rejections.push("missing product source");
    expect(api.submissions).toHaveLength(0); expect(r.controls).toEqual([]);
});
