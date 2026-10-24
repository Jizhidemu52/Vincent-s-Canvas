import { test, expect, type BrowserContext } from "@playwright/test";

const origin = "http://127.0.0.1:5347";
const adminId = "81000000-0000-4000-8000-000000000001";
const designerId = "81000000-0000-4000-8000-000000000002";

async function identify(context: BrowserContext, name: string) {
    await context.addCookies([{ name: "workspace-fixture", value: `fixture-${name}`, url: origin, httpOnly: true, sameSite: "Lax" }]);
}

test("超级管理员从后台进入个人创作，画布与本机工程刷新保留且不进入员工分区", async ({ page, context }, testInfo) => {
    const blocked: string[] = [], errors: string[] = [], generation: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.protocol === "http:" || url.protocol === "https:") {
            if (url.origin !== origin) { blocked.push(url.href); return route.abort(); }
            if (route.request().method() === "POST" && ["/api/tasks", "/api/chat/responses"].includes(url.pathname)) { generation.push(url.pathname); return route.abort(); }
        }
        return route.continue();
    });
    await identify(context, "admin");
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "管理中心", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "进入个人工作台", exact: true }).click();
    await expect(page).toHaveURL(origin + "/");
    await page.goto("/image");
    const imagePrompt = page.getByRole("textbox", { name: "图像提示词", exact: true });
    await imagePrompt.fill("超级管理员自己的图像草稿");
    await expect(imagePrompt).toHaveValue("超级管理员自己的图像草稿");
    await page.goto("/video");
    const videoPrompt = page.getByRole("textbox", { name: "视频提示词", exact: true });
    await videoPrompt.fill("超级管理员自己的视频草稿");
    await expect(videoPrompt).toHaveValue("超级管理员自己的视频草稿");
    const preflight = await context.request.post("/api/tasks/preflight", { headers: { "X-Canvas-Owner-Id": adminId }, data: {
        requestId: "browser-admin-preflight", projectId: "browser", operationType: "video_generation", modelConfigId: "82000000-0000-4000-8000-000000000001",
        prompt: "A quiet landscape", parameters: { videoMode: "text" }, sourceUrls: [],
    } });
    expect(preflight.status()).toBe(200); expect(await preflight.json()).toMatchObject({ ok: true });
    await page.goto("/canvas");
    await page.getByRole("button", { name: "新建画布", exact: true }).first().click();
    await expect(page).toHaveURL(/\/canvas\/[^/]+$/);
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByRole("button", { name: "文本", exact: true }).click();
    const readDocument = async () => (await (await context.request.get(`/api/canvas-documents/${id}`, { headers: { "X-Canvas-Owner-Id": adminId } })).json()).document;
    await expect.poll(async () => (await readDocument()).document?.nodes.length).toBe(1);
    const saved = await readDocument();
    await page.reload(); await expect(page.locator("[data-node-id]")).toHaveCount(1);
    expect((await readDocument()).document.nodes).toEqual(saved.document.nodes);
    const mismatch = await context.request.put(`/api/canvas-documents/${id}`, { headers: { "X-Canvas-Owner-Id": designerId }, data: { baseRevision: saved.revision, document: { ...saved.document, title: "must-not-write" } } });
    expect(mismatch.status()).toBe(403);
    expect((await readDocument()).document.title).toBe(saved.document.title);
    await page.goto("/creative/pattern-placement");
    await expect(page.getByRole("button", { name: "新建工程", exact: true })).toBeVisible();
    page.once("dialog", dialog => dialog.accept("超级管理员个人工程"));
    await page.getByRole("button", { name: "新建工程", exact: true }).click();
    const project = page.getByRole("combobox", { name: "本地工程", exact: true });
    await expect(project.locator("option:checked")).toHaveText("超级管理员个人工程");
    await expect(page.locator("[data-project-status]")).toHaveText("已自动保存到本机");
    await page.reload(); await expect(project.locator("option:checked")).toHaveText("超级管理员个人工程");
    await page.screenshot({ path: testInfo.outputPath("super-admin-personal-workbench.png") });
    await page.goto("/assets");
    await page.getByRole("button", { name: "新增素材", exact: true }).click();
    const assetDialog = page.getByRole("dialog", { name: "新增素材", exact: true });
    await assetDialog.getByRole("textbox", { name: "标题", exact: true }).fill("超级管理员个人文本素材");
    await assetDialog.getByRole("textbox", { name: "文本内容", exact: true }).fill("归属于管理员自己，不映射员工");
    await assetDialog.getByRole("button", { name: /^保\s*存$/ }).click();
    await expect(assetDialog).toBeHidden();
    await page.reload(); await expect(page.getByText("超级管理员个人文本素材", { exact: true })).toBeVisible();
    const personalAssets = await context.request.get(`/api/assets?ownerUserId=${adminId}`, { headers: { "X-Canvas-Owner-Id": adminId } });
    const assetRows = (await personalAssets.json()).assets;
    expect(assetRows).toHaveLength(1); expect(assetRows[0].ownerUserId).toBe(adminId);
    await identify(context, "designer");
    await page.goto("/image"); await expect(imagePrompt).toHaveValue("");
    await page.goto("/canvas");
    const designerDocs = await context.request.get("/api/canvas-documents", { headers: { "X-Canvas-Owner-Id": designerId } });
    expect(designerDocs.status()).toBe(200); expect((await designerDocs.json()).documents).toEqual([]);
    await page.goto("/assets"); await expect(page.getByRole("heading", { name: "我的素材", exact: true })).toBeVisible();
    await expect(page.getByText("超级管理员个人文本素材", { exact: true })).toHaveCount(0);
    await identify(context, "admin"); await page.goto(`/canvas/${id}`); await expect(page.locator("[data-node-id]")).toHaveCount(1);
    expect(generation).toEqual([]); expect(blocked).toEqual([]); expect(errors).toEqual([]);
});
