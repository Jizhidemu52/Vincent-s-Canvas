import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../labs/design-workbench/package.json", import.meta.url))("playwright");
const origin = process.env.DESIGN_WORKBENCH_URL || "http://127.0.0.1:5188";
const output = path.resolve(process.cwd(), "../output/series-recipe-formal");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "chrome" });
const context = await browser.newContext({ viewport: { width: 1512, height: 1120 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [],
    requests = [],
    submissions = [],
    checks = [],
    blockedWrites = [];
const tasks = new Map();
let identity = "recipe-qa-owner-a",
    enabled = true,
    fixtureBytes,
    holdNext = false,
    abortNext = false,
    failNext = false,
    uploadCount = 0;
const user = () => ({ id: identity, username: identity, displayName: "系列隔离验证", role: "designer", status: "active", mustChangePassword: false, avatarUrl: "", creditBalance: 999, groupId: null });
const business = () => ({
    models: [{ id: "qa-model", name: "QA 图像模型", modelId: "gpt-image-2", capabilities: ["edit", "generate"], creditCost: 1, rmbCost: 0.1 }],
    prices: [{ operationType: "inpaint", label: "图像编辑", credits: 1, rmbCost: 0.1, version: 1 }],
    tools: [{ toolKey: "series-recipe", modelConfigId: "qa-model", enabled, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1, capabilities: ["edit"] }],
});
// ALL API calls and every remote/non-GET request are blocked or fulfilled here.
// No request can reach a real task, upload, provider or billing endpoint.
await context.route("**/*", async (route) => {
    const request = route.request(),
        url = new URL(request.url()),
        pathname = url.pathname,
        method = request.method();
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) return route.abort("blockedbyclient");
    if (!pathname.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(method)) throw new Error(`Unmocked write blocked: ${method} ${pathname}`);
        return route.continue();
    }
    requests.push({ path: pathname, method, owner: request.headers()["x-canvas-owner-id"] });
    const fulfill = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/deployment") return fulfill({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: true });
    if (pathname === "/api/auth/session") return fulfill({ user: user() });
    if (pathname === "/api/models") return fulfill(business());
    if (pathname === "/api/modules")
        return fulfill({
            modules: [
                { moduleKey: "creative", enabled: true },
                { moduleKey: "series-recipe", enabled },
                { moduleKey: "canvas", enabled: false },
            ],
        });
    if (pathname === "/api/assets/upload-request" && method === "POST") {
        const id = `qa-upload-${++uploadCount}`;
        return fulfill({ assetId: id, uploadUrl: `/api/qa-upload/${id}` });
    }
    if (pathname.startsWith("/api/qa-upload/") && method === "PUT") return route.fulfill({ status: 204 });
    if (pathname === "/api/tasks" && method === "POST") {
        const payload = request.postDataJSON();
        submissions.push(payload);
        const id = `task-${submissions.length}`;
        const status = holdNext ? "running" : failNext ? "failed" : "success";
        tasks.set(id, {
            id,
            requestId: payload.requestId,
            operationType: "inpaint",
            status,
            resultUrls: status === "success" ? [`/api/assets/result-${submissions.length}/content`] : [],
            failureReason: status === "failed" ? "QA confirmed provider failure" : null,
            ownerUserId: identity,
        });
        holdNext = false;
        failNext = false;
        if (abortNext) {
            abortNext = false;
            return route.abort("failed");
        }
        return fulfill({ task: { id } });
    }
    if (pathname.startsWith("/api/tasks/by-request/") && method === "GET") {
        const requestId = decodeURIComponent(pathname.split("/").at(-1));
        const task = [...tasks.values()].find((task) => task.requestId === requestId && task.ownerUserId === identity);
        return task ? fulfill({ task }) : route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
    if (/^\/api\/tasks\/task-\d+$/.test(pathname) && method === "GET") {
        const task = tasks.get(pathname.split("/").at(-1));
        return task && task.ownerUserId === identity ? fulfill({ task }) : route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
    if (/^\/api\/assets\/result-\d+\/content$/.test(pathname) && method === "GET") return route.fulfill({ status: 200, contentType: "image/png", body: fixtureBytes });
    if (!["GET", "HEAD"].includes(method)) {
        blockedWrites.push({ path: pathname, method });
        return route.abort("blockedbyclient");
    }
    return fulfill({ code: 0, data: [], tasks: [], projects: [], documents: [], assets: [] });
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
const button = (name) => page.getByRole("button", { name, exact: true });
const waitCount = (count) => page.waitForFunction((expected) => document.querySelectorAll(".sr-result").length === expected, count);
const waitUntil = async (fn) => {
    const deadline = Date.now() + 15000;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error("QA condition timed out");
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
};
const settleTask = (id) => {
    const task = tasks.get(id);
    task.status = "success";
    task.failureReason = null;
    task.resultUrls = [`/api/assets/result-${id.split("-")[1]}/content`];
};
async function download(locator, name) {
    const pending = page.waitForEvent("download");
    await locator.click();
    const item = await pending;
    const destination = path.join(output, name);
    await item.saveAs(destination);
    return fs.readFile(destination);
}
async function switchOwner(next) {
    identity = next;
    await page.evaluate(async (nextUser) => {
        const { useUserStore } = await import("/src/stores/use-user-store.ts");
        useUserStore.getState().updateUser(nextUser);
    }, user());
}
try {
    await page.goto(origin + "/creative/series-recipe");
    await page.getByRole("heading", { name: "系列配方", exact: true }).waitFor();
    const fixture = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 640;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#e7e1d6";
        ctx.fillRect(0, 0, 480, 640);
        ctx.fillStyle = "#91a8a1";
        ctx.fillRect(120, 130, 240, 390);
        ctx.fillRect(50, 130, 100, 140);
        ctx.fillRect(330, 130, 100, 140);
        ctx.fillStyle = "#e7e1d6";
        ctx.beginPath();
        ctx.arc(240, 130, 50, 0, Math.PI);
        ctx.fill();
        return canvas.toDataURL("image/png").split(",")[1];
    });
    fixtureBytes = Buffer.from(fixture, "base64");
    const uploadFixture = { name: "qa-reference.png", mimeType: "image/png", buffer: fixtureBytes };
    assert.equal(await page.getByRole("button", { name: /运行配方/ }).isDisabled(), true);
    await page.getByLabel("上传参考底图（必需）", { exact: true }).setInputFiles(uploadFixture);
    await page.getByLabel("系列名称", { exact: true }).fill("QA Frozen Series");
    await page.getByLabel("必须保留", { exact: true }).fill("保持纽扣和缝线不变 QA invariant");
    await page.getByLabel("当前颜色 HEX", { exact: true }).fill("#345678");
    await button("应用").click();
    holdNext = true;
    await page.getByRole("button", { name: /运行配方/ }).click();
    await waitUntil(() => submissions.length === 1);
    assert.equal(await page.getByLabel("系列名称", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel("上传参考底图（必需）", { exact: true }).isDisabled(), true);
    assert.equal(submissions[0].toolKey, "series-recipe");
    assert.equal(submissions[0].modelConfigId, "qa-model");
    assert.match(submissions[0].prompt, /#345678/);
    assert.match(submissions[0].prompt, /QA invariant/);
    await button("暂停后续").click();
    settleTask("task-1");
    await page.locator(".sr-result-image img").first().waitFor();
    await page.waitForTimeout(1200);
    assert.equal(submissions.length, 1, "pause must prevent a second branch submission");
    failNext = true;
    await button("继续分支").click();
    await waitUntil(() => submissions.length === 3);
    await button("仅重试确认失败项 (1)").waitFor({ state: "visible" });
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((button) => button.textContent.includes("仅重试确认失败项"))?.disabled);
    assert.equal(await page.locator(".sr-result-image img").count(), 2);
    const firstSource = await page.locator(".sr-result-image img").first().getAttribute("src");
    await page.getByLabel("系列名称", { exact: true }).fill("QA Changed Draft");
    await page.getByLabel("设计方向", { exact: true }).fill("只改下次运行，不改失败重试");
    await button("仅重试确认失败项 (1)").click();
    await waitUntil(() => submissions.length === 4);
    await page.waitForFunction(() => document.querySelectorAll(".sr-result-image img").length === 3 && !document.querySelector('input[aria-label="系列名称"]').disabled);
    assert.equal(await page.locator(".sr-result-image img").first().getAttribute("src"), firstSource);
    assert.match(submissions[3].prompt, /QA Frozen Series/);
    assert.doesNotMatch(submissions[3].prompt, /QA Changed Draft/);
    assert.equal(new Set(submissions.map((item) => item.requestId)).size, 4);
    checks.push("reference upload, bound model and real requestEdit payload, 1-per-branch task creation, frozen inputs, true pause scheduling, failed-only explicit retry preserves successful outputs and original prompt");

    await page.locator(".sr-selection input").first().uncheck();
    const board = await download(button("方案板 PNG (2)"), "series-board.png");
    assert.equal(board.subarray(1, 4).toString(), "PNG");
    assert.equal(board.readUInt32BE(16), 1440);
    assert.equal(board.readUInt32BE(20), 790);
    const portable = JSON.parse((await download(button("导出完整项目 JSON"), "series-project.json")).toString());
    assert.equal(portable.form.series, "QA Changed Draft");
    assert.equal(portable.run.form.series, "QA Frozen Series");
    assert.deepEqual(
        portable.run.branches.map((branch) => branch.attempts),
        [1, 2, 1],
    );
    assert.equal(portable.run.branches.filter((branch) => branch.selected).length, 2);
    assert.ok(portable.run.branches.every((branch) => /^data:image\/png;base64,/.test(branch.images[0].dataUrl)));
    assert.equal(Object.hasOwn(portable.settings, "apiKey"), false);
    await page.getByLabel("系列名称", { exact: true }).fill("will be replaced");
    await page.getByLabel("导入系列配方项目", { exact: true }).setInputFiles({ name: "import.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(portable)) });
    await page.waitForFunction(() => document.querySelector('input[aria-label="系列名称"]').value === "QA Changed Draft");
    await button("保存项目").click();
    await page.getByText("已保存到当前员工的本地浏览器。", { exact: true }).waitFor();
    await page.reload();
    await waitCount(3);
    assert.equal(await page.getByLabel("系列名称", { exact: true }).inputValue(), "QA Changed Draft");
    assert.equal(await page.locator(".sr-selection input:checked").count(), 2);
    await page.screenshot({ path: path.join(output, "series-desktop.png"), fullPage: true });
    checks.push("result selection; real 1440x790 PNG; portable JSON embeds original and outputs without credentials; validated JSON import; employee-scoped IndexedDB reload restores run and selections");

    await button("随机配色").click();
    await page.getByLabel("配色风格", { exact: true }).selectOption("earth");
    await button("换一组").click();
    await page.getByLabel("选择流程", { exact: true }).selectOption("pattern");
    await page.getByLabel("候选数量", { exact: true }).selectOption("2");
    await page.getByLabel("上传图案参考（可选）", { exact: true }).setInputFiles({ ...uploadFixture, name: "qa-motif.png" });
    await page.getByLabel("候选 1 定位", { exact: true }).fill("袖口外侧 QA placement");
    await page.getByRole("button", { name: /生成新一轮/ }).click();
    await waitUntil(() => submissions.length === 6);
    await page.waitForFunction(() => document.querySelectorAll(".sr-result-image img").length === 2 && !document.querySelector('input[aria-label="系列名称"]').disabled);
    assert.match(submissions[4].prompt, /参考图 2/);
    assert.match(submissions[4].prompt, /QA placement/);
    assert.equal(submissions[4].sourceUrls.length, 2);
    checks.push("manual HEX, random palette styles, optional motif reference, per-branch placement instructions and both references reach real requestEdit pipeline");

    holdNext = true;
    await page.getByRole("button", { name: /生成新一轮/ }).click();
    await waitUntil(() => submissions.length === 7);
    await button("停止").click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("查询原任务 (1)"))?.disabled === false);
    assert.equal(submissions.length, 7);
    settleTask("task-7");
    const beforeRecovery = submissions.length;
    await button("查询原任务 (1) · 不重新生成").click();
    await page.waitForFunction(() => document.querySelectorAll(".sr-result-image img").length === 1 && !document.querySelector('input[aria-label="系列名称"]').disabled);
    assert.equal(submissions.length, beforeRecovery);
    assert.equal(
        requests.some((item) => item.path.endsWith("/cancel")),
        false,
    );
    await page.getByLabel("候选数量", { exact: true }).selectOption("1");
    abortNext = true;
    await page.getByRole("button", { name: /生成新一轮/ }).click();
    await waitUntil(() => submissions.length === 8);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("查询原任务 (1)"))?.disabled === false);
    await button("查询原任务 (1) · 不重新生成").click();
    await page.waitForFunction(() => document.querySelectorAll(".sr-result-image img").length === 1 && !document.querySelector('input[aria-label="系列名称"]').disabled);
    assert.equal(submissions.length, 8);
    assert.ok(requests.some((item) => item.path.includes("/tasks/by-request/")));
    checks.push("stop aborts polling and queued branches without cancelling accepted provider tasks; original-task GET recovery; lost POST response recovers by preserved requestId:0 without another paid POST");

    await page.screenshot({ path: path.join(output, "series-pattern.png"), fullPage: true });
    const light = await page.locator(".sr-inputs").evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.evaluate(async () => {
        const { useThemeStore } = await import("/src/stores/use-theme-store.ts");
        useThemeStore.getState().setTheme("dark");
    });
    await page.waitForFunction((previous) => getComputedStyle(document.querySelector(".sr-inputs")).backgroundColor !== previous, light);
    await page.screenshot({ path: path.join(output, "series-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator(".series-recipe-page").evaluate((el) => el.scrollWidth > el.clientWidth + 2), false);
    await page.screenshot({ path: path.join(output, "series-mobile.png"), fullPage: true });
    await page.locator(".sr-controls").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "series-mobile-controls.png"), fullPage: true });
    await page.setViewportSize({ width: 1512, height: 1120 });
    checks.push("desktop/dark/mobile screenshots and 390px no-horizontal-overflow check");

    await page.getByLabel("候选数量", { exact: true }).selectOption("2");
    holdNext = true;
    await page.getByRole("button", { name: /生成新一轮/ }).click();
    await waitUntil(() => submissions.length === 9);
    await switchOwner("recipe-qa-owner-b");
    await page.getByText("从你的产品参考开始", { exact: true }).waitFor();
    settleTask("task-9");
    await page.waitForTimeout(1100);
    assert.equal(submissions.length, 9);
    assert.equal(await page.locator(".sr-result").count(), 0);
    await switchOwner("recipe-qa-owner-a");
    await waitCount(2);
    await button("查询原任务 (1) · 不重新生成").waitFor();
    await button("查询原任务 (1) · 不重新生成").click();
    await page.waitForFunction(() => document.querySelectorAll(".sr-result-image img").length === 1 && !document.querySelector('input[aria-label="系列名称"]').disabled);
    assert.equal(submissions.length, 9);
    enabled = false;
    await page.evaluate(async () => {
        const { useBusinessConfigStore } = await import("/src/stores/use-business-config-store.ts");
        const { useModuleStore } = await import("/src/stores/use-module-store.ts");
        await useBusinessConfigStore.getState().refresh();
        await useModuleStore.getState().refresh();
    });
    await page.waitForURL(origin + "/");
    await page.goto(origin + "/creative/series-recipe");
    await page.waitForURL(origin + "/");
    assert.equal(submissions.length, 9);
    assert.ok(requests.filter((item) => item.path === "/api/tasks" && item.method === "POST").every((item) => item.owner === "recipe-qa-owner-a"));
    checks.push("OA-style employee A/B IndexedDB isolation; active identity switch aborts/discards late work; A restores and queries original task; module/tool disable redirects and rejects direct URL");
    assert.deepEqual(errors, []);
    assert.deepEqual(blockedWrites, []);
    await fs.writeFile(
        path.join(output, "report.json"),
        JSON.stringify(
            {
                passed: true,
                checks,
                errors,
                submissions: submissions.map(({ prompt, requestId, toolKey, modelConfigId, sourceUrls }) => ({ prompt, requestId, toolKey, modelConfigId, sourceUrls })),
                requests,
                scope: "Isolated browser; every API mocked, all remote and unmocked write requests blocked. No real provider/billing calls.",
            },
            null,
            2,
        ),
    );
    console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} catch (error) {
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
    await fs.writeFile(path.join(output, "failure.json"), JSON.stringify({ error: error.stack, checks, errors, requests, submissionCount: submissions.length, body: await page.locator("body").innerText() }, null, 2));
    throw error;
} finally {
    await context.close();
    await browser.close();
}
