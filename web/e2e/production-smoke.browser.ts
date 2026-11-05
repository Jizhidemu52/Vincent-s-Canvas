import { test, expect, type BrowserContext, type Locator, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SMOKE_CHAT_REPLY, SMOKE_VIDEO_META, SMOKE_VIDEO_SHA256 } from "../../server/tests/production-smoke/mock-provider";

type Seed = { schema: 1; project: string; userId: string; username: string; password: string; paid: false; models: { image: string; video: string; chat: string } };
type Node = { id: string; type: string; title: string; metadata?: { content?: string; sourceTaskId?: string; imageTask?: { taskId?: string }; status?: string } };
type Canvas = { id: string; revision: number; deleted: boolean; document: { nodes: Node[] } | null };
type Task = { id: string; requestId: string; userId: string; modelConfigId: string; status: string; operationType: string; resultUrls: string[]; failureReason?: string; credits: number };
type VideoCodecObservation = { sources: Map<string, string>; tracks: Map<string, string> };
const checks = ["login", "upload", "canvas-image", "refresh-recovery", "original-download", "video-task", "chat"];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function getJson<T>(page: Page, path: string, ownerId?: string): Promise<T> {
    if (!path.startsWith("/api/") && path !== "/deployment-release.json") throw new Error("Only same-origin formal API reads are allowed");
    const result = await page.evaluate(async ({ path, ownerId }) => {
        const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: ownerId ? { "X-Canvas-Owner-Id": ownerId } : {} });
        return { status: response.status, body: await response.json() };
    }, { path, ownerId });
    expect(result.status, `Formal GET ${path}`).toBe(200);
    return result.body as T;
}

async function restrictBrowser(context: BrowserContext, origin: string, outside: string[], errors: string[]) {
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", error => errors.push(error.message));
    // This is an egress guard, never an application/API mock. All same-origin
    // requests continue to the candidate Web/Nginx and formal API containers.
    await context.route("**/*", route => {
        const address = new URL(route.request().url());
        if (["http:", "https:"].includes(address.protocol) && address.origin !== origin) {
            outside.push(`${address.protocol}//${address.host}${address.pathname}`);
            return route.abort("blockedbyclient");
        }
        return route.continue();
    });
    await context.routeWebSocket("**/*", socket => { outside.push("Unexpected browser WebSocket"); socket.close(); });
}

async function login(page: Page, seed: Seed, returnTo = "/canvas") {
    await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    await page.getByLabel("个人账号", { exact: true }).fill(seed.username);
    await page.getByLabel("登录密码", { exact: true }).fill(seed.password);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/auth/login" && value.request().method() === "POST");
    await page.getByRole("button", { name: "登录工作台", exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${returnTo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    const session = await getJson<{ user: { id: string; role: string; mustChangePassword: boolean } }>(page, "/api/auth/session");
    expect(session.user).toMatchObject({ id: seed.userId, role: "designer", mustChangePassword: false });
}

async function completedTask(page: Page, id: string, seed: Seed, operationType: string, modelConfigId: string) {
    let task!: Task;
    await expect.poll(async () => {
        task = (await getJson<{ task: Task }>(page, `/api/tasks/${id}`, seed.userId)).task;
        if (["failed", "paused", "cancelled"].includes(task.status)) throw new Error(`Formal ${operationType} task ${task.status}: ${task.failureReason || "no reason"}`);
        return task.status;
    }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe("success");
    expect(task).toMatchObject({ id, userId: seed.userId, operationType, modelConfigId, credits: 1 });
    expect(task.resultUrls).toHaveLength(1);
    expect(task.resultUrls[0]).toMatch(/^\/api\/assets\/[a-f0-9-]{36}\/content$/);
    return task;
}

async function actualPlayback(page: Page, responses: PlaywrightResponse[], assetId: string, ownerId: string, after = 0) {
    const path = `/api/assets/${assetId}/playback`;
    await expect.poll(() => responses.slice(after).some(response => new URL(response.url()).pathname === path && response.status() === 200), { timeout: 150_000, intervals: [100, 500, 1000] }).toBe(true);
    const response = responses.slice(after).find(value => new URL(value.url()).pathname === path && value.status() === 200)!;
    expect(response.headers()["content-type"]).toBe("video/mp4");
    expect(response.headers()["x-canvas-media-width"]).toBe(String(SMOKE_VIDEO_META.width));
    expect(response.headers()["x-canvas-media-height"]).toBe(String(SMOKE_VIDEO_META.height));
    expect(await response.finished()).toBeNull();
    // Chromium can discard the captured body of a media Blob fetch. Verify a
    // separate read of the same private URL/ETag and bind its hash to the Blob
    // actually played below; this is not an assertion about Response.body().
    expect(response.headers()["etag"]).toBeTruthy();
    const read = await page.request.get(path, { headers: { "X-Canvas-Owner-Id": ownerId, "Cache-Control": "no-cache" } });
    expect(read.status()).toBe(200);
    expect(read.headers()["content-type"]).toBe("video/mp4");
    expect(read.headers()["etag"]).toBe(response.headers()["etag"]);
    const bytes = await read.body();
    const digest = sha256(bytes);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(digest, "The HEVC original must not be returned as its own compatibility preview").not.toBe(SMOKE_VIDEO_SHA256);
    return { status: response.status(), etag: response.headers()["etag"], hashSource: "same-private-url-read", bytes: bytes.byteLength, sha256: digest };
}

async function playVideoToEnd(player: Locator, expectedSha256: string) {
    await expect(player).toBeVisible();
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    await player.evaluate(async (video: HTMLVideoElement) => { video.muted = true; video.loop = false; video.currentTime = 0; await video.play(); });
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => ({ ended: video.ended, error: video.error?.code ?? null })), { timeout: 15_000, intervals: [100, 250] }).toEqual({ ended: true, error: null });
    const played = await player.evaluate(async (video: HTMLVideoElement) => {
        const currentSource = video.currentSrc;
        if (!currentSource.startsWith("blob:")) throw new Error("Player must use the compatibility Blob loaded by the UI");
        const currentBytes = await (await fetch(currentSource)).arrayBuffer();
        const currentSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", currentBytes)), byte => byte.toString(16).padStart(2, "0")).join("");
        const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext("2d")!; context.drawImage(video, 0, 0);
        const pixel = Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data);
        return { ended: video.ended, error: video.error?.code ?? null, currentSrc: currentSource, currentSha256, currentTime: video.currentTime, durationMs: Math.round(video.duration * 1000), width: video.videoWidth, height: video.videoHeight, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames, pixel };
    });
    expect(played).toMatchObject({ ended: true, error: null, width: SMOKE_VIDEO_META.width, height: SMOKE_VIDEO_META.height, durationMs: SMOKE_VIDEO_META.durationMs });
    expect(played.currentTime).toBeGreaterThanOrEqual(SMOKE_VIDEO_META.durationMs / 1000 - 0.1);
    expect(played.currentSha256, "The UI must play the exact successful compatibility response").toBe(expectedSha256);
    expect(played.decodedFrames).toBeGreaterThan(0);
    // Blue fixture pixels also reject a "playing" video whose decoded surface is black.
    expect(played.pixel[0]).toBeLessThan(30); expect(played.pixel[1]).toBeLessThan(30); expect(played.pixel[2]).toBeGreaterThan(150); expect(played.pixel[3]).toBe(255);
    return played;
}

async function originalVideoHash(page: Page, path: string, ownerId: string) {
    expect(path).toMatch(/^\/api\/assets\/[a-f0-9-]{36}\/content$/);
    const response = await page.request.get(path, { headers: { "X-Canvas-Owner-Id": ownerId, "Cache-Control": "no-cache" } });
    expect(response.status()).toBe(200);
    const digest = sha256(await response.body());
    expect(digest).toBe(SMOKE_VIDEO_SHA256);
    return digest;
}

async function observedVideoCodec(observation: VideoCodecObservation, currentSrc: string) {
    // Metadata inspection also creates a temporary player for the HEVC original.
    // Judge only the native player loaded with the Blob whose hash we verified.
    const read = () => [...observation.tracks].flatMap(([playerId, value]) => observation.sources.get(playerId) === currentSrc
        ? (JSON.parse(value) as Array<{ codec: string; profile: string }>).map(track => ({ playerId, ...track })) : []);
    await expect.poll(() => read().map(track => track.codec), { timeout: 10_000 }).toEqual(["h264"]);
    // CDP reports the actual decoder codec. Pixel format is independently
    // checked by the backend's real ffprobe tests, not inferred from this hash.
    return read().map(({ playerId, codec, profile }) => ({ playerId, codec, profile }));
}

test("exact formal stack: login, large upload, canvas generation/recovery, original bytes, video Worker and chat", async ({ page, context, browser, baseURL }, testInfo) => {
    const output = process.env.CANVAS_SMOKE_OUTPUT_DIR!;
    const seed = JSON.parse(await readFile(resolve(output, "seed.private.json"), "utf8")) as Seed;
    expect(seed).toMatchObject({ schema: 1, project: process.env.CANVAS_SMOKE_PROJECT, paid: false });
    const fixture = await readFile(resolve(output, "upload.png"));
    expect(fixture.byteLength).toBeGreaterThan(1024 * 1024);
    const outside: string[] = [], errors: string[] = [], taskPosts: string[] = [], chatPosts: string[] = [];
    const playbackResponses: PlaywrightResponse[] = [];
    await restrictBrowser(context, baseURL!, outside, errors);
    page.on("response", response => { if (/^\/api\/assets\/[a-f0-9-]{36}\/playback$/.test(new URL(response.url()).pathname) && response.request().method() === "GET") playbackResponses.push(response); });
    page.on("request", request => {
        if (request.method() !== "POST") return;
        const path = new URL(request.url()).pathname;
        if (path === "/api/tasks") taskPosts.push(String(request.postDataJSON()?.operationType));
        if (path === "/api/chat/responses") chatPosts.push(path);
    });
    await login(page, seed);
    expect(await getJson(page, "/api/deployment")).toMatchObject({ authenticationEnabled: true, oaLoginEnabled: false, creditsEnabled: true });
    expect(await getJson(page, "/deployment-release.json")).toMatchObject({ schema: 1, commit: process.env.CANVAS_SMOKE_COMMIT });
    if (process.env.CANVAS_SMOKE_MODE === "staging") {
        const entry = await page.request.get("/deployment-release.json");
        expect(entry.headers()["x-canvas-staging"]).toBe(process.env.CANVAS_SMOKE_RUN_ID);
    }
    const cookies = await context.cookies();
    expect(cookies.some(cookie => cookie.name === "canvas_ci_session" && cookie.httpOnly && cookie.secure)).toBe(true);

    await page.getByRole("button", { name: "新建画布", exact: true }).first().click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    const canvasId = new URL(page.url()).pathname.split("/").at(-1)!;
    const skip = page.getByRole("button", { name: "跳过引导", exact: true });
    if (await skip.isVisible()) await skip.click();
    const readCanvas = async (target = page) => (await getJson<{ document: Canvas }>(target, `/api/canvas-documents/${canvasId}`, seed.userId)).document;
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "canvas-smoke-original.png", mimeType: "image/png", buffer: fixture });
    await expect.poll(async () => (await readCanvas()).document?.nodes.filter(node => node.type === "image").length).toBe(1);
    const uploaded = (await readCanvas()).document!.nodes.find(node => node.type === "image")!;
    expect(uploaded.title).toBe("canvas-smoke-original.png");
    expect(uploaded.metadata?.content).toMatch(/^\/api\/assets\/[a-f0-9-]{36}\/content$/);
    const uploadId = uploaded.metadata!.content!.split("/")[3]!;
    const upload = await getJson<{ asset: { ownerUserId: string; status: string; byteSize: number; mimeType: string } }>(page, `/api/assets/${uploadId}`, seed.userId);
    expect(upload.asset).toMatchObject({ ownerUserId: seed.userId, status: "ready", byteSize: fixture.byteLength, mimeType: "image/png" });

    const panel = page.getByTestId("canvas-quick-generate-panel");
    if (!await panel.isVisible()) await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    // Toolbar imports also become edit references. This path deliberately tests
    // text-to-image; clear the reference through the UI, not the canvas node.
    const references = panel.getByRole("region", { name: "已选参考图", exact: true });
    await expect(references.getByRole("button", { name: /^移除参考图 / })).toHaveCount(1);
    await references.getByRole("button", { name: "清空", exact: true }).click();
    await expect(references).toHaveCount(0);
    await expect(panel.getByRole("combobox", { name: "选择模型", exact: true })).toContainText("GPT Image 2");
    await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill("Draw a simple blue fabric square. Formal isolated release smoke.");
    const imageResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST");
    await expect(panel.locator("button.cw-generate-button")).toBeEnabled();
    await panel.locator("button.cw-generate-button").click();
    const submittedImage = await imageResponse;
    expect(submittedImage.request().postDataJSON()).toMatchObject({ operationType: "image_generation", sourceUrls: [] });
    expect(submittedImage.status()).toBe(201);
    const imageTask = (await submittedImage.json()).task as Task;
    await expect.poll(async () => (await readCanvas()).document?.nodes.some(node => node.metadata?.sourceTaskId === imageTask.id || node.metadata?.imageTask?.taskId === imageTask.id)).toBe(true);
    // Refresh after the accepted task has a durable canvas binding. Never
    // click Generate again; recovery must observe the original task identity.
    const refreshStatus = (await getJson<{ task: Task }>(page, `/api/tasks/${imageTask.id}`, seed.userId)).task.status;
    expect(["waiting", "processing"], "Refresh starts while the original task is in flight").toContain(refreshStatus);
    await page.reload();
    const image = await completedTask(page, imageTask.id, seed, "image_generation", seed.models.image);
    await expect.poll(async () => (await readCanvas()).document?.nodes.some(node => node.metadata?.sourceTaskId === image.id && node.metadata.content === image.resultUrls[0])).toBe(true);
    const canvas = await readCanvas();
    const generated = canvas.document!.nodes.find(node => node.metadata?.sourceTaskId === image.id)!;
    await expect(page.locator(`[data-node-id="${generated.id}"]`)).toBeVisible();
    expect(taskPosts).toEqual(["image_generation"]);

    const collapse = page.getByRole("button", { name: "收起创建面板", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    const originalNode = page.locator(`[data-node-id="${uploaded.id}"]`);
    await originalNode.click({ position: { x: 30, y: 12 } });
    await originalNode.hover();
    const downloadButton = page.getByRole("button", { name: "下载图片", exact: true });
    if (await downloadButton.isVisible()) await downloadButton.click();
    else {
        await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
        await page.getByRole("menuitem", { name: "下载", exact: true }).click();
    }
    const downloadDialog = page.getByRole("dialog", { name: "下载图片", exact: true });
    const downloaded = page.waitForEvent("download");
    await downloadDialog.getByRole("button", { name: "下载原图（原格式，推荐）", exact: true }).click();
    const originalFile = testInfo.outputPath("downloaded-original.png");
    await (await downloaded).saveAs(originalFile);
    const originalBytes = await readFile(originalFile);
    expect(originalBytes).toEqual(fixture);
    const dimensions = await page.evaluate(async encoded => {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        const blob = new Blob([bytes], { type: "image/png" });
        const image = await createImageBitmap(blob);
        const size = { width: image.width, height: image.height }; image.close(); return size;
    }, fixture.toString("base64"));
    expect(dimensions).toEqual({ width: 1024, height: 1024 });

    const videoMedia = await context.newCDPSession(page);
    const videoCodecs: VideoCodecObservation = { sources: new Map(), tracks: new Map() };
    videoMedia.on("Media.playerPropertiesChanged", event => {
        for (const property of event.properties) if (property.name === "kVideoTracks") videoCodecs.tracks.set(event.playerId, property.value);
    });
    videoMedia.on("Media.playerEventsAdded", event => {
        for (const entry of event.events) {
            const value = JSON.parse(entry.value) as { event?: string; url?: string };
            if (value.event === "kLoad" && typeof value.url === "string") videoCodecs.sources.set(event.playerId, value.url);
        }
    });
    await videoMedia.send("Media.enable");
    await page.goto("/video");
    await page.getByRole("checkbox", { name: "不经 AI 整理，直接发送", exact: true }).check();
    await page.getByRole("textbox", { name: "视频提示词", exact: true }).fill("A blue square moves slowly. Formal isolated release smoke.");
    const videoResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST" && response.request().postDataJSON()?.operationType === "video_generation");
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    const submittedVideo = await videoResponse;
    expect(submittedVideo.status()).toBe(201);
    const videoTask = (await submittedVideo.json()).task as Task;
    const video = await completedTask(page, videoTask.id, seed, "video_generation", seed.models.video);
    const videoAssetId = video.resultUrls[0]!.split("/")[3]!;
    const videoOriginalBefore = await originalVideoHash(page, video.resultUrls[0]!, seed.userId);
    const firstPlayback = await actualPlayback(page, playbackResponses, videoAssetId, seed.userId);
    const player = page.locator("video").first();
    const firstPlayed = await playVideoToEnd(player, firstPlayback.sha256);
    const firstCodecs = await observedVideoCodec(videoCodecs, firstPlayed.currentSrc);
    const videoDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载", exact: true }).first().click();
    const videoOriginalFile = testInfo.outputPath("downloaded-original-hevc.mp4");
    await (await videoDownload).saveAs(videoOriginalFile);
    const videoDownloadHash = sha256(await readFile(videoOriginalFile)); expect(videoDownloadHash).toBe(SMOKE_VIDEO_SHA256);
    const playbackBeforeRefresh = playbackResponses.length;
    await page.reload();
    const refreshedPlayback = await actualPlayback(page, playbackResponses, videoAssetId, seed.userId, playbackBeforeRefresh);
    const refreshedPlayed = await playVideoToEnd(page.locator("video").first(), refreshedPlayback.sha256);
    const refreshedCodecs = await observedVideoCodec(videoCodecs, refreshedPlayed.currentSrc);
    await videoMedia.detach();
    const refreshedTask = await completedTask(page, video.id, seed, "video_generation", seed.models.video);
    expect(refreshedTask.resultUrls).toEqual(video.resultUrls);
    const videoOriginalAfter = await originalVideoHash(page, video.resultUrls[0]!, seed.userId);
    expect(refreshedPlayback.sha256).toBe(firstPlayback.sha256);
    expect(taskPosts).toEqual(["image_generation", "video_generation"]);

    await page.goto("/chat");
    const composer = page.getByRole("textbox", { name: "对话内容", exact: true });
    await expect(composer).toBeEnabled();
    await composer.fill("Reply with a short confirmation only; do not generate or edit any image.");
    const chatResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat/responses" && response.request().method() === "POST");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const replied = await chatResponse;
    expect(replied.status()).toBe(200);
    expect(await replied.json()).toMatchObject({ content: SMOKE_CHAT_REPLY, toolCalls: [] });
    await expect(page.getByText(SMOKE_CHAT_REPLY, { exact: true })).toBeVisible();
    expect(chatPosts).toHaveLength(1);
    expect(taskPosts).toEqual(["image_generation", "video_generation"]);

    // A clean browser context has no IndexedDB/localStorage/cookies. Re-login
    // through the real UI and recover the same server-saved canvas and assets.
    const fresh = await browser.newContext({ baseURL, viewport: { width: 1600, height: 1100 }, locale: "zh-CN", serviceWorkers: "block" });
    try {
        await restrictBrowser(fresh, baseURL!, outside, errors);
        const recovered = await fresh.newPage();
        await login(recovered, seed, `/canvas/${canvasId}`);
        await expect(recovered.locator(`[data-node-id="${uploaded.id}"]`)).toBeVisible();
        await expect(recovered.locator(`[data-node-id="${generated.id}"]`)).toBeVisible();
        const restored = await readCanvas(recovered);
        expect(restored.revision).toBeGreaterThanOrEqual(canvas.revision);
        expect(restored.document!.nodes.find(node => node.id === uploaded.id)?.metadata?.content).toBe(uploaded.metadata!.content);
        expect(restored.document!.nodes.find(node => node.id === generated.id)?.metadata).toMatchObject({ sourceTaskId: image.id, content: image.resultUrls[0] });
        await recovered.screenshot({ path: testInfo.outputPath("formal-canvas-restored.png"), animations: "disabled" });
    } finally { await fresh.close(); }

    expect(outside, "No browser request leaves the isolated Web origin").toEqual([]);
    expect(errors, "No uncaught browser error").toEqual([]);
    // The shell validates this against provider receipts before creating the
    // exact public browser-smoke.json consumed by the artifact sealer.
    await writeFile(resolve(output, "browser-checks.private.json"), JSON.stringify({
        schema: 1, status: "passed", project: seed.project, checks, canvasId, revision: canvas.revision,
        imageTaskId: image.id, videoTaskId: video.id, uploadAssetId: uploadId,
        original: { bytes: originalBytes.byteLength, sha256: sha256(originalBytes), ...dimensions },
        videoPlayback: { assetId: videoAssetId, originalBefore: videoOriginalBefore, originalAfter: videoOriginalAfter, downloadedOriginal: videoDownloadHash, first: { ...firstPlayback, ...firstPlayed, codecs: firstCodecs }, refreshed: { ...refreshedPlayback, ...refreshedPlayed, codecs: refreshedCodecs } },
        taskPosts, chatPosts: chatPosts.length, refreshStatus, paid: false,
    }, null, 2), { flag: "wx", mode: 0o600 });
});
