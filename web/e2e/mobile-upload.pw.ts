import type { Locator, Page } from "@playwright/test";
import { test, expect, newCanvas, IMAGE, type MockCanvasApi } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { activeWorkbench, workbenchPanes, readWorkbenchRegistry } from "./headless-workbench";
import { expectPersistedReferenceOriginal } from "./reference-image-assertions";

const file = (name: string) => ({ name, mimeType: "image/png", buffer: IMAGE });
const videoModel = { id: "10000000-0000-4000-8000-000000000003", name: "隔离视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 };

test.use({ isMobile: true, hasTouch: true });

async function chooseImage(page: Page, trigger: Locator, names: string[]) {
    const pending = page.waitForEvent("filechooser");
    await trigger.click();
    const chooser = await pending;
    expect(await chooser.element().getAttribute("capture")).toBeNull();
    await chooser.setFiles(names.map(file));
}

async function expectOriginal(image: Locator) {
    await expect(image).toBeVisible();
    expect(Buffer.from(await image.evaluate(async (element: HTMLImageElement) => [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())])).equals(IMAGE)).toBe(true);
}

async function expectGalleryReference(page: Page, api: MockCanvasApi, name: string) {
    await expectPersistedReferenceOriginal(page, name);
    const uploads = [...api.assets.values()].filter(asset => asset.filename === name);
    expect(uploads).toHaveLength(1);
    expect(api.assetBytes.get(uploads[0].id)?.equals(IMAGE)).toBe(true);
}

async function expectReachable(control: Locator) {
    await expect(control).toBeInViewport({ ratio: 1 });
    expect(await control.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
}

test.beforeEach(async ({ context, api }) => {
    expect(api.submissions).toHaveLength(0);
    await context.route(url => url.pathname === "/api/prompt-templates", route => route.fulfill({ json: { templates: [], total: 0, hasMore: false } }));
});

for (const width of [320, 390]) {
    test(`image picker uploads gallery originals into the active task at ${width}px`, async ({ page, api }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/image?tool=image-edit");
        await activeWorkbench(page).getByRole("tab", { name: /历史记录/ }).click();
        await activeWorkbench(page).locator(".image-history-panel").getByRole("button", { name: "新建", exact: true }).click();
        await expect(workbenchPanes(page)).toHaveCount(2);
        await expect(workbenchPanes(page).nth(1)).toBeVisible();
        await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
        const upload = dialog.getByRole("button", { name: "从相册 / 本机上传", exact: true });
        await expectReachable(upload);
        await expect(upload).toHaveCSS("min-height", "44px");
        await page.screenshot({ path: info.outputPath(`gallery-picker-${width}.png`), animations: "disabled" });
        await chooseImage(page, upload, ["gallery-product.png", "gallery-detail.png"]);
        await expect(dialog).not.toBeVisible();
        const tray = page.getByRole("region", { name: "参考图", exact: true });
        await expectGalleryReference(page, api, "gallery-product.png");
        await expectGalleryReference(page, api, "gallery-detail.png");
        await expect(tray.getByText("上传", { exact: true })).toHaveCount(2);
        await expect(workbenchPanes(page).first().locator('[aria-label="参考图"] img')).toHaveCount(0);
        const registry = await readWorkbenchRegistry(page);
        expect(registry[0].value.activeId).toBe(registry[0].value.tasks[1].id);
        await page.reload();
        await expect(workbenchPanes(page).first()).toBeHidden();
        await expect(tray.locator("img")).toHaveCount(2);
        await expectGalleryReference(page, api, "gallery-product.png");
        await expectGalleryReference(page, api, "gallery-detail.png");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`image-uploaded-${width}.png`), animations: "disabled" });
        expect(api.assets.size).toBe(2);
        expect([...api.assets.values()].every(asset => asset.metadata.source === "asset-picker-upload")).toBe(true);
        expect(api.submissions).toHaveLength(0);
    });

    test(`video gallery upload stays in its reference area at ${width}px`, async ({ page, context, api }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await context.route("**/api/models", route => route.fulfill({ json: { models: [videoModel], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: videoModel.id, configurationVersion: 1 })), prices: [] } }));
        await page.goto("/video");
        const upload = page.getByRole("button", { name: "上传图片 · 首帧 / 尾帧", exact: true });
        await expectReachable(upload);
        await chooseImage(page, upload, ["video-first-frame.png"]);
        await expectOriginal(page.getByRole("img", { name: "video-first-frame.png", exact: true }));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`video-uploaded-${width}.png`), animations: "disabled" });
        expect(api.submissions).toHaveLength(0);
    });

    test(`scene gallery uploads preserve product and model slots at ${width}px`, async ({ page, api }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/creative/virtual-try-on");
        const product = page.getByRole("region", { name: "产品图", exact: false });
        const model = page.getByRole("region", { name: "模特图", exact: false });
        await chooseImage(page, product.locator(".cs-upload-control"), ["gallery-product.png"]);
        await expectOriginal(product.getByRole("img", { name: "gallery-product.png", exact: true }));
        await model.getByRole("button", { name: "从素材库选择模特图", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
        await chooseImage(page, dialog.getByRole("button", { name: "从相册 / 本机上传", exact: true }), ["gallery-model.png"]);
        await expect(dialog).not.toBeVisible();
        await expectOriginal(model.getByRole("img", { name: "gallery-model.png", exact: true }));
        await expect(product.getByRole("img", { name: "gallery-product.png", exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`scene-uploaded-${width}.png`), animations: "disabled" });
        expect(api.submissions).toHaveLength(0);
    });
}

test("mobile canvas and short-screen discussion upload remain reachable", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const id = await newCanvas(page);
    await chooseImage(page, page.getByRole("button", { name: "上传素材", exact: true }), ["canvas-gallery.png"]);
    await expect.poll(() => api.document(id)?.nodes?.some((node: any) => node.title === "canvas-gallery.png")).toBe(true);
    await page.screenshot({ path: info.outputPath("canvas-320.png"), animations: "disabled" });
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "设计讨论面板" });
    const upload = panel.getByRole("button", { name: "上传参考图片", exact: true });
    await expect(upload).toBeEnabled();
    await expectReachable(upload);
    await chooseImage(page, upload, ["discussion-gallery.png"]);
    const reference = panel.locator(".studio-reference").filter({ has: page.getByRole("img", { name: "discussion-gallery.png", exact: true }) });
    await expect(reference.locator("img")).toHaveAttribute("data-loaded", "true");
    await reference.getByRole("button", { name: /^查看参考图\d+原图$/ }).click();
    const preview = page.getByRole("dialog");
    await expectOriginal(preview.locator("img"));
    await preview.getByRole("button").filter({ has: page.getByRole("img", { name: "close", exact: true }) }).click();
    await expect(preview).toHaveCount(0);
    await panel.locator(".discussion-settings > summary").click();
    await expectReachable(panel.getByRole("button", { name: "发送讨论", exact: true }));
    await expectReachable(panel.getByRole("textbox", { name: "输入设计需求" }));
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("discussion-320.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});

test("short mobile picker retains corrupt-image errors and accepts an explicit retry", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 390, height: 480 });
    await page.goto("/image?tool=image-edit");
    await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择素材", exact: true });
    const upload = dialog.getByRole("button", { name: "从相册 / 本机上传", exact: true });
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    await (await chooser).setFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    await expect(dialog.getByText("图片无法读取，文件可能已损坏或格式不受支持", { exact: true })).toBeVisible();
    await expect(page.getByText("已加入参考图", { exact: true })).not.toBeVisible();
    await expectReachable(upload);
    const confirm = dialog.getByRole("button", { name: /加入0.*张参考图/ });
    await expectReachable(confirm);
    const buttonBox = (await confirm.boundingBox())!;
    const dialogBox = (await dialog.boundingBox())!;
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("gallery-upload-error-short-screen.png"), animations: "disabled" });
    await chooseImage(page, upload, ["retry-gallery.png"]);
    await expect(dialog).not.toBeVisible();
    await expectGalleryReference(page, api, "retry-gallery.png");
    expect(api.submissions).toHaveLength(0);
});

test("home mobile menu and admin selector expose every section without horizontal clipping", async ({ page, context, api }, info) => {
    api.role = "super_admin";
    await context.route("**/api/auth/methods", route => route.fulfill({ json: { password: true, wecom: false, wecomLoginUrl: null } }));
    await context.route("**/api/admin/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/admin/accounts") return route.fulfill({ json: { users: [], totalUsedCredits: 0 } });
        if (path === "/api/admin/departments") return route.fulfill({ json: { departments: [] } });
        if (path === "/api/admin/audit-logs") return route.fulfill({ json: { auditLogs: [] } });
        if (path === "/api/admin/credit-policy") return route.fulfill({ json: { creditsEnabled: false, updatedAt: null } });
        if (path === "/api/admin/release-notes") return route.fulfill({ json: { notes: [], hasMore: false } });
        if (path === "/api/admin/history") return route.fulfill({ json: { history: [], total: 0, totalRmbCost: 0 } });
        return route.fallback();
    });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/");
    await page.getByRole("button", { name: "打开导航菜单" }).click();
    const drawer = page.getByRole("dialog", { name: "功能模块" });
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("home-navigation-320.png"), animations: "disabled" });
    await page.goto("/admin?tab=release-notes");
    const selector = page.getByRole("combobox", { name: "切换管理板块", exact: true });
    await expect(selector).toHaveValue("release-notes");
    await selector.scrollIntoViewIfNeeded();
    await expectReachable(selector);
    const navigation = page.getByRole("navigation", { name: "管理板块", exact: true });
    expect((await navigation.boundingBox())!.height).toBeLessThan(90);
    expect(await selector.locator("option").count()).toBeGreaterThanOrEqual(10);
    await selector.selectOption("audit");
    await expect(page).toHaveURL(/tab=audit/);
    await selector.selectOption("release-notes");
    await expect(page).toHaveURL(/tab=release-notes/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("admin-navigation-320.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(selector).not.toBeVisible();
    await expect(navigation.getByRole("link", { name: "版本更新", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("admin-navigation-desktop.png"), animations: "disabled" });
    expect(api.submissions).toHaveLength(0);
});
