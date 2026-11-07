import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, IMAGE, type MockCanvasApi } from "./fixtures";

const pane = (page: Page) => page.getByRole("tabpanel");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const dialog = (page: Page, title: string) => page.getByRole("dialog", { name: title, exact: true });

function watchPosts(page: Page) {
    const posts: string[] = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/") && request.method() === "POST") posts.push(url.pathname); });
    return posts;
}
function localOnly(api: MockCanvasApi, posts: string[]) {
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
    expect(api.assets.size).toBe(0);
    // Module visit telemetry is expected; local tools must never upload or invoke AI.
    expect(posts.filter(path => path !== "/api/usage/events")).toEqual([]);
}
async function upload(page: Page, label: string, name: string, buffer: Buffer) {
    await pane(page).getByLabel(`上传${label}`, { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer });
    await expect(pane(page).getByRole("img", { name, exact: true })).toBeVisible();
}
async function readDraft(page: Page, scene: string): Promise<any> {
    return page.evaluate(async sceneId => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        const owner = useUserStore.getState().user!.id;
        return createWorkspaceStorage("creative_scene_workspaces").getItem(`draft:${encodeURIComponent(owner)}:${sceneId}`);
    }, scene);
}
async function readLogs(page: Page, scene: string): Promise<any[]> {
    return page.evaluate(async sceneId => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        const prefix = `history-record:${encodeURIComponent(useUserStore.getState().user!.id)}:${sceneId}:`;
        const logs: any[] = [];
        await createWorkspaceStorage("creative_scene_workspaces").iterate((value, key) => { if (key.startsWith(prefix)) logs.push(value); });
        return logs;
    }, scene);
}
async function storedBytes(page: Page, storageKey: string) {
    return Buffer.from(await page.evaluate(async key => {
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const blob = await getImageBlob(key);
        if (!blob) throw new Error("Expected original local bytes");
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }, storageKey));
}
async function sourceIdentity(page: Page, scene: string, bytes: Buffer) {
    await expect.poll(async () => Boolean((await readDraft(page, scene))?.images?.primary?.storageKey)).toBe(true);
    const image = (await readDraft(page, scene)).images.primary;
    expect((await storedBytes(page, image.storageKey)).equals(bytes)).toBe(true);
    return { id: image.id, storageKey: image.storageKey, sha256: sha256(bytes) };
}
async function assertOriginal(page: Page, scene: string, original: { id: string; storageKey: string; sha256: string }) {
    const image = (await readDraft(page, scene)).images.primary;
    expect(image).toMatchObject({ id: original.id, storageKey: original.storageKey });
    expect(sha256(await storedBytes(page, image.storageKey))).toBe(original.sha256);
}
async function makeRaster(page: Page, kind: "colors" | "lines" | "blank") {
    const base64 = await page.evaluate(kind => {
        const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 96;
        const ctx = canvas.getContext("2d")!;
        if (kind === "colors") {
            ctx.fillStyle = "#FF0000"; ctx.fillRect(0, 0, 64, 80);
            ctx.fillStyle = "#0000FF"; ctx.fillRect(64, 0, 64, 80);
            ctx.fillStyle = "#00FF00"; ctx.fillRect(33, 32, 1, 1);
        } else {
            ctx.fillStyle = "white"; ctx.fillRect(0, 0, 128, 96);
            if (kind === "lines") {
                ctx.fillStyle = "black"; ctx.fillRect(20, 20, 24, 56); ctx.fillRect(44, 52, 50, 24);
                ctx.fillStyle = "#777777"; ctx.fillRect(74, 20, 20, 20);
            }
        }
        return canvas.toDataURL("image/png").split(",")[1];
    }, kind);
    return Buffer.from(base64, "base64");
}
async function downloadBytes(page: Page, trigger: Locator) {
    const received = page.waitForEvent("download");
    await trigger.click();
    const download = await received;
    const path = await download.path();
    expect(path).toBeTruthy();
    return { filename: download.suggestedFilename(), bytes: await readFile(path!) };
}
async function evidence(page: Page, target: Locator, info: TestInfo, name: string) {
    await target.screenshot({ path: info.outputPath(`${name}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await target.screenshot({ path: info.outputPath(`${name}-mobile.png`) });
}
async function openColorLibrary(page: Page, slot = 1) {
    await pane(page).getByRole("button", { name: `从标准色库选择颜色 ${slot}`, exact: true }).click();
    const modal = dialog(page, `从标准色库选择 · 颜色 ${slot}`);
    await expect(modal).toBeVisible();
    return modal;
}
async function drawSelection(page: Page, modal: Locator) {
    const canvas = modal.getByLabel("修改区域画布", { exact: true });
    await expect(modal.getByRole("button", { name: "保存选区", exact: true })).toBeEnabled();
    // Reading pixels may finish during the modal's scale-in animation. Wait for
    // the actual drawing surface to stabilize before measuring drag coordinates.
    await canvas.hover();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * .35, box.y + box.height * .5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height * .5, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.getContext("2d")!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data[3])).toBe(255);
    return canvas;
}
async function maskFacts(page: Page, storageKey: string) {
    return page.evaluate(async key => {
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const blob = await getImageBlob(key);
        if (!blob) throw new Error("Missing saved selection");
        const image = await createImageBitmap(blob);
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); image.close();
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let selected = 0;
        for (let index = 3; index < rgba.length; index += 4) if (rgba[index]) selected++;
        return { width: canvas.width, height: canvas.height, selected, center: rgba[(Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4 + 3], corner: rgba[3] };
    }, storageKey);
}

test("standard colors use real lazy local data, paginate and fill only the confirmed slot across reload", async ({ page, api }, info) => {
    const posts = watchPosts(page), colorReads: string[] = [];
    page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/color-library/")) colorReads.push(path); });
    await page.goto("/creative/garment-colorway");
    await pane(page).getByRole("radio", { name: "指定颜色", exact: true }).check();
    expect(colorReads).toEqual([]);
    const original = await pane(page).getByRole("textbox", { name: "颜色 2 HEX 色值", exact: true }).inputValue();
    const modal = await openColorLibrary(page, 2);
    const cards = modal.locator("button.sc-card");
    await expect(cards).toHaveCount(48);
    const first = await cards.first().getAttribute("aria-label");
    await modal.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(cards.first()).not.toHaveAttribute("aria-label", first!);
    await modal.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(cards.first()).toHaveAttribute("aria-label", first!);
    await cards.first().click();
    const selected = (await cards.first().getAttribute("aria-label"))!;
    const selectedHex = selected.match(/#[0-9A-F]{6}$/)![0];
    await modal.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(pane(page).getByRole("textbox", { name: "颜色 2 HEX 色值", exact: true })).toHaveValue(original);
    const reopened = await openColorLibrary(page, 2);
    await reopened.getByRole("searchbox", { name: "色号 / 名称 / HEX", exact: true }).fill(selectedHex);
    await expect(reopened.locator("button.sc-card").first()).toHaveAttribute("aria-label", selected);
    await reopened.locator("button.sc-card").first().click();
    await evidence(page, reopened, info, "standard-colors");
    await reopened.getByRole("button", { name: "应用到颜色 2", exact: true }).click();
    await expect(pane(page).getByRole("textbox", { name: "颜色 2 HEX 色值", exact: true })).toHaveValue(selectedHex);
    await expect(pane(page).getByRole("textbox", { name: "颜色 1 HEX 色值", exact: true })).toHaveValue("#789282");
    await expect.poll(async () => (await readDraft(page, "garment-colorway"))?.form.colorSelections?.[1]?.hex).toBe(selectedHex);
    const saved = (await readDraft(page, "garment-colorway")).form.colorSelections[1];
    expect(saved).toMatchObject({ library: "PANTONE TCX", hex: selectedHex });
    expect(saved.datasetVersion).toBeTruthy(); expect(saved.sourceUrl).toMatch(/^https?:/);
    await page.reload();
    await expect(pane(page).getByRole("textbox", { name: "颜色 2 HEX 色值", exact: true })).toHaveValue(selectedHex);
    expect((await readDraft(page, "garment-colorway")).form.colorSelections[1]).toEqual(saved);
    expect(colorReads.filter(path => path.endsWith("manifest.json"))).toHaveLength(1);
    localOnly(api, posts);
});

test("standard color load failure is explicit and retries only on click, with invalid and empty searches safe", async ({ page, api }) => {
    const posts = watchPosts(page); let manifests = 0;
    await page.route("**/color-library/manifest.json", route => { manifests++; return manifests === 1 ? route.fulfill({ status: 503, body: "isolated unavailable" }) : route.continue(); });
    await page.goto("/creative/garment-colorway");
    await pane(page).getByRole("radio", { name: "指定颜色", exact: true }).check();
    const modal = await openColorLibrary(page);
    await expect(modal.getByRole("alert")).toContainText("503");
    expect(manifests).toBe(1);
    await expect(modal.getByRole("button", { name: "应用到颜色 1", exact: true })).toBeDisabled();
    await modal.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect(modal.locator("button.sc-card")).toHaveCount(48); expect(manifests).toBe(2);
    await modal.getByRole("textbox", { name: "参考色", exact: true }).fill("BADHEX");
    await expect(modal.getByRole("button", { name: "寻找相近色", exact: true })).toBeDisabled();
    await modal.getByRole("searchbox", { name: "色号 / 名称 / HEX", exact: true }).fill("NO_SUCH_COLOR_731");
    await expect(modal.getByText("没有找到匹配色号，请缩短关键词或切换到全部色库。", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(pane(page).getByRole("textbox", { name: "颜色 1 HEX 色值", exact: true })).toHaveValue("#789282");
    localOnly(api, posts);
});

test("photo sampling maps real pixels and precise keys, ignores transparency, and applies a confirmed nearest color", async ({ page, api }, info) => {
    const posts = watchPosts(page);
    await page.goto("/creative/garment-colorway");
    const bytes = await makeRaster(page, "colors");
    await upload(page, "服装参考图", "sample-color-original.png", bytes);
    const original = await sourceIdentity(page, "garment-colorway", bytes);
    await pane(page).getByRole("radio", { name: "指定颜色", exact: true }).check();
    const modal = await openColorLibrary(page);
    await modal.getByText("从已上传的款式图取色", { exact: true }).click();
    const sampler = modal.getByRole("button", { name: "衣服照片取色", exact: true });
    await expect(sampler).toBeVisible();
    const photo = sampler.getByRole("img"); const box = (await photo.boundingBox())!;
    // MouseEvent client coordinates are integral; ceil the source pixel boundary
    // so a fractional CSS top does not select the preceding row.
    await page.mouse.click(Math.ceil(box.x + 32 / 128 * box.width), Math.ceil(box.y + 32 / 96 * box.height));
    await expect(modal.getByRole("textbox", { name: "参考色", exact: true })).toHaveValue("#FF0000");
    await expect(modal.getByRole("button", { name: "寻找相近色", exact: true })).toHaveAttribute("aria-pressed", "true");
    await sampler.press("Shift+ArrowRight");
    await expect(modal.getByText("取色位置：横向 34，纵向 33", { exact: true })).toBeVisible();
    await sampler.press("Enter");
    await expect(modal.getByRole("textbox", { name: "参考色", exact: true })).toHaveValue("#00FF00");
    await page.mouse.click(box.x + 32.5 / 128 * box.width, box.y + 90.5 / 96 * box.height);
    await expect(modal.getByText("此处为透明像素，请选择衣服上的其他位置", { exact: true })).toBeVisible();
    await expect(modal.getByRole("textbox", { name: "参考色", exact: true })).toHaveValue("#00FF00");
    await expect(modal.locator("button.sc-card")).toHaveCount(48);
    const chosen = (await modal.locator("button.sc-card").first().getAttribute("aria-label"))!.match(/#[0-9A-F]{6}$/)![0];
    await modal.locator("button.sc-card").first().click();
    await evidence(page, modal, info, "photo-color-picker");
    await modal.getByRole("button", { name: "应用到颜色 1", exact: true }).click();
    await expect.poll(async () => (await readDraft(page, "garment-colorway"))?.form.colors?.[0]).toBe(chosen);
    await page.reload();
    await expect(pane(page).getByRole("textbox", { name: "颜色 1 HEX 色值", exact: true })).toHaveValue(chosen);
    await assertOriginal(page, "garment-colorway", original);
    localOnly(api, posts);
});

test("precise recolor saves one non-cascading local result with unchanged source, dimensions, alpha and download bytes", async ({ page, api }, info) => {
    const posts = watchPosts(page);
    await page.goto("/creative/pattern-colorway");
    const bytes = await makeRaster(page, "colors");
    await upload(page, "图案参考图", "pattern-original.png", bytes);
    const original = await sourceIdentity(page, "pattern-colorway", bytes);
    await pane(page).getByRole("button", { name: /精确换色/ }).click();
    const modal = dialog(page, "精确换色 · 本地处理");
    await expect(modal.getByRole("textbox", { name: "原色 HEX 1", exact: true })).toBeEnabled();
    await modal.getByRole("button", { name: "保存换色结果", exact: true }).click();
    await expect(modal.getByRole("alert")).toContainText("没有发生颜色变化");
    await modal.getByRole("textbox", { name: "原色 HEX 1", exact: true }).fill("#FF0000");
    await modal.getByRole("textbox", { name: "目标色 HEX 1", exact: true }).fill("#00FF00");
    await modal.getByRole("button", { name: "添加映射", exact: true }).click();
    await modal.getByRole("textbox", { name: "原色 HEX 2", exact: true }).fill("#00FF00");
    await modal.getByRole("textbox", { name: "目标色 HEX 2", exact: true }).fill("#FFFF00");
    await modal.getByRole("slider").press("Home");
    await expect(modal.getByText("换色预览", { exact: true })).toBeVisible();
    await evidence(page, modal, info, "pattern-recolor");
    // Ant Design can retain its zero-width exiting icon in the accessible name.
    // Match the action text, but still require the actual saving state to end.
    const save = modal.getByRole("button", { name: /保存换色结果$/ });
    await expect(save).not.toHaveClass(/ant-btn-loading/);
    await save.dblclick();
    await expect(modal).toHaveCount(0);
    await expect(pane(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    await expect.poll(async () => (await readLogs(page, "pattern-colorway")).length).toBe(1);
    const log = (await readLogs(page, "pattern-colorway"))[0];
    expect(log).toMatchObject({ operation: "recolor", successCount: 1, failCount: 0, inputArchiveVersion: 1 });
    expect(log.prompt).toContain("RGB 容差 0%");
    const result = await storedBytes(page, log.results[0].image.storageKey);
    const facts = await page.evaluate(async data => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(data)], { type: "image/png" }));
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); image.close();
        const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        return { width: canvas.width, height: canvas.height, redSource: pixel(32, 32), greenSource: pixel(33, 32), blueSource: pixel(100, 32), transparent: pixel(32, 90) };
    }, [...result]);
    expect(facts).toEqual({ width: 128, height: 96, redSource: [0, 255, 0, 255], greenSource: [255, 255, 0, 255], blueSource: [0, 0, 255, 255], transparent: [0, 0, 0, 0] });
    const downloaded = await downloadBytes(page, pane(page).getByRole("button", { name: "下载原图", exact: true }));
    expect(downloaded.bytes.equals(result)).toBe(true);
    await page.reload();
    await pane(page).getByRole("button", { name: /^最近任务/ }).click();
    await pane(page).locator("button.cs-history-item").first().click();
    await expect(pane(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(sha256((await downloadBytes(page, pane(page).getByRole("button", { name: "下载原图", exact: true }))).bytes)).toBe(sha256(result));
    await assertOriginal(page, "pattern-colorway", original);
    localOnly(api, posts);
    await info.attach("recolor-integrity", { body: JSON.stringify({ originalSha256: original.sha256, resultSha256: sha256(result), resultBytes: result.length, facts, generationPosts: 0 }), contentType: "application/json" });
});

test("SVG tracing runs a real local worker and downloads paths only, while blank input stays an explicit failure", async ({ page, api }, info) => {
    const posts = watchPosts(page);
    await page.goto("/creative/style-to-sketch");
    const bytes = await makeRaster(page, "lines");
    await upload(page, "服装参考图", "line-original.png", bytes);
    const original = await sourceIdentity(page, "style-to-sketch", bytes);
    await pane(page).getByRole("button", { name: "已有线稿转 SVG", exact: true }).click();
    const modal = dialog(page, "线稿矢量化 · SVG 路径");
    await expect(modal.getByRole("link", { name: "下载 SVG", exact: true })).toBeEnabled();
    await expect(modal.getByRole("img", { name: "SVG 矢量预览", exact: true })).toBeVisible();
    await modal.getByRole("slider").nth(2).press("ArrowRight");
    await expect(modal.getByRole("link", { name: "下载 SVG", exact: true })).toBeEnabled();
    const previewSvg = await modal.getByRole("img", { name: "SVG 矢量预览", exact: true }).evaluate(async (image: HTMLImageElement) => (await fetch(image.src)).text());
    const downloaded = await downloadBytes(page, modal.getByRole("link", { name: "下载 SVG", exact: true }));
    expect(downloaded.filename).toBe("line-original-矢量.svg");
    expect(downloaded.bytes.toString("utf8")).toBe(previewSvg);
    expect(previewSvg).toMatch(/<path\b[^>]*fill="rgb\(0,0,0\)"/);
    expect(previewSvg).toMatch(/viewBox="0 0 128 96"/);
    expect(previewSvg).not.toMatch(/<(?:image|script|foreignObject)\b|(?:xlink:)?href\s*=/i);
    await evidence(page, modal, info, "svg-trace");
    await modal.getByRole("button", { name: /^关\s*闭$/, exact: true }).click();
    await page.reload();
    await expect(pane(page).getByRole("img", { name: "line-original.png", exact: true })).toBeVisible();
    await assertOriginal(page, "style-to-sketch", original);
    const blank = await makeRaster(page, "blank");
    await upload(page, "服装参考图", "blank-original.png", blank);
    await pane(page).getByRole("button", { name: "已有线稿转 SVG", exact: true }).click();
    await expect(modal.getByRole("alert")).toContainText("未检测到黑白线条");
    await expect(modal.getByRole("button", { name: "下载 SVG", exact: true })).toBeDisabled();
    await expect(modal.getByRole("img", { name: "SVG 矢量预览", exact: true })).toHaveCount(0);
    localOnly(api, posts);
    await info.attach("svg-integrity", { body: JSON.stringify({ originalSha256: original.sha256, svgSha256: sha256(downloaded.bytes), svgBytes: downloaded.bytes.length, generationPosts: 0 }), contentType: "application/json" });
});

test("creative selection rejects empty saves and preserves its original-resolution mask through edit cancel, reload and explicit clear", async ({ page, api }, info) => {
    const posts = watchPosts(page);
    await page.goto("/creative/local-restyle");
    await upload(page, "服装参考图", "selection-original.png", IMAGE);
    const original = await sourceIdentity(page, "local-restyle", IMAGE);
    await pane(page).getByRole("button", { name: "涂选修改区域", exact: true }).click();
    const modal = dialog(page, "涂选修改区域");
    await modal.getByRole("button", { name: "保存选区", exact: true }).click();
    await expect(modal.getByRole("alert")).toContainText("请先涂选");
    expect((await readDraft(page, "local-restyle")).selection).toBeNull();
    const canvas = await drawSelection(page, modal);
    await expect(modal.getByRole("alert")).toHaveCount(0);
    await expect(canvas).toHaveAttribute("width", "256"); await expect(canvas).toHaveAttribute("height", "256");
    await evidence(page, modal, info, "creative-selection");
    await modal.getByRole("button", { name: "保存选区", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect.poll(async () => Boolean((await readDraft(page, "local-restyle"))?.selection?.mask.storageKey)).toBe(true);
    const selection = (await readDraft(page, "local-restyle")).selection;
    expect(selection.sourceId).toBe(original.id);
    const maskSha = sha256(await storedBytes(page, selection.mask.storageKey));
    expect(await maskFacts(page, selection.mask.storageKey)).toMatchObject({ width: 256, height: 256, center: 255, corner: 0 });
    await page.reload();
    await pane(page).getByRole("button", { name: "编辑修改选区", exact: true }).click();
    const existingPixels = await modal.getByLabel("修改区域画布", { exact: true }).evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.getImageData(128, 128, 1, 1).data[3]);
    expect(existingPixels).toBe(255);
    await modal.getByRole("button", { name: /^清\s*空$/ }).click();
    await modal.getByRole("button", { name: /^取\s*消$/ }).click();
    expect(sha256(await storedBytes(page, (await readDraft(page, "local-restyle")).selection.mask.storageKey))).toBe(maskSha);
    await pane(page).getByRole("button", { name: "编辑修改选区", exact: true }).click();
    await expect.poll(() => modal.getByLabel("修改区域画布", { exact: true }).evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.getImageData(128, 128, 1, 1).data[3])).toBe(255);
    await modal.getByRole("button", { name: /^取\s*消$/ }).click();
    await pane(page).getByRole("button", { name: "清除选区，使用整图 AI 修改", exact: true }).click();
    await expect.poll(async () => (await readDraft(page, "local-restyle"))?.selection).toBeNull();
    await page.reload();
    await expect(pane(page).getByRole("button", { name: "涂选修改区域", exact: true })).toBeEnabled();
    await expect(pane(page).getByRole("button", { name: "编辑修改选区", exact: true })).toHaveCount(0);
    await assertOriginal(page, "local-restyle", original);
    localOnly(api, posts);
});

test("one explicit creative selection generation composites only selected pixels and restores the same result without replay", async ({ page, api }, info) => {
    const posts = watchPosts(page);
    await page.goto("/creative/local-restyle");
    await upload(page, "服装参考图", "composite-original.png", IMAGE);
    const original = await sourceIdentity(page, "local-restyle", IMAGE);
    await pane(page).getByRole("button", { name: "涂选修改区域", exact: true }).click();
    const modal = dialog(page, "涂选修改区域");
    await drawSelection(page, modal);
    await modal.getByRole("button", { name: "保存选区", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await pane(page).getByRole("textbox", { name: "要改成什么样", exact: true }).fill("只改变已涂选范围，保留其他所有原像素");
    localOnly(api, posts);
    await pane(page).locator("button.cs-generate").click();
    await expect(pane(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "creative-local-restyle", promptInput: { fields: { selectionGuide: true }, referenceRoles: ["服装主图", "蓝色局部修改选区示意图"] } });
    const sourceId = api.submissions[0].sourceUrls[0].split("/")[3];
    expect(api.assetBytes.get(sourceId)!.equals(IMAGE)).toBe(true);
    const log = (await readLogs(page, "local-restyle"))[0];
    const pixelFacts = await page.evaluate(async keys => {
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const read = async (key: string) => {
            const image = await createImageBitmap((await getImageBlob(key))!);
            const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); image.close();
            return { width: canvas.width, height: canvas.height, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
        };
        const [source, mask, result] = await Promise.all(keys.map(read));
        let outside = 0, outsideDifferences = 0, insideChanged = 0;
        for (let at = 0; at < source.pixels.length; at += 4) {
            const changed = [0, 1, 2, 3].some(channel => source.pixels[at + channel] !== result.pixels[at + channel]);
            if (mask.pixels[at + 3] === 0) { outside++; if (changed) outsideDifferences++; }
            else if (changed) insideChanged++;
        }
        return { sourceSize: [source.width, source.height], resultSize: [result.width, result.height], outside, outsideDifferences, insideChanged };
    }, [log.referenceImages.primary.storageKey, log.selection.mask.storageKey, log.results[0].image.storageKey]);
    expect(pixelFacts.sourceSize).toEqual([256, 256]); expect(pixelFacts.resultSize).toEqual([256, 256]);
    expect(pixelFacts.outside).toBeGreaterThan(60_000); expect(pixelFacts.outsideDifferences).toBe(0); expect(pixelFacts.insideChanged).toBeGreaterThan(100);
    const result = await storedBytes(page, log.results[0].image.storageKey);
    expect((await downloadBytes(page, pane(page).getByRole("button", { name: "下载原图", exact: true }))).bytes.equals(result)).toBe(true);
    await page.reload();
    await pane(page).getByRole("button", { name: /^最近任务/ }).click();
    await pane(page).locator("button.cs-history-item").first().click();
    await expect(pane(page).getByRole("button", { name: "下载原图", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(sha256((await downloadBytes(page, pane(page).getByRole("button", { name: "下载原图", exact: true }))).bytes)).toBe(sha256(result));
    await assertOriginal(page, "local-restyle", original);
    expect(posts.filter(path => path === "/api/tasks")).toHaveLength(1);
    expect(posts.filter(path => /prompt-compilations|chat\/responses|\/batch/.test(path))).toEqual([]);
    await info.attach("selection-integrity", { body: JSON.stringify({ originalSha256: original.sha256, resultSha256: sha256(result), pixelFacts, mockGenerationPosts: 1, realProviderCalls: 0 }), contentType: "application/json" });
});
