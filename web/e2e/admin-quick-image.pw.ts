import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import type { AdminQuickImageConfiguration, QuickImageConfigurationTest, QuickImageConfigurationUpdate } from "../../shared/quick-image-configuration";
import type { QueuedTask } from "../src/services/api/generation-tasks";
import { IMAGE, MockCanvasApi } from "./fixtures";

const owner = "00000000-0000-4000-8000-000000000099";
const root = "/api/admin/model-configuration/quick-images";
const modelA = { id: "10000000-0000-4000-8000-000000000001", name: "处理模型 A", modelId: "fixture-edit-a", providerName: "隔离 API", protocol: "apimart", capabilities: ["edit"] };
const modelB = { ...modelA, id: "10000000-0000-4000-8000-000000000002", name: "处理模型 B", modelId: "fixture-edit-b" };
const removeTitle = "一键去背景", hdTitle = "高清放大";
// AntD's loading icon contributes its accessible name until the leave animation ends.
const paidTestName = /^(?:loading )?试运行 1 张$/;

async function setup(page: Page) {
    const api = new MockCanvasApi(test.info().project.use.baseURL);
    api.role = "super_admin";
    await api.attach(page.context());
    const configurations: AdminQuickImageConfiguration[] = [
        { action: "remove-background", modelConfigId: modelA.id, modelId: modelA.modelId, modelName: modelA.name, prompt: "PRIVATE saved subject extraction", parameters: { quality: "high" }, configurationVersion: 7, isDefault: false },
        { action: "hd-upscale", modelConfigId: modelA.id, modelId: modelA.modelId, modelName: modelA.name, prompt: "PRIVATE saved upscale", parameters: { resolution: "2K" }, configurationVersion: 4, isDefault: false },
        { action: "item-extract", modelConfigId: modelA.id, modelId: modelA.modelId, modelName: modelA.name, prompt: "PRIVATE product flat lay extraction", parameters: { resolution: "2k", quality: "medium" }, configurationVersion: 0, isDefault: true },
    ];
    const requests: string[] = [];
    const saves: Array<{ action: string; input: QuickImageConfigurationUpdate }> = [];
    const tests: Array<{ action: string; input: QuickImageConfigurationTest }> = [];
    const uploads: Record<string, unknown>[] = [], uploadBytes: Buffer[] = [];
    const tasks = new Map<string, QueuedTask>();
    const recoveries: string[] = [];
    const held: Array<{ route: Route; task: QueuedTask }> = [];
    const flags = { abortTest: false, holdTest: false, query: "task" as "task" | "missing" | "network", taskStatus: "success", upstreamTaskId: null as string | null };
    await page.context().route("**/api/**", async route => {
        const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
        requests.push(`${method} ${path}`);
        const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false, wecomLoginUrl: null });
        if (path === "/api/assets/upload-request") {
            uploads.push(request.postDataJSON());
            return json({ assetId: randomUUID(), uploadUrl: "/api/quick-fixture-upload" });
        }
        if (path === "/api/quick-fixture-upload" && method === "PUT") {
            uploadBytes.push(request.postDataBuffer()!);
            return route.fulfill({ status: 204 });
        }
        if (path.startsWith("/api/tasks/by-request/")) {
            if (flags.query === "network") return route.abort("connectionclosed");
            const task = flags.query === "missing" ? undefined : tasks.get(path.split("/").at(-1)!);
            return task ? json({ task }) : json({ message: "not found" }, 404);
        }
        if (/^\/api\/tasks\/[^/]+\/recover$/.test(path) && method === "POST") {
            const id = path.split("/")[3];
            recoveries.push(id);
            const task = [...tasks.values()].find(item => item.id === id)!;
            task.status = "success"; task.resultUrls = ["/api/assets/fixture-output/content"];
            return json({ task });
        }
        if (!path.startsWith("/api/admin/")) return route.fallback();
        if (path === root && method === "GET") return json({ configurations, models: [modelA, modelB] });
        if (path.startsWith(`${root}/`) && method === "PUT") {
            const action = path.split("/").at(-1)!, input = request.postDataJSON() as QuickImageConfigurationUpdate;
            saves.push({ action, input });
            const configuration = configurations.find(item => item.action === action)!;
            if (input.expectedVersion !== configuration.configurationVersion) return json({ error: "QUICK_IMAGE_CONFIGURATION_CONFLICT", message: "配置已被更新" }, 409);
            const model = [modelA, modelB].find(item => item.id === input.modelConfigId)!;
            Object.assign(configuration, input, { modelId: model.modelId, modelName: model.name, configurationVersion: configuration.configurationVersion + 1, isDefault: false });
            return json({ configuration });
        }
        if (path.startsWith(`${root}/`) && path.endsWith("/test") && method === "POST") {
            const input = request.postDataJSON() as QuickImageConfigurationTest;
            tests.push({ action: path.split("/").at(-2)!, input });
            const task = { id: randomUUID(), requestId: input.requestId, status: flags.taskStatus, upstreamTaskId: flags.upstreamTaskId, resultUrls: flags.taskStatus === "success" ? ["/api/assets/fixture-output/content"] : [], failureReason: null } as QueuedTask;
            tasks.set(input.requestId, task);
            if (flags.abortTest) return route.abort("connectionclosed");
            if (flags.holdTest) { held.push({ route, task }); return; }
            return json({ task }, 201);
        }
        if (path === "/api/admin/accounts") return json({ users: [], totalUsedCredits: 0 });
        if (path === "/api/admin/departments") return json({ departments: [] });
        if (path === "/api/admin/audit-logs") return json({ auditLogs: [] });
        if (path === "/api/admin/history") return json({ history: [], total: 0, totalRmbCost: 0, nextCursor: null });
        if (path.endsWith("/providers")) return json({ providers: [] });
        if (path.endsWith("/models")) return json({ models: [] });
        if (path.endsWith("/workflows")) return json({ workflows: [] });
        if (path.endsWith("/tool-configurations")) return json({ tools: [] });
        api.unexpected.push(`${method} ${path}`);
        return json({ message: "Unmocked admin fixture request" }, 501);
    });
    return { api, configurations, requests, saves, tests, uploads, uploadBytes, tasks, recoveries, flags,
        async release() { for (const item of held.splice(0)) await item.route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ task: item.task }) }); },
    };
}

async function openPanel(page: Page) {
    await page.goto("/admin?tab=api");
    await page.getByRole("tab", { name: "快捷图片处理", exact: true }).click();
    await expect(page.getByRole("region", { name: `${removeTitle}配置`, exact: true })).toBeVisible();
}
const region = (page: Page, title = removeTitle) => page.getByRole("region", { name: `${title}配置`, exact: true });
async function upload(page: Page, title = removeTitle) {
    await region(page, title).getByLabel(`${title}测试原图`, { exact: true }).setInputFiles({ name: "own-source.png", mimeType: "image/png", buffer: IMAGE });
}
function clean(f: Awaited<ReturnType<typeof setup>>) {
    expect(f.api.blocked).toEqual([]); expect(f.api.unexpected).toEqual([]); expect(f.api.pageErrors).toEqual([]);
}

test("save changes one action with expectedVersion; validates JSON and protects drafts on desktop and narrow view", async ({ page }, info) => {
    const f = await setup(page);
    await openPanel(page);
    const panel = region(page), other = { ...f.configurations[1] };
    const prompt = "保留毛衫主体颜色与针织细节，直接输出全彩透明 PNG，不含底色或棋盘格。";
    await expect(panel.getByText(/模型直接生成全彩透明 PNG，原图与结果分别保留/)).toBeVisible();
    await expect(panel.getByText(/不保证逐像素一致/)).toBeVisible();
    await expect(panel.getByText(/要求直接输出全彩透明 PNG/)).toBeVisible();
    await expect(panel.getByText(/透明蒙版与原图 RGB 合成|透明结果由系统用原图合成|不要要求直接输出透明/)).toHaveCount(0);
    await panel.getByRole("combobox", { name: `${removeTitle}处理模型` }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("处理模型 B · 隔离 API · fixture-edit-b", { exact: true }).click();
    await panel.getByRole("textbox", { name: `${removeTitle}处理提示词` }).fill(prompt);
    await panel.locator("summary").click();
    await expect(panel.getByText(/服务端固定 background=transparent、output_format=png/)).toBeVisible();
    await panel.getByRole("textbox", { name: `${removeTitle}高级参数 JSON` }).fill("[]");
    await panel.getByRole("button", { name: `保存${removeTitle}配置` }).click();
    await expect(panel.getByText("高级参数必须是 JSON 对象，不能是数组或空值。", { exact: true })).toBeVisible();
    expect(f.saves).toHaveLength(0);
    await panel.getByRole("textbox", { name: `${removeTitle}高级参数 JSON` }).fill('{"quality":"high","resolution":"2K"}');
    await page.getByRole("tab", { name: "工作流（高级）" }).click();
    await expect(page.getByRole("dialog")).toContainText("配置尚未保存");
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await panel.getByRole("button", { name: `保存${removeTitle}配置` }).click();
    await expect(panel.getByText(/已保存，仅影响此操作之后的新请求/)).toBeVisible();
    expect(f.saves).toEqual([{ action: "remove-background", input: { modelConfigId: modelB.id, prompt, parameters: { quality: "high", resolution: "2K" }, expectedVersion: 7 } }]);
    expect(f.configurations[1]).toEqual(other);
    expect(f.tests).toHaveLength(0); expect(f.uploads).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("admin-quick-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByRole("textbox", { name: `${removeTitle}处理提示词` })).toHaveValue(prompt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await panel.getByRole("textbox", { name: `${removeTitle}处理提示词` }).scrollIntoViewIfNeeded();
    const promptCounter = await panel.locator(".ant-input-data-count").boundingBox();
    const promptHint = await panel.getByText(/要求直接输出全彩透明 PNG/).boundingBox();
    expect(promptCounter).not.toBeNull(); expect(promptHint).not.toBeNull();
    expect(promptCounter!.y + promptCounter!.height).toBeLessThanOrEqual(promptHint!.y);
    await page.screenshot({ path: info.outputPath("admin-quick-mobile.png"), fullPage: true });
    await panel.getByRole("button", { name: paidTestName }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("admin-quick-mobile-test-controls.png"), fullPage: true });
    clean(f);
});

test("product extraction has independent admin model, prompt and parameters while saving never starts a paid task", async ({ page }, info) => {
    const f = await setup(page);
    await openPanel(page);
    const title = "提取产品图", panel = region(page, title);
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/AI 重构而非透明抠图/)).toBeVisible();
    const others = structuredClone(f.configurations.slice(0, 2));
    await panel.getByRole("combobox", { name: `${title}处理模型`, exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("处理模型 B · 隔离 API · fixture-edit-b", { exact: true }).click();
    await panel.getByRole("textbox", { name: `${title}处理提示词`, exact: true }).fill("提取主要产品，白底平放，只补足必要遮挡，不臆造隐藏结构");
    await panel.locator("summary").click();
    await panel.getByRole("textbox", { name: `${title}高级参数 JSON`, exact: true }).fill('{"resolution":"2k","quality":"medium"}');
    await panel.getByRole("button", { name: `保存${title}配置`, exact: true }).click();
    await expect(panel.getByText(/已保存，仅影响此操作之后的新请求/)).toBeVisible();
    expect(f.saves).toEqual([{ action: "item-extract", input: { modelConfigId: modelB.id, prompt: "提取主要产品，白底平放，只补足必要遮挡，不臆造隐藏结构", parameters: { resolution: "2k", quality: "medium" }, expectedVersion: 0 } }]);
    expect(f.configurations.slice(0, 2)).toEqual(others);
    expect(f.tests).toHaveLength(0); expect(f.uploads).toHaveLength(0);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("admin-product-extract-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("admin-product-extract-mobile.png"), fullPage: true });
    clean(f);
});

test("unsaved draft test sends one snapshot and one original upload; double-click cannot create another paid POST", async ({ page }) => {
    const f = await setup(page);
    f.flags.holdTest = true;
    await openPanel(page);
    const panel = region(page), saved = structuredClone(f.configurations);
    await panel.getByRole("textbox", { name: `${removeTitle}处理提示词` }).fill("PRIVATE unsaved subject only");
    await upload(page);
    await panel.getByRole("button", { name: paidTestName }).dblclick();
    await expect.poll(() => f.tests.length).toBe(1);
    await expect(panel.getByRole("button", { name: paidTestName })).toBeDisabled();
    expect(f.saves).toHaveLength(0); expect(f.uploads).toHaveLength(1); expect(f.uploadBytes).toEqual([IMAGE]);
    expect(f.tests[0]).toMatchObject({ action: "remove-background", input: { configuration: { modelConfigId: modelA.id, prompt: "PRIVATE unsaved subject only", parameters: { quality: "high" } } } });
    expect(f.tests[0].input.sourceUrl).toMatch(/^\/api\/assets\/[a-f0-9-]+\/content$/);
    expect(f.configurations).toEqual(saved);
    const receipts = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("canvas:admin-quick-image-test:")));
    expect(receipts).toEqual([[`canvas:admin-quick-image-test:${owner}:remove-background`, f.tests[0].input.requestId]]);
    await f.release();
    await expect(panel.getByRole("img", { name: `${removeTitle}测试结果 1`, exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: paidTestName })).toBeEnabled();
    expect(f.tests).toHaveLength(1); clean(f);
});

test("uncertain POST, missing or failed queries and refresh retain the original receipt without another submission", async ({ page }) => {
    const f = await setup(page);
    f.flags.abortTest = true; f.flags.query = "missing";
    await openPanel(page); await upload(page);
    const panel = region(page);
    await panel.getByRole("button", { name: paidTestName }).click();
    await expect(panel.getByText(/网络连接中断/)).toBeVisible();
    const requestId = f.tests[0].input.requestId;
    await expect(panel.getByRole("button", { name: paidTestName })).toBeDisabled();
    await panel.getByRole("button", { name: /查询原测试任务$/ }).click();
    await expect(panel.getByText(/尚未查到原任务，不代表未提交/)).toBeVisible();
    f.flags.query = "network";
    await panel.getByRole("button", { name: /查询原测试任务$/ }).click();
    await expect(panel.getByText(/网络连接中断/)).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "快捷图片处理", exact: true }).click();
    await expect(region(page).getByText(/发现原测试请求/)).toBeVisible();
    await upload(page);
    await expect(region(page).getByRole("button", { name: paidTestName })).toBeDisabled();
    f.flags.query = "task";
    await region(page).getByRole("button", { name: /查询原测试任务$/ }).click();
    await expect(region(page).getByRole("img", { name: `${removeTitle}测试结果 1`, exact: true })).toBeVisible();
    await expect(region(page).getByRole("button", { name: paidTestName })).toBeEnabled();
    expect(f.tests).toHaveLength(1); expect(f.saves).toHaveLength(0); expect(f.uploads).toHaveLength(1);
    expect(f.requests.filter(value => value.startsWith("GET /api/tasks/by-request/"))).toEqual(Array(3).fill(`GET /api/tasks/by-request/${requestId}`));
    expect(f.recoveries).toEqual([]); clean(f);
});

for (const known of [true, false]) test(`${known ? "known-upstream" : "unknown-submission"} paused task uses only its permitted recovery path`, async ({ page }) => {
    const f = await setup(page);
    f.flags.taskStatus = "paused"; f.flags.upstreamTaskId = known ? "fixture-upstream-id" : null;
    await openPanel(page); await upload(page);
    const panel = region(page);
    await panel.getByRole("button", { name: paidTestName }).click();
    await expect(panel.getByText("等待恢复查询", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: paidTestName })).toBeDisabled();
    if (known) {
        await panel.getByRole("button", { name: "恢复原任务查询", exact: true }).click();
        await expect(panel.getByRole("img", { name: `${removeTitle}测试结果 1`, exact: true })).toBeVisible();
        expect(f.recoveries).toEqual([[...f.tasks.values()][0].id]);
    } else {
        await expect(panel.getByRole("button", { name: "恢复原任务查询", exact: true })).toHaveCount(0);
        await expect(panel.getByText(/提交结果待核查，暂无法恢复上游查询/)).toBeVisible();
        await panel.getByRole("button", { name: /查询原测试任务$/ }).click();
        expect(f.recoveries).toEqual([]);
    }
    expect(f.tests).toHaveLength(1); expect(f.saves).toHaveLength(0); clean(f);
});

test("local waiting can stop without cancelling the service task or permitting a duplicate", async ({ page }) => {
    const f = await setup(page);
    f.flags.taskStatus = "processing";
    await openPanel(page); await upload(page);
    const panel = region(page);
    await panel.getByRole("button", { name: paidTestName }).click();
    await expect(panel.getByText("处理中", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "停止本地等待", exact: true }).click();
    await expect(panel.getByText(/本地查询已停止，服务端任务未取消/)).toBeVisible();
    await expect(panel.getByRole("button", { name: paidTestName })).toBeDisabled();
    const original = [...f.tasks.values()][0];
    expect(original.status).toBe("processing");
    original.status = "success"; original.resultUrls = ["/api/assets/fixture-output/content"];
    await panel.getByRole("button", { name: /查询原测试任务$/ }).click();
    await expect(panel.getByRole("img", { name: `${removeTitle}测试结果 1`, exact: true })).toBeVisible();
    expect(f.tests).toHaveLength(1); expect(f.requests.filter(value => /\/cancel$/.test(value))).toEqual([]); clean(f);
});

test("unavailable saved model is explicit and cannot silently fallback or submit", async ({ page }) => {
    const f = await setup(page);
    f.configurations[1] = { ...f.configurations[1], modelConfigId: "missing-saved-id", modelName: "停用旧模型" };
    await openPanel(page);
    const panel = region(page, hdTitle);
    await expect(panel.getByText("当前模型未配置、已停用或不可用", { exact: true })).toBeVisible();
    await expect(panel.getByText("停用旧模型（不可用）", { exact: true })).toBeVisible();
    await upload(page, hdTitle);
    await expect(panel.getByRole("button", { name: paidTestName })).toBeDisabled();
    await expect(panel.getByRole("button", { name: `保存${hdTitle}配置` })).toBeDisabled();
    expect(f.tests).toHaveLength(0); expect(f.saves).toHaveLength(0); expect(f.uploads).toHaveLength(0); clean(f);
});

test("ordinary designers cannot open the administrative quick configuration or fetch its private catalog", async ({ page }) => {
    const f = await setup(page);
    f.api.role = "designer";
    await page.goto("/admin?tab=api");
    await expect(page.getByRole("heading", { name: "进入后台管理", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "快捷图片处理配置", exact: true })).toHaveCount(0);
    expect(f.requests.filter(value => value.includes("/quick-images"))).toEqual([]);
    expect(f.tests).toHaveLength(0); expect(f.saves).toHaveLength(0); clean(f);
});
