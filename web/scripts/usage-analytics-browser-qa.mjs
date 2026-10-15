// Run from web: node scripts/usage-analytics-browser-qa.mjs
// Real Chrome, isolated context, complete API mocks; no provider calls or credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog.ts";

const { chromium } = createRequire(new URL("../../labs/design-workbench/package.json", import.meta.url))("playwright");
const origin = "http://127.0.0.1:5188";
const detailOnly = process.argv.includes("--detail-only");
const analysisOnly = process.argv.includes("--analysis-only");
const output = fileURLToPath(new URL(`../../output/usage-analytics-ui-qa/${analysisOnly ? "oa-analysis-models/" : detailOnly ? "personal-charts/" : ""}`, import.meta.url));
await fs.mkdir(output, { recursive: true });
const report = { scope: "Isolated real Chrome UI, OA enabled; all API traffic mocked, external HTTP and WebSockets blocked; provider calls 0.", checks: [], requests: [], downloads: [], pageErrors: [], external: [], unexpectedWrites: [], creativeAdminModelRequests: 0 };
const summary = { visits: 31, interactions: 52, generationRequests: 12, chatRequests: 3, succeeded: 11, failed: 2, pending: 2 };
const coverage = { collectionStartedAt: "2026-10-15T00:00:00.000Z", historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, droppedEventCount: 4, notes: ["当前明细只反映已采集记录，不代表工作时长。"] };
const breakdowns = { boards: [{ key: "canvas", label: "无限画布", count: 34 }, { key: "chat", label: "对话设计", count: 19 }, { key: "image-generation", label: "AI 生图", count: 12 }], models: [{ key: "gpt2", label: "GPT2 · 日常最通用模型", count: 9 }, { key: "nano2", label: "Nano2 · 多图参考", count: 3 }, { key: "text", label: "配置的文字分析模型", count: 3 }], controls: [{ key: "model", label: "模型选择", count: 7 }], daily: [] };
const personalSummary = { visits: 4, interactions: 7, generationRequests: 3, chatRequests: 1, succeeded: 3, failed: 1, pending: 0 };
const personalBreakdowns = { boards: [{ key: "image-edit", label: "个人改图板块", count: 11 }], models: [{ key: "personal-gpt2", label: "个人常用 GPT2", count: 3 }, { key: "text", label: "配置的文字分析模型", count: 1 }], controls: [{ key: "mask", label: "个人局部遮罩操作", count: 5 }, { key: "resolution", label: "个人分辨率选择", count: 2 }], daily: [] };
const personalCoverage = { ...coverage, droppedEventCount: 2 };
const people = Array.from({ length: 25 }, (_, index) => ({ userId: `qa-person-${index + 1}`, displayName: index === 0 ? "张三" : index === 1 ? "李四" : `设计师 ${String(index + 1).padStart(2, "0")}`, departmentName: index < 10 ? "产品开发部" : "设计部", summary, lastActivityAt: "2026-10-15T03:30:00.000Z" }));
const records = Array.from({ length: 45 }, (_, index) => {
    const kind = ["generation", "chat", "interaction", "visit", "gap"][index % 5];
    return { id: `qa-record-${index + 1}`, kind, userId: people[0].userId, displayName: people[0].displayName, boardKey: "canvas", boardLabel: "无限画布", action: kind === "generation" ? "generate" : kind === "gap" ? "gap" : "click", controlKey: kind === "interaction" ? "model" : null, controlLabel: kind === "interaction" ? "模型选择" : null, modelConfigId: ["generation", "chat"].includes(kind) ? "qa-text-model" : null, modelName: ["generation", "chat"].includes(kind) ? "GPT2 · 日常最通用模型" : null, status: kind === "generation" && index === 0 ? "failed" : ["generation", "chat"].includes(kind) ? "success" : "recorded", occurredAt: "2026-10-15T02:00:00.000Z", updatedAt: "2026-10-15T02:00:01.000Z", prompt: ["generation", "chat"].includes(kind) ? "保留针织纹理，只将领口调整为圆领；联系方式 [已脱敏]。" : null, promptRedacted: ["generation", "chat"].includes(kind), parameters: kind === "gap" ? { droppedEventCount: 4 } : { quality: "high", resolution: "2K", count: 1 } };
});
let role = "super_admin", exportMode = "success", analysisMode = "success", listMode = "success", modelsMode = analysisOnly ? "failure" : "success", previewCounter = 0;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, acceptDownloads: true, serviceWorkers: "block" });
await context.routeWebSocket("**/*", socket => socket.close());
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", error => report.pageErrors.push(error.message));
await context.addInitScript(() => {
    window.__usageQaPicker = { opens: [], chunks: [], closes: 0, aborts: 0 };
    window.showSaveFilePicker = async options => {
        window.__usageQaPicker.opens.push(options);
        return { createWritable: async () => ({ write: async bytes => window.__usageQaPicker.chunks.push(Array.from(bytes)), close: async () => { window.__usageQaPicker.closes++; }, abort: async () => { window.__usageQaPicker.aborts++; } }) };
    };
});
await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { report.external.push({ pathname, method }); return route.abort("blockedbyclient"); }
    if (!pathname.startsWith("/api/")) return ["GET", "HEAD"].includes(method) ? route.continue() : route.abort("blockedbyclient");
    const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) }).catch(() => undefined);
    const envelope = value => json({ code: 0, data: value, msg: "ok" });
    if (pathname === "/api/deployment") return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: true });
    if (pathname === "/api/auth/session") return json({ user: { id: "usage-admin-qa", username: "qa", displayName: "使用分析隔离 QA", role, status: "active", mustChangePassword: false, creditBalance: 999, avatarUrl: "", departmentId: null, groupId: null } });
    if (pathname === "/api/models") {
        if (role !== "designer") { report.creativeAdminModelRequests++; return json({ code: "FORBIDDEN", msg: "Creative models are not available to OA local admins" }, 403); }
        return json({ models: [], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) });
    }
    if (pathname === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
    if (pathname === "/api/usage/events") return envelope({ accepted: request.postDataJSON()?.events?.length || 0, duplicates: 0 });
    if (pathname === "/api/usage/me") return envelope({ boards: [], controls: [], coverage });
    if (pathname.startsWith("/api/admin/usage/")) {
        const input = method === "POST" ? request.postDataJSON() : Object.fromEntries(url.searchParams);
        report.requests.push({ pathname, method, input });
        if (role !== "super_admin") return json({ code: "FORBIDDEN", msg: "fixture-denied" }, 403);
        if (pathname === "/api/admin/usage/analysis-models") {
            if (modelsMode === "failure") return json({ code: "INTERNAL_ERROR", msg: "private-upstream-model-text" }, 500);
            return envelope({ models: modelsMode === "empty" ? [] : [{ id: "qa-text-model", name: "配置的文字分析模型", description: "汇总工作流程" }] });
        }
        if (pathname === "/api/admin/usage/people") {
            if (listMode === "failure") return json({ code: "INTERNAL_ERROR", msg: "private-upstream-text" }, 500);
            const matches = url.searchParams.get("search") ? people.filter(person => person.displayName.includes(url.searchParams.get("search"))) : people;
            const current = Number(url.searchParams.get("page") || 1), pageSize = 20;
            return envelope({ people: matches.slice((current - 1) * pageSize, current * pageSize), pagination: { page: current, pageSize, total: matches.length }, summary, breakdowns, coverage });
        }
        if (pathname.startsWith("/api/admin/usage/people/")) {
            const person = people.find(person => person.userId === decodeURIComponent(pathname.split("/").at(-1))) || people[0];
            const current = Number(url.searchParams.get("page") || 1), pageSize = 20;
            return envelope({ person: { ...person, summary: personalSummary }, summary: personalSummary, breakdowns: personalBreakdowns, coverage: personalCoverage, records: records.slice((current - 1) * pageSize, current * pageSize), pagination: { page: current, pageSize, total: records.length } });
        }
        if (pathname === "/api/admin/usage/export") {
            if (exportMode === "delay") await new Promise(resolve => setTimeout(resolve, 1500));
            const exported = records.map(record => ({ type: "record", record }));
            const lines = [{ type: "manifest", filters: input, coverage, exportedAt: new Date().toISOString() }, ...exported];
            if (exportMode !== "incomplete") lines.push({ type: "complete", recordCount: exported.length });
            return route.fulfill({ contentType: "application/x-ndjson", body: lines.map(line => JSON.stringify(line)).join("\n") + "\n" }).catch(() => undefined);
        }
        if (pathname === "/api/admin/usage/analysis-preview") {
            previewCounter++;
            return envelope({ previewId: `qa-preview-${previewCounter}`, previewHash: `frozen-${previewCounter}`, expiresAt: "2099-10-15T00:00:00.000Z", content: JSON.stringify({ scope: input.userIds ? "selected" : "all", summary, coverage, ...(input.includePromptSamples ? { promptSamples: ["针织品领口改款（已脱敏摘要）"] } : {}) }, null, 2), estimatedCharacters: 360, includesPromptSamples: Boolean(input.includePromptSamples), sampleCount: input.includePromptSamples ? 1 : 0, warnings: ["只描述流程，不推断人格、绩效或排名。"] });
        }
        if (pathname === "/api/admin/usage/analyze") {
            await new Promise(resolve => setTimeout(resolve, analysisMode === "delay" ? 1500 : 180));
            if (analysisMode === "failure") return json({ code: "UPSTREAM_ERROR", msg: "private-upstream-text" }, 502);
            return envelope({ analysisId: "qa-analysis", modelConfigId: "qa-text-model", content: "记录显示多参考改图较多，可统一保存常用参数。采集存在缺口，不据此推断工作时长、人格或绩效。", createdAt: new Date().toISOString() });
        }
    }
    if (!["GET", "HEAD"].includes(method)) { report.unexpectedWrites.push({ pathname, method }); return json({ code: "MOCK_UNIMPLEMENTED", msg: "No live request sent" }, 403); }
    return json({ code: 0, data: [], users: [], departments: [], auditLogs: [], history: [], tasks: [], projects: [], documents: [], assets: [], totalRmbCost: 0, total: 0 });
});
const count = suffix => report.requests.filter(request => request.pathname.endsWith(suffix)).length;
const waitUntil = async predicate => { const deadline = Date.now() + 15000; while (!predicate()) { if (Date.now() > deadline) throw new Error("Expected UI request did not occur"); await new Promise(resolve => setTimeout(resolve, 25)); } };
const check = text => { report.checks.push(text); process.stdout.write(`${text}\n`); };
const select = async (label, option) => { await page.getByLabel(label, { exact: true }).click(); await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText(option, { exact: true }).click(); };
const settleDrawer = () => page.waitForFunction(() => {
    const panel = document.querySelector(".ant-drawer-content-wrapper");
    if (!panel) return false;
    const bounds = panel.getBoundingClientRect();
    return Math.abs(bounds.right - innerWidth) < 1 && bounds.left >= -1 && bounds.width <= innerWidth + 1;
});
const download = async (openButton, expectedIds, filename) => {
    await openButton.click();
    const event = page.waitForEvent("download");
    await page.getByRole("button", { name: "开始导出完整记录", exact: true }).click();
    const result = await event; await result.saveAs(path.join(output, filename));
    const values = (await fs.readFile(path.join(output, filename), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(values[0].type, "manifest"); assert.deepEqual(values[0].filters.userIds, expectedIds);
    assert.equal(values.at(-1).type, "complete"); assert.equal(values.at(-1).recordCount, values.filter(line => line.type === "record").length);
    report.downloads.push({ filename, recordCount: values.at(-1).recordCount, userIds: expectedIds || "all" });
    await page.getByText(/已完整导出 45 条记录/).waitFor();
};

async function verify() {
try {
    await page.goto(`${origin}/admin?tab=usage-analysis`);
    await page.getByRole("heading", { name: "使用分析", exact: true }).waitFor();
    await page.getByRole("button", { name: "张三", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "管理板块", exact: true }).getByRole("link", { name: "使用分析", exact: true }).count(), 1);
    assert.equal(count("/analyze"), 0); assert.equal(count("/analysis-preview"), 0);
    await page.getByText(/已知采集缺口：4 条事件/).waitFor();
    await page.screenshot({ path: path.join(output, "01-desktop-overview.png"), fullPage: true });
    check("Independent top-level admin tab, aggregate charts, no automatic preview/LLM call, and visible historical/dropped-event coverage.");
    if (analysisOnly) {
        await page.getByText(/文字模型读取失败：/).waitFor();
        assert.equal(report.creativeAdminModelRequests, 0); const initialModelReads = count("/analysis-models"); assert.ok(initialModelReads >= 1);
        await page.getByRole("button", { name: "预览将发送的汇总", exact: true }).click();
        await page.getByTestId("usage-analysis-preview").waitFor();
        const submit = page.getByRole("button", { name: "发送已预览汇总 · 手动分析", exact: true });
        assert.equal(await submit.isDisabled(), true); assert.equal(count("/analyze"), 0);
        modelsMode = "empty";
        await page.getByRole("button", { name: "重新加载文字模型", exact: true }).click();
        await page.getByText("暂无可用于分析的文字模型", { exact: true }).waitFor();
        assert.equal(await submit.isDisabled(), true); assert.equal(count("/analyze"), 0);
        modelsMode = "success";
        await page.getByRole("button", { name: "重新加载文字模型", exact: true }).click();
        await waitUntil(() => count("/analysis-models") === initialModelReads + 2);
        await page.waitForFunction(() => !document.querySelector('button[aria-label="重新加载文字模型"]')?.classList.contains("ant-btn-loading"));
        assert.equal(await submit.isDisabled(), true);
        await select("使用分析文字模型", "配置的文字分析模型 · 汇总工作流程");
        await submit.evaluate(element => { element.click(); element.click(); });
        await page.getByRole("region", { name: "使用分析结果", exact: true }).waitFor();
        assert.equal(count("/analyze"), 1);
        assert.deepEqual(report.requests.find(request => request.pathname.endsWith("/analyze")).input, { previewId: "qa-preview-1", previewHash: "frozen-1", modelConfigId: "qa-text-model", confirm: true });
        assert.equal(report.creativeAdminModelRequests, 0);
        await page.getByRole("region", { name: "手动模型分析", exact: true }).evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.screenshot({ path: path.join(output, "oa-admin-analysis-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("region", { name: "手动模型分析", exact: true }).evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.screenshot({ path: path.join(output, "oa-admin-analysis-mobile.png") });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        check("OA=true admin uses only the strict analysis-models endpoint; failed and empty choices allow preview but cannot submit, and manual retry still requires explicit UUID selection.");
        check("A configured UUID submits the frozen preview exactly once after manual double click; no creative /api/models access and no provider call; desktop/390px checked.");
        for (const nextRole of ["department_admin", "designer"]) {
            role = nextRole; const before = report.requests.length;
            await page.reload(); await page.waitForLoadState("networkidle");
            assert.equal(await page.getByRole("button", { name: "重新加载文字模型", exact: true }).count(), 0);
            assert.equal(report.requests.length, before);
        }
        assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.unexpectedWrites, []);
        report.completedAt = new Date().toISOString(); report.passed = true; return;
    }

    await page.getByRole("button", { name: "张三", exact: true }).click();
    const drawer = page.getByRole("dialog").filter({ hasText: "张三 · 使用记录" });
    await drawer.getByLabel("生成请求 qa-record-1", { exact: true }).waitFor();
    await settleDrawer();
    await page.getByRole("region", { name: "操作控件分布", exact: true }).getByText("模型选择", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("搜索使用分析用户", { exact: true }).getAttribute("placeholder"), "姓名或账号");
    await drawer.getByRole("region", { name: "个人模型调用分布", exact: true }).getByText("个人常用 GPT2", { exact: true }).waitFor();
    await drawer.getByRole("region", { name: "个人板块使用分布", exact: true }).getByText("个人改图板块", { exact: true }).waitFor();
    await drawer.getByRole("region", { name: "个人操作控件分布", exact: true }).getByText("个人局部遮罩操作", { exact: true }).waitFor();
    const personalBrief = await drawer.getByLabel("个人统计简述", { exact: true }).innerText();
    assert.ok(personalBrief.includes("该员工已记录 4 次模型请求")); assert.ok(personalBrief.includes("2 条已知采集缺口"));
    assert.equal(personalBrief.includes("15 次模型请求"), false); assert.equal(personalBrief.includes("4 条已知采集缺口"), false);
    assert.equal(await drawer.getByRole("region", { name: "个人模型调用分布", exact: true }).getByText("Nano2 · 多图参考", { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, "personal-charts-desktop.png") });
    await drawer.getByLabel("生成请求 qa-record-1", { exact: true }).locator("summary").click();
    await drawer.getByLabel("生成请求 qa-record-1", { exact: true }).getByText("保留针织纹理，只将领口调整为圆领；联系方式 [已脱敏]。", { exact: true }).waitFor();
    assert.equal(await drawer.getByLabel("操作事件 qa-record-3", { exact: true }).getByText("提示词", { exact: true }).count(), 0);
    await drawer.getByLabel("采集缺口 qa-record-5", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "02-person-detail.png") });
    await drawer.locator(".ant-pagination-item-2").click();
    await drawer.getByLabel("生成请求 qa-record-21", { exact: true }).waitFor();
    if (detailOnly) {
        await page.setViewportSize({ width: 390, height: 844 });
        await settleDrawer();
        await drawer.locator(".ant-drawer-body").evaluate(element => { element.scrollTop = 0; });
        await page.screenshot({ path: path.join(output, "personal-charts-mobile-top.png") });
        await drawer.getByRole("region", { name: "个人模型调用分布", exact: true }).evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.screenshot({ path: path.join(output, "personal-charts-mobile-distributions.png") });
        assert.ok(await drawer.locator(".ant-drawer-body").evaluate(element => element.scrollWidth <= element.clientWidth + 1));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
        await page.getByRole("region", { name: "操作控件分布", exact: true }).evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await page.screenshot({ path: path.join(output, "main-controls-mobile.png") });
        assert.equal(count("/analyze"), 0); assert.equal(count("/analysis-preview"), 0);
        assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.unexpectedWrites, []);
        check("Personal summary and three charts use intentionally distinct per-person data (4 requests, 2 missing events), never overall totals (15 requests, 4 missing events); controls also appear on the overview.");
        check("390px drawer and overview control distribution render without horizontal overflow; detail pagination preserves personal charts; no model/preview calls.");
        report.completedAt = new Date().toISOString(); report.passed = true;
        return;
    }
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    check("Person drawer separates prompts, parameters and interaction/gap records; 45-record history paginates beyond the first 20.");

    const table = page.getByRole("region", { name: "用户使用列表", exact: true });
    await table.getByRole("row").filter({ has: page.getByRole("button", { name: "张三", exact: true }) }).getByRole("checkbox").check();
    await table.locator(".ant-pagination-item-2").click();
    await page.getByRole("button", { name: "设计师 21", exact: true }).waitFor();
    await table.getByRole("row").filter({ has: page.getByRole("button", { name: "设计师 21", exact: true }) }).getByRole("checkbox").check();
    await download(page.getByRole("button", { name: "导出选中（2）", exact: true }), ["qa-person-1", "qa-person-21"], "selected-complete.jsonl");
    await download(table.getByRole("row").filter({ has: page.getByRole("button", { name: "设计师 21", exact: true }) }).getByRole("button", { name: /^单\s*人$/ }), ["qa-person-21"], "single-complete.jsonl");
    await page.getByLabel("搜索使用分析用户", { exact: true }).fill("张三");
    assert.equal(await page.getByRole("button", { name: "导出全员完整记录", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await page.getByRole("button", { name: "张三", exact: true }).waitFor();
    await download(page.getByRole("button", { name: "导出全员完整记录", exact: true }), undefined, "all-complete.jsonl");
    check("Actual browser downloads preserve manifest, all 45 rows and completion marker for cross-page multi-select, single-user and all-user exports; all ignores name search explicitly.");

    exportMode = "incomplete";
    let badDownloads = 0; const onBadDownload = () => { badDownloads++; }; page.on("download", onBadDownload);
    await page.getByRole("button", { name: "导出全员完整记录", exact: true }).click();
    await page.getByRole("button", { name: "开始导出完整记录", exact: true }).click();
    await page.getByText(/未收到完整结束标记/).waitFor();
    assert.equal(badDownloads, 0);
    await page.getByRole("button", { name: /^返\s*回$/ }).click();
    exportMode = "delay";
    await page.getByRole("button", { name: "导出全员完整记录", exact: true }).click();
    await page.getByRole("button", { name: "开始导出完整记录", exact: true }).click();
    await page.getByRole("button", { name: "取消导出", exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(badDownloads, 0); page.off("download", onBadDownload); exportMode = "success";
    check("Missing completion and user cancellation create no browser download and never report successful export.");

    await page.getByRole("button", { name: "导出全员完整记录", exact: true }).click();
    await select("使用记录保存方式", "选择保存位置（可选择桌面，适合大文件）");
    await page.getByRole("button", { name: "开始导出完整记录", exact: true }).click();
    await page.getByText(/已完整导出 45 条记录/).waitFor();
    const picker = await page.evaluate(() => window.__usageQaPicker);
    assert.equal(picker.opens.length, 1); assert.equal(picker.opens[0].startIn, "desktop"); assert.equal(picker.closes, 1); assert.equal(picker.aborts, 0);
    assert.ok(picker.chunks.length > 0);
    check("Save-location adapter uses a user-invoked browser picker with Desktop as suggestion and closes only complete output (OS picker itself stubbed; browser download tested for real).");

    await select("使用分析文字模型", "配置的文字分析模型 · 汇总工作流程");
    await page.getByRole("button", { name: "预览将发送的汇总", exact: true }).click();
    await page.getByTestId("usage-analysis-preview").waitFor();
    assert.equal(count("/analyze"), 0);
    const defaultBody = report.requests.filter(request => request.pathname.endsWith("/analysis-preview")).at(-1).input;
    assert.equal(defaultBody.includePromptSamples, false); assert.equal(defaultBody.userIds, undefined);
    const previewText = await page.getByTestId("usage-analysis-preview").innerText();
    assert.equal(previewText.includes("张三"), false); assert.equal(previewText.includes("保留针织纹理"), false); assert.equal(previewText.includes("data:image"), false);
    const submit = page.getByRole("button", { name: "发送已预览汇总 · 手动分析", exact: true });
    await submit.evaluate(element => { element.click(); element.click(); });
    await page.getByRole("region", { name: "使用分析结果", exact: true }).waitFor();
    assert.equal(count("/analyze"), 1);
    assert.deepEqual(report.requests.find(request => request.pathname.endsWith("/analyze")).input, { previewId: "qa-preview-1", previewHash: "frozen-1", modelConfigId: "qa-text-model", confirm: true });
    assert.equal(await submit.isDisabled(), true);
    await page.screenshot({ path: path.join(output, "03-manual-analysis.png"), fullPage: true });
    check("Manual analysis defaults to anonymous aggregates, displays exact preview text, sends only frozen preview ID/hash to configured text model, and blocks duplicate clicks/reuse.");

    await page.getByRole("checkbox", { name: "额外包含少量已脱敏提示词摘要（可选，可能仍含业务信息）", exact: true }).check();
    assert.equal(await page.getByTestId("usage-analysis-preview").count(), 0);
    await page.getByRole("button", { name: "预览将发送的汇总", exact: true }).click();
    await page.getByTestId("usage-analysis-preview").waitFor();
    assert.ok((await page.getByTestId("usage-analysis-preview").innerText()).includes("已脱敏摘要"));
    analysisMode = "delay";
    await submit.click(); await page.getByRole("button", { name: "取消等待分析", exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(count("/analyze"), 2); assert.equal(await submit.isDisabled(), true);
    await page.getByText(/若请求已提交给供应商，仍可能产生费用/).waitFor();
    check("Optional redacted samples require renewed preview; cancelling analysis warns about potential submitted cost and never retries the consumed preview.");

    listMode = "failure";
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await page.getByText("使用分析服务暂不可用，请稍后手动重试。", { exact: true }).waitFor();
    assert.equal((await page.locator("body").innerText()).includes("private-upstream-text"), false);
    listMode = "success";
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await page.getByRole("button", { name: "张三", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="应用筛选"]')?.classList.contains("ant-btn-loading"));
    await page.getByRole("button", { name: "切换到深色主题", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.magicuiThemeVt);
    await page.getByRole("button", { name: "张三", exact: true }).click();
    await drawer.getByLabel("生成请求 qa-record-1", { exact: true }).locator("summary").click();
    await page.screenshot({ path: path.join(output, "04-dark-detail.png") });
    await page.keyboard.press("Escape"); await drawer.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "切换到浅色主题", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.magicuiThemeVt);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "使用分析", exact: true }).evaluate(element => element.closest("header").scrollIntoView({ block: "start", behavior: "instant" }));
    await page.screenshot({ path: path.join(output, "04-mobile-overview.png"), fullPage: true });
    await page.getByRole("region", { name: "手动模型分析", exact: true }).evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.screenshot({ path: path.join(output, "05-mobile-analysis.png"), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "390px viewport must not have page-level horizontal overflow");
    check("Service failures show safe messages and recover on manual retry; 390px mobile layout has no page-level horizontal overflow.");

    for (const nextRole of ["department_admin", "designer"]) {
        role = nextRole;
        const before = report.requests.length;
        await page.reload();
        await page.waitForLoadState("networkidle");
        assert.equal(await page.getByRole("navigation", { name: "管理板块", exact: true }).getByRole("link", { name: "使用分析", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "导出全员完整记录", exact: true }).count(), 0);
        assert.equal(report.requests.length, before);
    }
    check("Department admins and designers cannot expose the tab or issue usage-admin reads through a forged URL.");
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.unexpectedWrites, []); assert.deepEqual(report.external, []);
    report.completedAt = new Date().toISOString(); report.passed = true;
} catch (error) {
    report.passed = false; report.error = error.stack;
    report.failureButtons = await page.locator("button").evaluateAll(buttons => buttons.filter(button => button.textContent?.includes("开始导出")).map(button => ({ text: button.textContent, html: button.outerHTML, hiddenAncestors: [...(function* () { let element = button; while (element) { yield element; element = element.parentElement; } })()].filter(element => element.hasAttribute("aria-hidden") || element.hasAttribute("inert")).map(element => ({ tag: element.tagName, class: element.className, ariaHidden: element.getAttribute("aria-hidden"), inert: element.hasAttribute("inert") })) }))).catch(() => []);
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => undefined);
    await fs.writeFile(path.join(output, "failure-dom.txt"), await page.locator("body").innerText().catch(() => ""));
    throw error;
} finally {
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await browser.close();
}
}
await verify();
