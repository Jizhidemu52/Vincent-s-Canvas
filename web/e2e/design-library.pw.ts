import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog";
import { IMAGE } from "./fixtures";

const owner = "71000000-0000-4000-8000-000000000001";
const ownAsset = "74000000-0000-4000-8000-000000000001";
const model = { id: "10000000-0000-4000-8000-000000000001", name: "隔离验证模型", modelId: "gpt-image-2", providerName: "Isolated fixture", protocol: "openai", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const asset = (id: string, title: string) => ({ id, ownerUserId: owner, ownerName: "设计员工", departmentId: "design", departmentName: "设计部", projectId: null, projectName: null, taskId: null,
    filename: `${title}.png`, mimeType: "image/png", byteSize: IMAGE.length, kind: "image", source: "upload", status: "ready", visibilityScope: "private", metadata: { title, tags: ["面料"], note: "只分享这张图", model: model.name },
    prompt: "这张原图的完整提示词", modelName: model.name, operationType: "image_generation", createdAt: "2026-10-01T00:00:00Z", contentUrl: `/api/assets/${id}/content`, thumbnailUrl: `/api/assets/${id}/thumb?w=256`, previewUrl: `/api/assets/${id}/thumb?w=1024`,
    resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0 });
const entry = (id: string, title: string, thumbnail = true) => ({ id, title, thought: "设计思路", prompt: "已公开提示词", tags: ["面料"], author: { id: owner, name: "设计员工", departmentId: "design", departmentName: "设计部" },
    status: "published", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", canWithdraw: true, canModerate: false, canViewStats: false,
    images: [{ id: "image-1", filename: `${title}.png`, mimeType: "image/png", byteSize: IMAGE.length, width: 256, height: 256,
        contentUrl: `/api/design-library/${id}/images/image-1/content`, ...(thumbnail ? { thumbnailUrl: `/api/design-library/${id}/images/image-1/thumbnail` } : {}) }] });

async function fixture(context: BrowserContext, baseURL: string, oa = true) {
    const assets = new Map([[ownAsset, asset(ownAsset, "本人私有设计")]]);
    const entries = [entry("good", "正常缩略图"), entry("broken", "回退原图"), entry("legacy", "旧版原图", false)];
    const requests: string[] = [], publications: any[] = [], submissions: any[] = [], unexpected: string[] = [], errors: string[] = [], uploads: any[] = [];
    const tasks = new Map<string, any>();
    const events: any[] = [];
    let rejectSource = false;
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", error => errors.push(error.message));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
        if (url.origin !== baseURL) { unexpected.push(request.url()); return route.abort(); }
        if (!path.startsWith("/api/")) return route.continue();
        requests.push(`${method} ${path}`);
        const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        const ok = (data: unknown) => json({ code: 0, data });
        if (path === "/api/deployment") return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: oa });
        if (path === "/api/auth/session") return json({ user: { id: owner, displayName: "设计员工", username: "library-e2e", role: "designer", departmentId: "design", status: "active", mustChangePassword: false } });
        if (path === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
        if (path === "/api/models") return json({ models: [model], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })) });
        if (path === "/api/canvas-documents") return json({ documents: [] });
        if (path === "/api/projects") return json({ projects: [] });
        if (path === "/api/projects/sync") return json({ project: { id: request.postDataJSON().externalId, ...request.postDataJSON(), status: "active" } });
        if (path.startsWith("/api/usage") || path.startsWith("/api/generation-history")) return json({ code: 0, data: [], history: [], total: 0 });
        if (path === "/api/assets" || path === "/api/assets/summary") return json({ assets: [...assets.values()], nextCursor: null, hasMore: false });
        if (/^\/api\/assets\/[^/]+\/(content|thumb)$/.test(path)) return route.fulfill({ contentType: "image/png", body: IMAGE });
        if (/^\/api\/assets\/[^/]+$/.test(path)) {
            const current = assets.get(path.split("/")[3]);
            return json({ asset: rejectSource && current ? { ...current, ownerUserId: "someone-else" } : current });
        }
        if (path === "/api/assets/upload-request") {
            const input = request.postDataJSON(), id = randomUUID(); uploads.push(input);
            assets.set(id, { ...asset(id, input.filename), ...input }); return json({ assetId: id, uploadUrl: null });
        }
        if (path === "/api/tasks" && method === "POST") {
            const input = request.postDataJSON(), id = randomUUID(); submissions.push(input);
            const task = { ...input, id, userId: owner, status: "success", resultUrls: [`/api/assets/${id}/content`], failureReason: null, createdAt: new Date().toISOString() };
            tasks.set(id, task); assets.set(id, { ...asset(id, "模拟生成原图"), prompt: input.prompt }); return json({ task }, 201);
        }
        if (path === "/api/tasks") return json({ tasks: [...tasks.values()], nextCursor: null });
        if (path === "/api/tasks/events") return json({ error: "FIXTURE_STREAM_DISABLED" }, 404);
        if (/^\/api\/tasks\/[^/]+$/.test(path)) return json({ task: tasks.get(path.split("/")[3]) });
        if (/^\/api\/tasks\/[^/]+\/progress$/.test(path)) return json({ progress: { status: "success", phase: "complete", runtime: "worker" } });
        if (path === "/api/design-library") {
            if (method === "POST") {
                const input = request.postDataJSON(); publications.push(input);
                const created = { ...entry("new-share", input.title), ...input }; entries.push(created); return ok({ entry: created });
            }
            return ok({ items: entries, total: entries.length, page: 1, pageSize: 24 });
        }
        const library = path.match(/^\/api\/design-library\/([^/]+)(.*)$/);
        if (library) {
            const current = entries.find(item => item.id === library[1]);
            if (!current) return json({ msg: "not found" }, 404);
            if (!library[2]) return ok({ entry: current });
            if (library[2] === "/events") { events.push(request.postDataJSON()); return ok({ recorded: true }); }
            if (library[2] === "/withdraw") { current.status = "withdrawn"; current.canWithdraw = false; return ok({ entry: current }); }
            if (library[2].endsWith("/thumbnail") && current.id === "broken") return json({ msg: "缩略图暂不可用" }, 503);
            if (/\/(thumbnail|content|download)$/.test(library[2])) return route.fulfill({ contentType: "image/png", body: IMAGE });
        }
        unexpected.push(`${method} ${path}`); return json({ message: "Unmocked test request" }, 501);
    });
    return { requests, publications, submissions, uploads, assets, events, unexpected, errors, rejectSource: () => { rejectSource = true; } };
}
const publishDialog = (page: Page) => page.getByRole("dialog", { name: "发布到公司设计灵感库" });
const checkbox = (page: Page) => publishDialog(page).getByRole("checkbox", { name: "我已核对公开内容，并确认有权分享这些内容" });

test("library loads thumbnails first, falls back to original once, and detail/download/withdraw keep original behavior", async ({ page, context, baseURL }, info) => {
    const f = await fixture(context, baseURL!); await page.goto("/design-library");
    await expect(page.getByRole("img", { name: "正常缩略图", exact: true })).toHaveAttribute("src", /\/thumbnail$/);
    await expect(page.getByRole("img", { name: "回退原图", exact: true })).toHaveAttribute("src", /\/content$/);
    await expect(page.getByRole("img", { name: "旧版原图", exact: true })).toHaveAttribute("src", /\/content$/);
    await expect.poll(() => f.requests.filter(value => value === "GET /api/design-library/broken/images/image-1/content").length).toBe(1);
    expect(f.requests).not.toContain("GET /api/design-library/good/images/image-1/content");
    await page.screenshot({ path: info.outputPath("library-thumbnails.png"), fullPage: true });
    await page.getByRole("button", { name: "查看作品：正常缩略图", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "正常缩略图", exact: true });
    await expect(detail.getByRole("img", { name: "正常缩略图.png", exact: true })).toHaveAttribute("src", "/api/design-library/good/images/image-1/content");
    const download = page.waitForEvent("download"); await detail.getByRole("button", { name: "下载原图" }).click();
    const file = await download; expect(file.suggestedFilename()).toBe("正常缩略图.png");
    expect(await readFile((await file.path())!)).toEqual(IMAGE);
    await expect.poll(() => f.events.some(event => event.action === "download")).toBe(true);
    await detail.getByRole("button", { name: "撤回分享" }).click(); await page.getByRole("button", { name: "确认撤回" }).click();
    await expect(detail.getByRole("button", { name: "下载原图" })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "放到我的画布" })).toBeDisabled();
    expect(f.publications).toEqual([]); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test("owned asset opens a prefilled, unacknowledged draft; cancel stays private and publish is explicit", async ({ page, context, baseURL }, info) => {
    const f = await fixture(context, baseURL!); await page.goto("/assets");
    await page.getByText("本人私有设计", { exact: true }).first().click();
    await page.getByRole("button", { name: "分享到灵感库" }).click();
    await expect(publishDialog(page)).toBeVisible();
    await expect(publishDialog(page).getByRole("textbox", { name: "作品标题" })).toHaveValue("本人私有设计");
    await expect(publishDialog(page).getByRole("textbox", { name: "生图提示词" })).toHaveValue("这张原图的完整提示词");
    await expect(publishDialog(page).getByText("分享图片 · 1/12")).toBeVisible(); await expect(checkbox(page)).not.toBeChecked();
    await expect(publishDialog(page).getByRole("button", { name: "确认公开并发布" })).toBeDisabled();
    expect(f.publications).toEqual([]); expect(f.uploads).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await checkbox(page).scrollIntoViewIfNeeded(); await expect(checkbox(page)).toBeVisible();
    await expect(publishDialog(page).getByRole("button", { name: "确认公开并发布" })).toBeVisible();
    await expect(page.locator(".ant-modal")).not.toHaveClass(/ant-zoom-.*active/);
    expect(await publishDialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("share-draft-390.png"), fullPage: true });
    await publishDialog(page).getByRole("button", { name: /^取\s*消$/ }).click(); await page.getByRole("button", { name: "放弃草稿" }).click();
    await expect(publishDialog(page)).not.toBeVisible(); expect(f.publications).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto("/assets");
    await page.getByText("本人私有设计", { exact: true }).first().click(); await page.getByRole("button", { name: "分享到灵感库" }).click();
    await expect(checkbox(page)).not.toBeChecked(); await checkbox(page).check();
    await publishDialog(page).getByRole("button", { name: "确认公开并发布" }).click();
    await expect.poll(() => f.publications.length).toBe(1);
    expect(f.publications[0]).toMatchObject({ title: "本人私有设计", prompt: "这张原图的完整提示词", tags: ["面料"], assetIds: [ownAsset] });
    expect(f.publications[0]).not.toHaveProperty("model"); expect(f.assets.get(ownAsset)?.visibilityScope).toBe("private");
    expect(f.requests.some(value => /\/(visibility|share)$/.test(value))).toBe(false);
    expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test("a generated result shares its original task prompt and reuses its private server image without another task", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!); await page.goto("/image");
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("已生成图片的提示词");
    await page.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(page.getByRole("button", { name: "分享到灵感库", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "图像提示词", exact: true }).fill("尚未生成的新草稿，不能被带入");
    await page.getByRole("button", { name: "分享到灵感库", exact: true }).click();
    await expect(publishDialog(page)).toBeVisible();
    await expect(publishDialog(page).getByRole("textbox", { name: "生图提示词" })).toHaveValue("已生成图片的提示词");
    await expect(checkbox(page)).not.toBeChecked(); expect(f.submissions).toHaveLength(1); expect(f.publications).toEqual([]); expect(f.uploads).toEqual([]);
    expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test("an asset whose owner changed is rejected before a share draft is opened", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!); await page.goto("/assets");
    await page.getByText("本人私有设计", { exact: true }).first().click();
    await expect(page.getByRole("button", { name: "分享到灵感库" })).toBeVisible(); f.rejectSource();
    await page.getByRole("button", { name: "分享到灵感库" }).click();
    await expect(page.getByText("只能分享本人仍可访问的图片素材", { exact: true })).toBeVisible();
    await expect(publishDialog(page)).not.toBeVisible(); expect(f.publications).toEqual([]); expect(f.uploads).toEqual([]);
    expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test("personal deployments retain asset actions but do not expose company library sharing", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!, false); await page.goto("/assets");
    await page.getByText("本人私有设计", { exact: true }).first().click();
    await expect(page.getByRole("button", { name: "下载图片" })).toBeVisible(); await expect(page.getByRole("button", { name: "分享到灵感库" })).toHaveCount(0);
    expect(f.publications).toEqual([]); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});
