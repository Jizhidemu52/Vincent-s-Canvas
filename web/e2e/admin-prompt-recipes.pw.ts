import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog";
import { IMAGE } from "./fixtures";

const owner = "71000000-0000-4000-8000-000000000001";
const imageId = "10000000-0000-4000-8000-000000000001",
    otherImageId = "10000000-0000-4000-8000-000000000002",
    chatId = "10000000-0000-4000-8000-000000000003",
    otherChatId = "10000000-0000-4000-8000-000000000004";
const models = [
    { id: imageId, name: "图像模型 A", modelId: "fixture-image-a", capabilities: ["edit", "generate"], creditCost: 0, rmbCost: 0 },
    { id: otherImageId, name: "图像模型 B", modelId: "fixture-image-b", capabilities: ["edit", "generate"], creditCost: 0, rmbCost: 0 },
    { id: chatId, name: "配方优化模型", modelId: "fixture-chat-a", capabilities: ["chat"] },
    { id: otherChatId, name: "独立模型 B", modelId: "fixture-chat-b", capabilities: ["chat"] },
];
async function fixture(context: BrowserContext, baseURL: string, role = "super_admin") {
    const versions = [
        {
            id: randomUUID(),
            recipeKey: "free-optimize",
            version: 1,
            systemPrompt: "PRIVATE RECIPE RULE - fixture only",
            fieldTemplate: "{{fields}}",
            modelOverrides: { "fixture-image-a": "preserve seams" },
            fallbackPrompt: "",
            outputLanguage: "en",
            changeNote: "seed",
            contentHash: "fixture-hash-1",
            createdBy: owner,
            createdAt: "2026-10-01T00:00:00Z",
        },
    ];
    const recipe = { key: "free-optimize", name: "自由优化", enabled: true, modelConfigId: chatId, failurePolicy: "stop", currentVersionId: versions[0].id, updatedAt: "2026-10-01T00:00:00Z" };
    const records = new Map<string, any>(),
        tasks = new Map<string, any>();
    const requests: string[] = [],
        tests: any[] = [],
        submissions: any[] = [],
        activations: string[] = [],
        settings: any[] = [],
        uploads: any[] = [],
        uploadBytes: Buffer[] = [],
        errors: string[] = [],
        unexpected: string[] = [];
    const flags = { abortTest: false, abortImage: false, role };
    const user = () => ({ id: owner, username: "prompt-admin-fixture", displayName: "隔离验证管理员", role: flags.role, status: "active", mustChangePassword: false, avatarUrl: "" });
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", (error) => errors.push(error.message));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const request = route.request(),
            url = new URL(request.url()),
            path = url.pathname,
            method = request.method();
        if (url.origin !== baseURL) {
            unexpected.push(request.url());
            return route.abort();
        }
        if (!path.startsWith("/api/")) return route.continue();
        requests.push(`${method} ${path}`);
        const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (path === "/api/deployment") return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: true, oaLoginEnabled: false });
        if (path === "/api/auth/session") return json({ user: user() });
        if (path === "/api/auth/methods") return json({ password: true, wecom: false, wecomLoginUrl: null });
        if (path === "/api/modules") return json({ modules: moduleDefinitions.map((item) => ({ moduleKey: item.moduleKey, enabled: true })) });
        if (path === "/api/models") return json({ models, prices: [], tools: toolDefinitions.map((tool) => ({ ...tool, enabled: true, modelConfigId: imageId, configurationVersion: 1 })) });
        if (path === "/api/canvas-documents") return json({ documents: [] });
        if (path === "/api/projects") return json({ projects: [] });
        if (path.startsWith("/api/usage")) return json({ code: 0, data: [], history: [], total: 0 });
        if (path === "/api/assets" || path === "/api/assets/summary") return json({ assets: [], nextCursor: null, hasMore: false });
        if (path === "/api/tasks" && method === "GET") return json({ tasks: [...tasks.values()] });
        if (path === "/api/admin/prompt-recipes") return json({ recipes: [recipe], models });
        if (path === "/api/admin/prompt-recipes/free-optimize" && method === "GET")
            return json({
                recipe,
                versions: [...versions].reverse(),
                compilations: [...records.values()].reverse(),
                stats: {
                    total: records.size,
                    success: [...records.values()].filter((record) => record.status === "success").length,
                    failed: 0,
                    cacheHits: 0,
                    averageLatencyMs: records.size ? 350 : null,
                    inputTokens: records.size * 40,
                    outputTokens: records.size * 80,
                    actualCost: 0.1,
                    estimatedCost: 0.2,
                    unknownCostCount: 1,
                    costs: [
                        { currency: "CNY", actual: 0.1, estimated: 0.2, unknownCount: 0 },
                        { currency: "USD", actual: 0.03, estimated: 0.04, unknownCount: 1 },
                    ],
                },
            });
        if (path === "/api/admin/prompt-recipes/free-optimize" && method === "PATCH") {
            const input = request.postDataJSON();
            settings.push(input);
            Object.assign(recipe, input, { updatedAt: new Date().toISOString() });
            return json({ recipe });
        }
        if (path === "/api/admin/prompt-recipes/free-optimize/versions") {
            const version = { ...versions[0], ...request.postDataJSON(), id: randomUUID(), version: versions.length + 1, contentHash: `fixture-hash-${versions.length + 1}`, createdAt: new Date().toISOString() };
            versions.push(version);
            return json({ version });
        }
        if (path === "/api/admin/prompt-recipes/free-optimize/activate") {
            recipe.currentVersionId = request.postDataJSON().versionId;
            recipe.updatedAt = new Date().toISOString();
            activations.push(recipe.currentVersionId);
            return json({ recipe });
        }
        if (path === "/api/admin/prompt-recipes/free-optimize/test") {
            const input = request.postDataJSON();
            tests.push(input);
            const compilation = {
                id: randomUUID(),
                requestId: input.requestId,
                status: flags.abortTest ? "uncertain" : "success",
                optimized: !flags.abortTest,
                prompt: flags.abortTest ? undefined : `optimized: ${input.promptInput.userText}`,
                summaryZh: "明确参考图分工，保留结构",
                message: flags.abortTest ? "上游提交结果待核查，不应重复请求" : undefined,
                userId: owner,
                recipeKey: recipe.key,
                recipeVersionId: input.versionId,
                modelConfigId: input.optimizerModelConfigId || recipe.modelConfigId,
                targetModelConfigId: input.modelConfigId,
                inputSnapshot: { promptInput: input.promptInput, sourceUrls: input.sourceUrls },
                inputHash: "fixture-input-hash",
                reusedFromId: null,
                cacheHit: false,
                rawResponse: "fixture raw response; no real provider",
                latencyMs: 350,
                inputTokens: 40,
                outputTokens: 80,
                actualCost: null,
                estimatedCost: 0.001,
                currency: "USD",
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
            };
            records.set(input.requestId, compilation);
            if (flags.abortTest) return route.abort("connectionclosed");
            return json({ compilation });
        }
        if (path.startsWith("/api/admin/prompt-recipes/free-optimize/compilations/")) return json({ compilation: [...records.values()].find((record) => record.id === path.split("/").at(-1)) });
        if (path.startsWith("/api/prompt-compilations/by-request/")) {
            const compilation = records.get(path.split("/").at(-1)!);
            return compilation ? json({ compilation }) : json({ message: "not found" }, 404);
        }
        if (path === "/api/assets/upload-request") {
            const input = request.postDataJSON();
            uploads.push(input);
            const id = randomUUID();
            return json({ assetId: id, uploadUrl: `/api/test-upload/${id}` });
        }
        if (path.startsWith("/api/test-upload/") && method === "PUT") {
            uploadBytes.push(request.postDataBuffer()!);
            return route.fulfill({ status: 204 });
        }
        if (path === "/api/tasks" && method === "POST") {
            const input = request.postDataJSON();
            submissions.push(input);
            const task = { ...input, id: randomUUID(), status: "success", resultUrls: ["/api/assets/fixture-output/content"], failureReason: null };
            tasks.set(input.requestId, task);
            if (flags.abortImage) return route.abort("connectionclosed");
            return json({ task }, 201);
        }
        if (path.startsWith("/api/tasks/by-request/")) {
            const task = tasks.get(path.split("/").at(-1)!);
            return task ? json({ task }) : json({ message: "not found" }, 404);
        }
        if (/^\/api\/assets\/[^/]+\/content$/.test(path)) return route.fulfill({ contentType: "image/png", body: IMAGE });
        unexpected.push(`${method} ${path}`);
        return json({ message: "Unmocked isolated request" }, 501);
    });
    return { recipe, versions, records, requests, tests, submissions, activations, settings, uploads, uploadBytes, errors, unexpected, flags, user };
}
async function choose(page: Page, label: string, option: string) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText(option, { exact: true }).click();
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
}
async function openTests(page: Page) {
    await page.getByRole("tab", { name: "测试与对比" }).click();
    await choose(page, "目标图像模型", "图像模型 A · fixture-image-a");
    await page.getByRole("textbox", { name: "用户要求", exact: true }).fill("原始测试要求");
}

test("draft saving, JSON validation, independent binding, activation, diff and rollback are real isolated actions", async ({ page, context, baseURL }, info) => {
    const f = await fixture(context, baseURL!);
    await page.goto("/admin/prompt-recipes");
    await expect(page.getByRole("textbox", { name: "系统提示词", exact: true })).toHaveValue("PRIVATE RECIPE RULE - fixture only");
    await page.getByRole("textbox", { name: "系统提示词", exact: true }).fill("PRIVATE RECIPE RULE - revised fixture");
    await page.getByRole("textbox", { name: "模型覆盖规则（JSON 对象，值为文本）", exact: true }).fill('{"bad":3}');
    await page.getByRole("button", { name: "保存为新版本草稿" }).click();
    await expect(page.getByText("模型覆盖规则的每个值必须是字符串", { exact: true })).toBeVisible();
    expect(f.versions).toHaveLength(1);
    await page.getByRole("textbox", { name: "模型覆盖规则（JSON 对象，值为文本）", exact: true }).fill('{"fixture-image-a":"preserve new seams"}');
    await page.getByRole("button", { name: "保存为新版本草稿" }).click();
    await expect.poll(() => f.versions.length).toBe(2);
    expect(f.activations).toEqual([]);
    expect(f.recipe.currentVersionId).toBe(f.versions[0].id);
    await expect(page.getByRole("button", { name: "激活此版本 / 回滚" })).toBeEnabled();
    await choose(page, "对比版本", "与 v1 对比");
    await expect(page.getByText("有差异", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("version-diff.png"), fullPage: true });
    await page.getByRole("button", { name: "激活此版本 / 回滚" }).click();
    await page.getByRole("button", { name: "确认激活" }).click();
    await expect.poll(() => f.activations.length).toBe(1);
    await choose(page, "编辑版本", "v1 · 未激活");
    await page.getByRole("button", { name: "激活此版本 / 回滚" }).click();
    await page.getByRole("button", { name: "确认激活" }).click();
    await expect.poll(() => f.activations.length).toBe(2);
    expect(f.recipe.currentVersionId).toBe(f.versions[0].id);
    await choose(page, "独立优化模型", "独立模型 B · fixture-chat-b");
    await page.getByRole("button", { name: "保存运行设置" }).click();
    await expect.poll(() => f.settings.length).toBe(1);
    expect(f.settings[0].modelConfigId).toBe(otherChatId);
    await choose(page, "失败策略", "使用该版本的回退提示词");
    await page.getByRole("button", { name: "保存运行设置" }).click();
    await expect(page.getByText("选择回退策略前，目标版本必须保存非空回退提示词", { exact: true })).toBeVisible();
    expect(f.settings).toHaveLength(1);
    expect(f.tests).toEqual([]);
    expect(f.submissions).toEqual([]);
    expect(f.unexpected).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("upload preserves bytes; optimize is separate from image creation and images use the frozen successful snapshot", async ({ page, context, baseURL }, info) => {
    const f = await fixture(context, baseURL!);
    await page.goto("/admin/prompt-recipes");
    await openTests(page);
    await page.getByLabel("上传参考图片").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: IMAGE });
    await page.getByRole("textbox", { name: "参考图分工", exact: true }).fill("版型与结构");
    expect(f.uploads).toEqual([]);
    await page.getByRole("textbox", { name: "场景字段 JSON", exact: true }).fill("[]");
    await page.getByRole("button", { name: "仅优化测试", exact: true }).click();
    await expect(page.getByText("场景字段必须是 JSON 对象，不能是数组或空值", { exact: true })).toBeVisible();
    expect(f.tests).toEqual([]);
    expect(f.uploads).toEqual([]);
    await page.getByRole("textbox", { name: "场景字段 JSON", exact: true }).fill('{"material":"cotton"}');
    await page.getByRole("button", { name: "仅优化测试", exact: true }).click();
    await expect(page.getByText("optimized: 原始测试要求", { exact: true })).toBeVisible();
    expect(f.tests).toHaveLength(1);
    expect(f.submissions).toEqual([]);
    expect(f.uploads).toHaveLength(1);
    expect(f.uploadBytes[0]).toEqual(IMAGE);
    expect(f.tests[0].sourceUrls[0]).toMatch(/^\/api\/assets\/.*\/content$/);
    expect(f.tests[0].promptInput.referenceRoles).toEqual(["版型与结构"]);
    await choose(page, "目标图像模型", "图像模型 B · fixture-image-b");
    await page.getByRole("textbox", { name: "用户要求", exact: true }).fill("后改表单，不得进入前一次出图");
    await page.getByRole("textbox", { name: "出图参数 JSON", exact: true }).fill('{"size":"1024x1024","count":9}');
    await page.getByRole("button", { name: "测试出图（1 张）", exact: true }).click();
    expect(f.submissions).toEqual([]);
    await page.getByRole("button", { name: "提交 1 张测试图" }).click();
    await expect(page.getByRole("img", { name: "v1 测试结果 1", exact: true })).toBeVisible();
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toMatchObject({
        modelConfigId: imageId,
        operationType: "inpaint",
        toolKey: "image-edit",
        prompt: "optimized: 原始测试要求",
        parameters: { count: 1 },
        promptInput: { userText: "原始测试要求", compilationId: [...f.records.values()][0].id },
    });
    expect(f.submissions[0].sourceUrls).toEqual(f.tests[0].sourceUrls);
    await expect(page.getByRole("button", { name: "测试出图（1 张）", exact: true })).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("img", { name: "v1 测试结果 1", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("test-with-reference-and-image.png"), fullPage: true });
    await page.getByRole("button", { name: "仅优化测试", exact: true }).click();
    await expect(page.getByText("optimized: 后改表单，不得进入前一次出图", { exact: true })).toBeVisible();
    expect(f.tests).toHaveLength(2);
    expect(f.uploads).toHaveLength(1);
    expect(f.submissions).toHaveLength(1);
    await page.getByRole("tab", { name: "统计与记录" }).click();
    await expect(page.getByText("CNY", { exact: true })).toBeVisible();
    await expect(page.getByText("USD", { exact: true })).toBeVisible();
    expect(f.unexpected).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("uncertain optimizer submission only queries the original request and never generates an image", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!);
    f.flags.abortTest = true;
    await page.goto("/admin/prompt-recipes");
    await openTests(page);
    await page.getByRole("button", { name: "仅优化测试", exact: true }).click();
    await expect(page.getByText(/网络连接中断/).first()).toBeVisible();
    expect(f.tests).toHaveLength(1);
    await page.getByRole("button", { name: "查询原优化请求", exact: true }).click();
    await expect(page.getByText("上游提交结果待核查，不应重复请求", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "测试出图（1 张）", exact: true })).toBeDisabled();
    expect(f.tests).toHaveLength(1);
    expect(f.submissions).toEqual([]);
    expect(f.requests.filter((path) => path.startsWith("GET /api/prompt-compilations/by-request/"))).toHaveLength(1);
    expect(f.unexpected).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("uncertain image submission keeps its request ID and restores the original task without another POST", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!);
    f.flags.abortImage = true;
    await page.goto("/admin/prompt-recipes");
    await openTests(page);
    await page.getByRole("button", { name: "仅优化测试", exact: true }).click();
    await expect(page.getByText("optimized: 原始测试要求", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "测试出图（1 张）", exact: true }).click();
    await page.getByRole("button", { name: "提交 1 张测试图" }).click();
    await expect(page.getByText(/只查询原任务，勿重复生成/)).toBeVisible();
    await page.getByRole("button", { name: "查询原出图任务", exact: true }).click();
    await expect(page.getByRole("img", { name: "v1 测试结果 1", exact: true })).toBeVisible();
    expect(f.submissions).toHaveLength(1);
    expect(f.tests).toHaveLength(1);
    expect(f.requests.filter((path) => path.startsWith("GET /api/tasks/by-request/"))).toHaveLength(1);
    expect(f.unexpected).toEqual([]);
    expect(f.errors).toEqual([]);
});

for (const role of ["department_admin", "designer"])
    test(`${role} cannot fetch private authoring or diagnostics`, async ({ page, context, baseURL }) => {
        const f = await fixture(context, baseURL!, role);
        await page.goto("/admin/prompt-recipes");
        if (role === "department_admin") await expect(page.getByText("仅超级管理员可管理提示词配方", { exact: true })).toBeVisible();
        else await expect(page.getByRole("heading", { name: "进入后台管理" })).toBeVisible();
        expect(f.requests.filter((path) => path.includes("prompt-recipes"))).toEqual([]);
        await expect(page.getByText("PRIVATE RECIPE RULE - fixture only", { exact: true })).toHaveCount(0);
        expect(f.errors).toEqual([]);
    });

test("privilege change immediately purges visible recipe content and no recipe text is persisted", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!);
    await page.goto("/admin/prompt-recipes");
    await expect(page.getByRole("textbox", { name: "系统提示词", exact: true })).toHaveValue("PRIVATE RECIPE RULE - fixture only");
    const count = f.requests.filter((path) => path.includes("prompt-recipes")).length;
    f.flags.role = "department_admin";
    await page.evaluate(async () => {
        const store = await import("/src/stores/use-user-store.ts");
        const user = store.useUserStore.getState().user;
        store.useUserStore.setState({ user: { ...user, role: "department_admin" } });
    });
    await expect(page.getByText(/登录账号已变化|仅超级管理员可管理提示词配方/).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "系统提示词", exact: true })).toHaveCount(0);
    expect(f.requests.filter((path) => path.includes("prompt-recipes"))).toHaveLength(count);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain("PRIVATE RECIPE RULE");
    expect(f.errors).toEqual([]);
});

test("390px dark layout keeps editor controls reachable without horizontal page overflow", async ({ page, context, baseURL }, info) => {
    const f = await fixture(context, baseURL!);
    await page.goto("/admin/prompt-recipes");
    await expect(page.getByRole("textbox", { name: "系统提示词", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("textbox", { name: "系统提示词", exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator(".wb-page").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("editor-dark-390.png"), fullPage: true });
    expect(f.unexpected).toEqual([]);
    expect(f.errors).toEqual([]);
});

test("test scene is bound to the recipe and reference selection stops at the compiler's eight-image limit", async ({ page, context, baseURL }) => {
    const f = await fixture(context, baseURL!);
    await page.goto("/admin/prompt-recipes");
    await openTests(page);
    await expect(page.getByRole("textbox", { name: "场景标识", exact: true })).toHaveValue("free-optimize");
    await expect(page.getByRole("textbox", { name: "场景标识", exact: true })).toHaveAttribute("readonly", "");
    await page.getByLabel("上传参考图片").setInputFiles(Array.from({ length: 9 }, (_, index) => ({ name: `reference-${index}.png`, mimeType: "image/png", buffer: IMAGE })));
    await expect(page.getByRole("img", { name: /^参考图 \d+$/ })).toHaveCount(8);
    await expect(page.getByText("提示词优化最多接受 8 张参考图，仍须遵守目标模型的参考图上限", { exact: true })).toBeVisible();
    expect(f.tests).toEqual([]);
    expect(f.uploads).toEqual([]);
    expect(f.submissions).toEqual([]);
    expect(f.unexpected).toEqual([]);
    expect(f.errors).toEqual([]);
});
