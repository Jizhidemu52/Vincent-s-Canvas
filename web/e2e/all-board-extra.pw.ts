import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect, newCanvas, uploadImage, IMAGE, type MockCanvasApi } from "./fixtures";
import { AUDIO_TASK, OWNER, configureAudioTask, configureCanvasTools, configureTeam, fixtureWav } from "./all-board-extra-fixtures";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function addConfig(page: Page, api: MockCanvasApi, projectId: string) {
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "生成配置", exact: true }).click();
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.type === "config").length).toBe(1);
    const id = api.document(projectId)!.nodes.find((node: any) => node.type === "config").id;
    const node = page.locator(`[data-node-id="${id}"]`);
    await expect(node.getByRole("textbox", { name: "提示词", exact: true })).toBeVisible();
    return node;
}

async function openImageTools(page: Page, id: string) {
    const node = page.locator(`[data-node-id="${id}"]`);
    await node.click({ position: { x: 50, y: 70 } });
    const collapse = page.getByRole("button", { name: "收起创建面板", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    await node.hover();
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
}

test("canvas configuration modes accept pointer clicks without moving the node while blank node content remains draggable", async ({ page, context, api }, info) => {
    await configureCanvasTools(context, api);
    const projectId = await newCanvas(page), config = await addConfig(page, api, projectId);
    const original = structuredClone(api.document(projectId)!.nodes[0]);
    await page.evaluate(() => {
        (window as any).__configModeEvents = [];
        for (const type of ["pointerdown", "mousedown", "click", "input", "change"]) document.addEventListener(type, event => {
            const target = event.target as HTMLElement;
            if (!target.closest(".canvas-config-mode")) return;
            setTimeout(() => (window as any).__configModeEvents.push({ type, target: target.tagName, defaultPrevented: event.defaultPrevented }), 0);
        }, true);
    });
    for (const name of ["音频", "视频", "文本", "生图"]) {
        await config.getByText(name, { exact: true }).click();
        await info.attach(`mode-pointer-events-${name}`, { contentType: "application/json", body: Buffer.from(JSON.stringify(await page.evaluate(() => (window as any).__configModeEvents))) });
        await expect(config.getByRole("radio", { name, exact: true })).toBeChecked();
        expect(api.document(projectId)!.nodes[0].position).toEqual(original.position);
    }
    const handle = await config.getByRole("button", { name: "重命名节点 生成配置", exact: true }).boundingBox();
    expect(handle).not.toBeNull();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down(); await page.mouse.move(handle!.x + handle!.width / 2 + 90, handle!.y + handle!.height / 2 + 60, { steps: 10 }); await page.mouse.up();
    await expect.poll(() => api.document(projectId)!.nodes[0].position).not.toEqual(original.position);
    expect(api.submissions).toHaveLength(0);
});

test("canvas-audio submits actual speech parameters, completes one node, survives reload and downloads exact original bytes", async ({ page, context, api }, info) => {
    const wav = fixtureWav();
    await configureCanvasTools(context, api); await configureAudioTask(context, api, wav);
    const projectId = await newCanvas(page), config = await addConfig(page, api, projectId);
    await config.getByText("音频", { exact: true }).click();
    await expect(config.getByRole("radio", { name: "音频", exact: true })).toBeChecked();
    await config.getByRole("textbox", { name: "朗读文本", exact: true }).fill("E2E 毛衫细节旁白，保持自然语速。");
    await config.getByRole("button", { name: /Alloy.*MP3/ }).click();
    await page.getByRole("button", { name: /^珊瑚\s*Coral$/ }).click();
    await page.getByRole("button", { name: "WAV", exact: true }).click();
    await page.getByRole("button", { name: "1.25x", exact: true }).click();
    await page.getByPlaceholder("例如：自然、温暖、适合旁白。").fill("自然、清晰的中文旁白");
    await config.getByRole("button", { name: /Coral.*WAV.*1\.25x/ }).click();
    await expect(page.getByPlaceholder("例如：自然、温暖、适合旁白。")).not.toBeVisible();
    await config.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0]).toMatchObject({ operationType: "audio_generation", toolKey: "canvas-audio", modelConfigId: "10000000-0000-4000-8000-000000000002", prompt: "E2E 毛衫细节旁白，保持自然语速。",
        parameters: { voice: "coral", responseFormat: "wav", speed: 1.25, instructions: "自然、清晰的中文旁白" } });
    await expect.poll(() => api.document(projectId)?.nodes.find((node: any) => node.type === "audio")?.metadata?.mediaTask?.taskId).toBe(AUDIO_TASK);
    api.tasks.get(AUDIO_TASK)!.status = "success"; api.tasks.get(AUDIO_TASK)!.resultUrls = [`/api/assets/${AUDIO_TASK}/content`];
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.type === "audio" && node.metadata?.status === "success").length).toBe(1);
    const saved = api.document(projectId)!.nodes.find((node: any) => node.type === "audio");
    expect(saved.metadata).toMatchObject({ mimeType: "audio/wav", bytes: wav.length, durationMs: 2_000, audioVoice: "coral", audioFormat: "wav", audioSpeed: "1.25" });
    await page.reload();
    const output = page.locator(`[data-node-id="${saved.id}"]`);
    await expect(output).toBeAttached();
    await page.keyboard.press("Shift+Digit1");
    await output.click({ position: { x: 20, y: 20 } });
    await expect(output.locator("audio")).toHaveCount(1);
    await expect.poll(() => output.locator("audio").evaluate((audio: HTMLAudioElement) => audio.duration)).toBe(2);
    await output.hover();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载音频", exact: true }).click();
    const download = await downloading;
    await info.attach("audio-download-source", { contentType: "application/json", body: Buffer.from(JSON.stringify({ downloadUrl: download.url(), failure: await download.failure(),
        playbackUrl: await output.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentSrc), originalMetadata: saved.metadata,
        restoredMetadata: api.document(projectId)!.nodes.find((node: any) => node.id === saved.id)?.metadata })) });
    const original = readFileSync((await download.path())!);
    expect(download.suggestedFilename()).toMatch(/\.wav$/);
    expect(sha(original)).toBe(sha(wav)); expect(api.submissions).toHaveLength(1);
    await info.attach("audio-submit-persist-original", { contentType: "application/json", body: Buffer.from(JSON.stringify({ taskId: AUDIO_TASK, request: api.submissions[0], outputId: saved.id,
        mimeType: saved.metadata.mimeType, bytes: wav.length, durationMs: saved.metadata.durationMs, originalSha256: sha(original), filename: download.suggestedFilename(), submissions: api.submissions.length })) });
});

for (const format of ["mp4", "mov"] as const) test(`canvas-video downloads the unchanged ${format.toUpperCase()} original after reload rather than its playback derivative`, async ({ page, context, api }, info) => {
    const videoPath = fileURLToPath(new URL("./media/video.mp4", import.meta.url)), playback = readFileSync(videoPath);
    const originalPath = info.outputPath("original.mov");
    if (format === "mov") execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", videoPath, "-c", "copy", "-f", "mov", originalPath], { windowsHide: true, timeout: 30_000 });
    const original = format === "mov" ? readFileSync(originalPath) : playback, mimeType = format === "mov" ? "video/quicktime" : "video/mp4";
    await context.route("**/api/assets/*/content", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        return api.assets.get(id)?.mimeType?.startsWith("video/") ? route.fulfill({ contentType: api.assets.get(id)!.mimeType, body: api.assetBytes.get(id)! }) : route.fallback();
    });
    await context.route("**/api/assets/*/playback", route => route.fulfill({ contentType: "video/mp4", body: playback }));
    const projectId = await newCanvas(page), choosing = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await choosing).setFiles({ name: `original-video.${format}`, mimeType, buffer: original });
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(1);
    const saved = structuredClone(api.document(projectId)!.nodes[0]);
    expect(saved.type).toBe("video"); expect(saved.metadata).toMatchObject({ mimeType, bytes: original.length });
    await page.reload();
    const output = page.locator(`[data-node-id="${saved.id}"]`);
    await expect(output).toBeAttached(); await page.keyboard.press("Shift+Digit1");
    await output.click({ position: { x: 20, y: 20 } }); await output.hover();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载视频", exact: true }).click();
    const download = await downloading, downloaded = readFileSync((await download.path())!);
    expect(download.suggestedFilename()).toBe(`original-video.${format}`); expect(sha(downloaded)).toBe(sha(original));
    if (format === "mov") expect(sha(downloaded)).not.toBe(sha(playback));
    expect(api.document(projectId)!.nodes[0].metadata).toEqual(saved.metadata); expect(api.submissions).toHaveLength(0);
    await info.attach("video-original-byte-integrity", { contentType: "application/json", body: Buffer.from(JSON.stringify({ format, mimeType, bytes: downloaded.length,
        sourceSha256: sha(original), downloadSha256: sha(downloaded), playbackSha256: sha(playback), filename: download.suggestedFilename(), generatedTasks: api.submissions.length })) });
});

test("canvas-angle uses the selected source bytes and its own tool contract, then retains source and generated node after reload", async ({ page, context, api }, info) => {
    await configureCanvasTools(context, api);
    const projectId = await newCanvas(page); await uploadImage(page, "angle-source.png");
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(1);
    const source = structuredClone(api.document(projectId)!.nodes[0]);
    await openImageTools(page, source.id); await page.getByRole("menuitem", { name: "多角度", exact: true }).click();
    const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "AI 多角度" })).toBeVisible();
    const horizontal = dialog.getByRole("slider").nth(0);
    await horizontal.focus(); await horizontal.press("Home");
    for (let index = 0; index < 30; index++) await horizontal.press("ArrowRight");
    await expect(horizontal).toHaveAttribute("aria-valuenow", "-30");
    await dialog.getByText("广角", { exact: true }).click();
    await dialog.getByRole("button", { name: /^AI\s*生成$/ }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const submitted = api.submissions[0];
    expect(submitted).toMatchObject({ operationType: "inpaint", toolKey: "canvas-angle", modelConfigId: "10000000-0000-4000-8000-000000000001" });
    expect(submitted.prompt).toContain("向左旋转 30 度"); expect(submitted.prompt).toContain("广角镜头");
    expect(submitted.sourceUrls).toHaveLength(1);
    const sourceAssetId = new URL(submitted.sourceUrls[0], page.url()).pathname.split("/")[3];
    expect(sha(api.assetBytes.get(sourceAssetId)!)).toBe(sha(IMAGE));
    await expect.poll(() => api.document(projectId)?.nodes.filter((node: any) => node.id !== source.id && node.type === "image" && node.metadata?.status === "success").length).toBe(1);
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(2);
    const output = api.document(projectId)!.nodes.find((node: any) => node.id !== source.id);
    expect(output.metadata.prompt).toContain("向左旋转 30 度");
    expect(api.document(projectId)!.nodes.find((node: any) => node.id === source.id).metadata).toEqual(source.metadata);
    expect(api.document(projectId)!.connections).toEqual(expect.arrayContaining([expect.objectContaining({ fromNodeId: source.id, toNodeId: output.id })]));
    await page.reload();
    await expect(page.locator(`[data-node-id="${source.id}"]`)).toBeAttached();
    await expect(page.locator(`[data-node-id="${output.id}"]`)).toBeAttached();
    expect(api.submissions).toHaveLength(1);
    await info.attach("angle-source-contract", { contentType: "application/json", body: Buffer.from(JSON.stringify({ sourceNodeId: source.id, outputNodeId: output.id, sourceSha256: sha(IMAGE), request: submitted, submissions: api.submissions.length })) });
});

test("canvas tool switches hide angle and block audio generation without removing uploaded work", async ({ page, context, api }) => {
    await configureCanvasTools(context, api, ["canvas-angle", "canvas-audio"]);
    const projectId = await newCanvas(page); await uploadImage(page, "disabled-tool-original.png");
    await expect.poll(() => api.document(projectId)?.nodes.length).toBe(1);
    const sourceId = api.document(projectId)!.nodes[0].id;
    await openImageTools(page, sourceId);
    await expect(page.getByRole("menuitem", { name: "多角度", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const config = await addConfig(page, api, projectId);
    await config.getByText("音频", { exact: true }).click();
    await expect(config.getByRole("radio", { name: "音频", exact: true })).toBeChecked();
    await config.getByRole("textbox", { name: "朗读文本", exact: true }).fill("工具关闭时不能提交");
    await expect(config.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
    await expect(page.locator(`[data-node-id="${sourceId}"]`)).toBeAttached();
    expect(api.submissions).toHaveLength(0);
});

for (const boundary of ["credits-off", "no-group", "module-off"] as const) {
    test(`team: ${boundary} blocks the direct URL without requesting private group or performance data`, async ({ page, context, api }) => {
        const state = await configureTeam(context, api, { credits: boundary !== "credits-off", groupRole: boundary === "no-group" ? "none" : "leader", teamEnabled: boundary !== "module-off" });
        await page.goto("/team");
        await expect(page.getByRole("heading", { name: boundary === "module-off" ? "此功能暂未开放" : "小组功能暂不可用", exact: true })).toBeVisible();
        await expect(page.getByTestId("performance-dashboard")).toHaveCount(0);
        expect(state.reads).toEqual([]); expect(state.writes).toEqual([]);
    });
}

test("team member sees the group without retired finance controls or leader-only requests", async ({ page, context, api }) => {
    const state = await configureTeam(context, api, { groupRole: "member" });
    await page.goto("/team"); await expect(page.getByRole("heading", { name: "E2E 设计组", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /申请小组额度|归还个人额度/ })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/积分|额度|共享池|人民币|累计成本/);
    await page.getByRole("button", { name: /^刷\s*新$/ }).click();
    expect(state.writes).toEqual([]);
    expect(state.reads).toEqual([]);
    await expect(page.getByTestId("performance-dashboard")).toHaveCount(0);
});

test("team leader can filter business performance and export the audited nonfinancial report", async ({ page, context, api }, info) => {
    const state = await configureTeam(context, api, { groupRole: "leader" });
    await page.goto("/team");
    const dashboard = page.getByTestId("performance-dashboard");
    await expect(dashboard.getByRole("heading", { name: "出图效率与成果转化" })).toBeVisible();
    await expect(dashboard.getByRole("button", { name: /^有效出图/ })).toContainText("3");
    await expect(dashboard.getByText("今日使用人数", { exact: true }).locator("..").locator("..")).toContainText("17");
    for (const label of ["成果下载率", "成果可用性均分", "返工率 / 按时交付率", "积分 / 人民币成本"]) {
        await expect(dashboard.getByRole("button", { name: label })).toHaveCount(0);
    }
    await dashboard.getByText("本周", { exact: true }).click();
    await expect.poll(() => state.reads.filter(path => path.startsWith("/api/performance?")).at(-1)).toContain("preset=week");
    await expect(dashboard.getByText("今日使用人数", { exact: true }).locator("..").locator("..")).toContainText("17");
    await dashboard.getByRole("combobox").first().click();
    await page.locator(".ant-select-dropdown:visible").getByText("隔离设计师", { exact: true }).click();
    await expect.poll(() => state.reads.filter(path => path.startsWith("/api/performance?")).at(-1)).toContain(`userId=${OWNER}`);
    await expect(dashboard.getByText("部门", { exact: true })).toHaveCount(0);
    await expect(dashboard.getByText("小组", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^通\s*过$/ })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/积分|额度|共享池|人民币|累计成本/);
    await expect(page.getByRole("columnheader", { name: /积分|额度|余额|人民币|成本/ })).toHaveCount(0);
    const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "导出本组报表", exact: true }).click();
    const download = await downloading, csv = readFileSync((await download.path())!, "utf8");
    expect(download.suggestedFilename()).toBe("E2E 设计组-历史报表.csv");
    expect(csv).toContain('"E2E 本组原始提示词,含逗号\r\n与""引号"""');
    expect(csv).not.toContain("积分"); expect(csv).not.toContain("人民币成本");
    expect(state.writes).toEqual([]);
    expect(state.reads.some(path => path.includes("group-credits"))).toBe(false);
    expect(state.reads).toContain("/api/team/history/export");
    await info.attach("team-performance-read-write-boundary", { contentType: "application/json", body: Buffer.from(JSON.stringify({ reads: state.reads, writes: state.writes, reportSha256: sha(Buffer.from(csv)), scope: "group leader; team-only controls" })) });
});

test("team leader with performance disabled still sees the team and makes no performance request", async ({ page, context, api }) => {
    const state = await configureTeam(context, api, { groupRole: "leader", performanceEnabled: false });
    await page.goto("/team");
    await expect(page.getByText("本组成员", { exact: true })).toBeVisible();
    await expect(page.getByText("共享池审批", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "导出本组报表", exact: true })).toBeEnabled();
    await expect(page.getByTestId("performance-dashboard")).toHaveCount(0);
    expect(state.reads.some(path => path.startsWith("/api/performance"))).toBe(false);
});

test("performance permission failure stays explicit and does not replace it with another scope", async ({ page, context, api }) => {
    const state = await configureTeam(context, api, { groupRole: "leader", denyPerformance: true });
    await page.goto("/team"); const dashboard = page.getByTestId("performance-dashboard");
    await expect(dashboard.getByRole("alert")).toContainText("E2E_SCOPE_DENIED");
    await expect(dashboard.getByRole("button", { name: /^有效出图/ })).toHaveCount(0);
    const attempts = state.reads.filter(path => path.startsWith("/api/performance?")).length;
    await dashboard.getByRole("button", { name: /^重\s*试$/ }).click();
    await expect.poll(() => state.reads.filter(path => path.startsWith("/api/performance?")).length).toBe(attempts + 1);
    expect([...new Set(state.reads.filter(path => path.startsWith("/api/performance?")))]).toEqual(["/api/performance?preset=month"]);
    expect(state.writes).toEqual([]);
});
