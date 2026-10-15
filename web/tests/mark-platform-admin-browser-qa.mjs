// Run with Node (not Bun): node tests/mark-platform-admin-browser-qa.mjs
// This is a browser integration check with complete API isolation; it never uses provider credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { MARK_IMAGE_BASE_URL, MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models.ts";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog.ts";

const { chromium } = createRequire(new URL("../../labs/design-workbench/package.json", import.meta.url))("playwright");
const origin = "http://127.0.0.1:5188";
const realAdminIndex = process.argv.indexOf("--real-admin");
const realAdmin = realAdminIndex >= 0 ? process.argv[realAdminIndex + 1] : "";
if (realAdminIndex >= 0 && realAdmin !== "http://127.0.0.1:3102") throw new Error("Only the explicitly authorized isolated QA API at http://127.0.0.1:3102 is allowed");
const fixtureKey = "fixture-mark-browser-qa";
const output = fileURLToPath(new URL(`../../output/mark-platform-admin-qa${realAdmin ? "/real-api" : ""}`, import.meta.url));
await fs.mkdir(output, { recursive: true });
const report = { scope: realAdmin ? "Real admin UI to formal API backed by isolated PostgreSQL/PGlite at loopback 3102; other APIs mocked, all provider/external traffic blocked." : "Real admin UI with all APIs mocked and external traffic blocked; zero provider calls.", checks: [], saves: [], apiResponses: [], unexpectedWrites: [], blockedExternal: [], pageErrors: [] };
let role = "super_admin", initialModelIds;
const legacyConfiguration = () => ({
    provider: { id: MARK_IMAGE_PROVIDER_ID, name: "APIMart 平台", protocol: "apimart", baseUrl: MARK_IMAGE_BASE_URL, enabled: true, hasCredentials: true },
    models: MARK_PLATFORM_MODELS.slice(0, 5).map((model, index) => ({ ...model, id: `qa-model-${index}`, enabled: true, creditCost: index === 0 ? 11 : index === 3 ? 2 : 0, rmbCost: index === 3 ? 0.0123 : 0, concurrencyLimit: index === 3 ? 3 : 2 })),
});
let config = realAdmin ? legacyConfiguration() : { provider: null, models: [] };
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, serviceWorkers: "block" });
await context.routeWebSocket("**/*", socket => socket.close());
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", error => report.pageErrors.push(error.message));
await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { report.blockedExternal.push({ pathname, method }); return route.abort("blockedbyclient"); }
    if (!pathname.startsWith("/api/")) return ["GET", "HEAD"].includes(method) ? route.continue() : route.abort("blockedbyclient");
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    if (pathname === "/api/auth/session") return json({ user: { id: "mark-platform-admin-qa", username: "qa", displayName: "隔离后台QA", role, status: "active", mustChangePassword: false, creditBalance: 999, avatarUrl: "", departmentId: null, groupId: null } });
    if (realAdmin && ["/api/admin/model-configuration/mark-images", "/api/admin/model-configuration/tool-configurations", "/api/models", "/api/modules"].includes(pathname)) {
        const upstream = await route.fetch({ url: `${realAdmin}${pathname}`, headers: { ...request.headers(), "x-qa-role": role }, maxRedirects: 0 });
        const body = await upstream.json();
        assert.equal(JSON.stringify(body).includes(fixtureKey), false, "Response must not expose the fixture credential");
        assert.equal(/fixture-mark-[a-zA-Z0-9-]+/.test(JSON.stringify(body)), false, "Response must not expose any fixture credential");
        assert.equal(JSON.stringify(body).includes("encrypted_credentials"), false, "Response must not expose encrypted credentials");
        report.apiResponses.push({ pathname, method, status: upstream.status(), modelIds: body.models?.map(model => model.id), providerId: body.provider?.id });
        if (pathname.endsWith("mark-images") && upstream.ok()) {
            config = body;
            initialModelIds ||= config.models.map(model => model.id).sort();
            if (method === "PUT") { const input = request.postDataJSON(); report.saves.push({ ...input, apiKey: input.apiKey ? "[fixture-redacted]" : undefined }); }
        }
        return route.fulfill({ response: upstream });
    }
    if (pathname === "/api/models") return json({ models: [], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) });
    if (pathname === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
    if (pathname === "/api/admin/model-configuration/mark-images") {
        if (method === "PUT") {
            const input = request.postDataJSON();
            report.saves.push({ ...input, apiKey: input.apiKey ? "[fixture-redacted]" : undefined });
            config = { provider: { id: MARK_IMAGE_PROVIDER_ID, name: "APIMart 平台", protocol: "apimart", ...config.provider, baseUrl: input.baseUrl, enabled: input.enabled, hasCredentials: Boolean(input.apiKey || config.provider?.hasCredentials) }, models: input.models.map((model, index) => ({ ...MARK_PLATFORM_MODELS[index], ...model, id: `qa-model-${index}` })) };
        }
        return json(config);
    }
    if (!["GET", "HEAD"].includes(method)) { report.unexpectedWrites.push({ pathname, method }); return json({ message: "Unimplemented mock; no real request sent" }, 403); }
    return json({ code: 0, data: [], users: [], departments: [], auditLogs: [], history: [], tasks: [], projects: [], documents: [], assets: [], totalRmbCost: 0, total: 0 });
});
const waitUntil = async predicate => {
    const until = Date.now() + 15000;
    while (!predicate()) { if (Date.now() > until) throw new Error("Mock save was not observed"); await new Promise(resolve => setTimeout(resolve, 25)); }
};
try {
    assert.equal(MARK_PLATFORM_MODELS.length, 9);
    if (!realAdmin) {
        await page.goto(`${origin}/admin?tab=mark-images`);
        await page.getByText("服务端密钥未配置", { exact: true }).waitFor();
        const defaults = [];
        for (const model of MARK_PLATFORM_MODELS) {
            const enabled = await page.getByLabel(`启用 ${model.name}`, { exact: true }).getAttribute("aria-checked") === "true";
            assert.equal(enabled, model.defaultEnabled);
            assert.equal((await page.getByLabel(`${model.name} 用途`, { exact: true }).innerText()).trim(), `用途：${model.description}`);
            defaults.push({ modelId: model.modelId, enabled, usage: model.description });
        }
        assert.deepEqual(defaults.filter(model => !model.enabled).map(model => model.modelId), ["grok-imagine-image-2.0"]);
        await page.getByLabel("APIMart API Key", { exact: true }).fill(fixtureKey);
        await page.getByRole("button", { name: "保存 APIMart 平台配置", exact: true }).click();
        await waitUntil(() => report.saves.length === 1);
        assert.equal(report.saves[0].models.find(model => model.modelId === "grok-imagine-image-2.0").enabled, false);
        assert.equal(report.saves[0].models.find(model => model.modelId === "gemini-3.1-flash-image-preview-official").enabled, true);
        await page.waitForFunction(() => document.getElementById("apiKey")?.value === "");
        await page.getByLabel(`启用 ${MARK_PLATFORM_MODELS.find(model => model.modelId === "grok-imagine-image-2.0").name}`, { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, "fresh-defaults-grok-nano2.png") });
        report.freshConfigurationDefaults = { defaults, savedModelCount: report.saves[0].models.length, grokSavedDisabled: true, nano2SavedEnabled: true };
        report.checks.push("A completely unconfigured admin form displays all nine usage descriptions and saves only Grok disabled by default; Nano2 and all other presets default enabled.");
        report.saves.length = 0;
        config = legacyConfiguration();
    }
    await page.goto(`${origin}/admin?tab=mark-images`);
    await page.getByRole("heading", { name: "APIMart 平台 · 独立 API 配置", exact: true }).waitFor();
    await page.getByText("服务端密钥已配置", { exact: true }).waitFor();
    for (const name of ["图片模型", "文字模型", "视频模型", "多图融合"]) await page.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal(await page.getByRole("spinbutton").count(), MARK_PLATFORM_MODELS.length * 3);
    const existingImageCredits = config.models.find(model => model.modelId === MARK_PLATFORM_MODELS[0].modelId).creditCost;
    assert.equal(await page.getByLabel(`${MARK_PLATFORM_MODELS[0].name} 站内积分`, { exact: true }).inputValue(), String(existingImageCredits));
    assert.equal(await page.getByLabel("APIMart API Key", { exact: true }).inputValue(), "");
    const textModel = MARK_PLATFORM_MODELS.find(model => model.modelId === "gpt-6-astra");
    const videoModel = MARK_PLATFORM_MODELS.find(model => model.modelId === "happyhorse-1.1");
    const blendModel = MARK_PLATFORM_MODELS.find(model => model.modelId === "midjourney-blend");
    const nano2Model = MARK_PLATFORM_MODELS.find(model => model.modelId === "gemini-3.1-flash-image-preview-official");
    const grokModel = MARK_PLATFORM_MODELS.find(model => model.modelId === "grok-imagine-image-2.0");
    const gpt2Model = MARK_PLATFORM_MODELS.find(model => model.modelId === "gpt-image-2");
    assert.ok(textModel && videoModel && blendModel && nano2Model && grokModel && gpt2Model);
    for (const model of MARK_PLATFORM_MODELS) assert.equal((await page.getByLabel(`${model.name} 用途`, { exact: true }).innerText()).trim(), `用途：${model.description}`);
    assert.ok(gpt2Model.description.includes("日常最通用"));
    const initialGrokEnabled = config.models.find(model => model.modelId === grokModel.modelId)?.enabled ?? grokModel.defaultEnabled;
    assert.equal(await page.getByLabel(`启用 ${grokModel.name}`, { exact: true }).getAttribute("aria-checked") === "true", initialGrokEnabled);
    await page.getByText("Midjourney Blend：上传 2–4 张参考图进行融合，无需提示词。", { exact: true }).waitFor();
    const storedText = config.models.find(model => model.modelId === textModel.modelId);
    const textValues = { creditCost: storedText?.creditCost ?? 0, rmbCost: storedText?.rmbCost ?? 0, concurrencyLimit: storedText?.concurrencyLimit ?? 2 };
    const textToggle = page.getByLabel(`启用 ${textModel.name}`, { exact: true });
    if (await textToggle.getAttribute("aria-checked") === "true") await textToggle.click();
    for (const label of ["站内积分", "内部成本", "并发上限"]) assert.equal(await page.getByLabel(`${textModel.name} ${label}`, { exact: true }).isDisabled(), true);
    await page.getByText("文字模型当前仅配置接入与开关；站内计费/并发限制尚未执行，供应商仍按实际请求计费。", { exact: true }).waitFor();
    await page.getByLabel(`${videoModel.name} 站内积分`, { exact: true }).fill("25");
    await page.getByLabel(`${videoModel.name} 内部成本`, { exact: true }).fill("0.6");
    await page.getByLabel(`${videoModel.name} 并发上限`, { exact: true }).fill("1");
    const blendToggle = page.getByLabel(`启用 ${blendModel.name}`, { exact: true });
    if (await blendToggle.getAttribute("aria-checked") === "true") await blendToggle.click();
    await page.getByLabel(`${blendModel.name} 站内积分`, { exact: true }).fill("13");
    await page.getByLabel(`${blendModel.name} 内部成本`, { exact: true }).fill("0.4");
    await page.getByLabel(`${blendModel.name} 并发上限`, { exact: true }).fill("3");
    const imageGroup = page.locator('[aria-labelledby="mark-model-group-image"]');
    for (const addedImage of MARK_PLATFORM_MODELS.slice(6)) {
        assert.equal(addedImage.capabilities.includes("generate"), true);
        await imageGroup.getByText(addedImage.name, { exact: true }).waitFor();
        assert.equal(await imageGroup.getByLabel(`${addedImage.name} 站内积分`, { exact: true }).isDisabled(), false);
    }
    await page.getByLabel(`${nano2Model.name} 站内积分`, { exact: true }).fill("8");
    await page.getByLabel(`${nano2Model.name} 内部成本`, { exact: true }).fill("0.25");
    await page.getByLabel(`${nano2Model.name} 并发上限`, { exact: true }).fill("5");
    await page.getByRole("button", { name: "保存 APIMart 平台配置", exact: true }).click();
    await waitUntil(() => report.saves.length === 1);
    assert.equal(report.saves[0].apiKey, undefined);
    assert.deepEqual(report.saves[0].models.map(model => model.modelId), MARK_PLATFORM_MODELS.map(model => model.modelId));
    assert.deepEqual(report.saves[0].models.find(model => model.modelId === "gpt-6-astra"), { modelId: "gpt-6-astra", enabled: false, ...textValues });
    assert.deepEqual(report.saves[0].models.find(model => model.modelId === "happyhorse-1.1"), { modelId: "happyhorse-1.1", enabled: true, creditCost: 25, rmbCost: 0.6, concurrencyLimit: 1 });
    assert.deepEqual(report.saves[0].models.find(model => model.modelId === "midjourney-blend"), { modelId: "midjourney-blend", enabled: false, creditCost: 13, rmbCost: 0.4, concurrencyLimit: 3 });
    assert.deepEqual(report.saves[0].models.find(model => model.modelId === nano2Model.modelId), { modelId: nano2Model.modelId, enabled: true, creditCost: 8, rmbCost: 0.25, concurrencyLimit: 5 });
    assert.equal(report.saves[0].models.find(model => model.modelId === grokModel.modelId).enabled, initialGrokEnabled);
    const persistedModelIds = config.models.map(model => model.id).sort();
    assert.equal(new Set(persistedModelIds).size, MARK_PLATFORM_MODELS.length);
    if (realAdmin) assert.equal(initialModelIds.every(id => persistedModelIds.includes(id)), true, "Adding new presets must preserve existing configuration UUIDs");
    report.checks.push(`All ${MARK_PLATFORM_MODELS.length} models save exact identities and display usage; GPT2 is labelled the everyday general-purpose model; GPT2/Grok2/Nano2 stay in the image group, Nano2 has independent cost/concurrency, and explicitly saved Grok enabled state is preserved.`);
    await page.getByText("APIMart 平台配置已保存到服务端，未发起生成请求", { exact: true }).waitFor();
    await blendToggle.click();
    await page.getByLabel("APIMart API Key", { exact: true }).fill(fixtureKey);
    await page.getByRole("button", { name: "保存 APIMart 平台配置", exact: true }).click();
    await waitUntil(() => report.saves.length === 2);
    await page.waitForFunction(() => document.getElementById("apiKey")?.value === "");
    assert.equal(report.saves[1].apiKey, "[fixture-redacted]");
    assert.deepEqual(report.saves[1].models.find(model => model.modelId === "midjourney-blend"), { modelId: "midjourney-blend", enabled: true, creditCost: 13, rmbCost: 0.4, concurrencyLimit: 3 });
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(storage.includes(fixtureKey), false);
    report.checks.push("Replacing a fixture key clears the input after save and does not persist it to browser storage.");
    if (realAdmin) {
        await page.reload();
        await page.getByText("服务端密钥已配置", { exact: true }).waitFor();
        assert.equal(Number(await page.getByLabel(`${textModel.name} 内部成本`, { exact: true }).inputValue()), textValues.rmbCost);
        assert.equal(await page.getByLabel(`${textModel.name} 并发上限`, { exact: true }).inputValue(), String(textValues.concurrencyLimit));
        assert.equal(await page.getByLabel(`${videoModel.name} 并发上限`, { exact: true }).inputValue(), "1");
        assert.equal(await page.getByLabel(`${blendModel.name} 并发上限`, { exact: true }).inputValue(), "3");
        assert.equal(await page.getByLabel(`${nano2Model.name} 并发上限`, { exact: true }).inputValue(), "5");
        assert.equal(Number(await page.getByLabel(`${nano2Model.name} 内部成本`, { exact: true }).inputValue()), 0.25);
        assert.equal(await page.getByLabel(`启用 ${grokModel.name}`, { exact: true }).getAttribute("aria-checked") === "true", initialGrokEnabled);
        assert.deepEqual(config.models.map(model => model.id).sort(), persistedModelIds);
        assert.equal(new Set(config.models.map(model => model.id)).size, MARK_PLATFORM_MODELS.length);
        assert.equal(config.provider.hasCredentials, true);
        const publicModels = await page.evaluate(() => fetch("/api/models").then(response => response.json()));
        assert.equal(publicModels.models.some(model => model.id === config.models.find(item => item.modelId === "gpt-6-astra").id), false);
        const enabledModels = config.models.filter(model => model.enabled);
        assert.equal(publicModels.models.filter(model => persistedModelIds.includes(model.id)).length, enabledModels.length);
        assert.equal(publicModels.models.some(model => model.id === config.models.find(item => item.modelId === nano2Model.modelId).id), true);
        assert.equal(publicModels.models.some(model => model.id === config.models.find(item => item.modelId === grokModel.modelId).id), initialGrokEnabled);
        const publicMjTool = publicModels.tools.find(tool => tool.toolKey === "midjourney-blend");
        assert.equal(publicMjTool?.enabled, true);
        assert.ok(publicMjTool?.configurationVersion >= 1, "MJ must use a persisted tool binding, not the version-0 catalog fallback");
        const modules = await page.evaluate(() => fetch("/api/modules").then(response => response.json()));
        assert.equal(modules.modules.find(module => module.moduleKey === "midjourney-blend")?.enabled, true);
        const toolConfigurations = await page.evaluate(() => fetch("/api/admin/model-configuration/tool-configurations").then(response => response.json()));
        const adminMjTool = toolConfigurations.tools.find(tool => tool.toolKey === "midjourney-blend");
        assert.equal(adminMjTool.configurationVersion, publicMjTool.configurationVersion);
        assert.equal(adminMjTool.modelConfigId, publicMjTool.modelConfigId);
        report.mjModuleBinding = { moduleEnabled: true, modelConfigId: publicMjTool.modelConfigId, configurationVersion: publicMjTool.configurationVersion };
        report.checks.push("Formal module and model APIs expose the migrated MJ module and the same persisted, versioned tool binding.");
        report.checks.push(`Real API/database reload preserves all ${MARK_PLATFORM_MODELS.length} unique model UUIDs, per-model values, credential presence, and public filtering for disabled text model.`);
    }
    await page.getByRole("heading", { name: "APIMart 平台 · 独立 API 配置", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "desktop-top.png"), fullPage: true });
    await page.getByRole("heading", { name: "视频模型", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "desktop-text-video.png"), fullPage: true });
    await page.getByRole("heading", { name: "多图融合", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "desktop-blend.png") });
    await page.getByLabel(`${nano2Model.name} 用途`, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "desktop-nano2-usage.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel(`${nano2Model.name} 用途`, { exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: path.join(output, "mobile-nano2-usage.png") });
    await page.getByRole("heading", { name: "文字模型", exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: path.join(output, "mobile-text-video.png"), fullPage: true });
    await page.getByRole("heading", { name: "多图融合", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "mobile-blend.png") });
    report.checks.push("Desktop and 390px mobile views render grouped controls without page-level horizontal overflow.");
    if (realAdmin) {
        role = "designer";
        const denied = await page.evaluate(async input => ({
            read: (await fetch("/api/admin/model-configuration/mark-images")).status,
            write: (await fetch("/api/admin/model-configuration/mark-images", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status,
        }), { ...report.saves[0], apiKey: undefined });
        assert.deepEqual(denied, { read: 403, write: 403 });
        report.checks.push("Formal API rejects designer GET and PUT with HTTP 403; forbidden request does not add a successful save.");
        role = "super_admin";
        const saved = await page.evaluate(() => fetch("/api/admin/model-configuration/mark-images").then(response => response.json()));
        assert.deepEqual(saved.models.map(model => model.id).sort(), persistedModelIds);
        assert.equal(report.saves.length, 2);
    }
    assert.deepEqual(report.unexpectedWrites, []);
    assert.deepEqual(report.pageErrors, []);
    report.checks.push("No unexpected writes, provider requests, or page errors.");
    report.success = true;
    console.log(JSON.stringify({ success: true, checks: report.checks, saves: report.saves.length }));
} catch (error) {
    report.success = false;
    report.failure = String(error);
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
} finally {
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await context.close();
    await browser.close();
}
