// From web/: bun build scripts/mark-new-models-browser-qa.mjs --target=node --packages=external --outfile=../output/mark-new-models-qa/runner.mjs
// Then: node ../output/mark-new-models-qa/runner.mjs [--live-catalog] [--enable-grok] [--only 01-mj-workbench]
// Isolated Chrome only. All application writes, uploads, and paid endpoints are fulfilled locally.
// --enable-grok opts into Grok only in the browser mock, after the default catalog passes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models.ts";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog.ts";
import { presentPublicModel, selectCreativeModels } from "../../server/src/model-presentation.ts";

const { chromium } = createRequire(path.resolve(process.cwd(), "../labs/design-workbench/package.json"))("playwright");
const origin = "http://127.0.0.1:5190";
const output = path.resolve(process.cwd(), "../output/mark-new-models-qa");
const liveCatalog = process.argv.includes("--live-catalog"), enableGrok = process.argv.includes("--enable-grok");
await fs.mkdir(output, { recursive: true });
const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const rawModels = [
  ...["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].map((modelId, index) => ({ id: `10000000-0000-4000-8000-00000000000${index + 1}`, name: modelId, modelId, providerName: "OpenToken", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 })),
  ...MARK_PLATFORM_MODELS.map((model, index) => ({ ...model, id: `d5000000-0000-4000-8000-00000000000${index + 1}`, providerId: MARK_IMAGE_PROVIDER_ID, providerName: "APIMart 平台", protocol: "apimart", creditCost: 0, rmbCost: 0 })),
];
let business = { models: selectCreativeModels(rawModels.filter(model => model.defaultEnabled !== false)).map(model => presentPublicModel(model, "designer")), prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) };
let modules = { modules: moduleDefinitions.map(module => ({ moduleKey: module.moduleKey, enabled: true })) };
if (liveCatalog) {
  const modelsResponse = await fetch("http://127.0.0.1:3101/api/models");
  const modulesResponse = await fetch("http://127.0.0.1:3101/api/modules");
  assert.equal(modelsResponse.status, 200); assert.equal(modulesResponse.status, 200);
  business = await modelsResponse.json(); modules = await modulesResponse.json();
}
const report = { startedAt: new Date().toISOString(), scope: "Real Chrome UI. Only optional catalog GETs go to isolated localhost 3101; every browser API request, upload, paid task/chat/batch POST, external HTTP request and WebSocket is isolated or blocked.", catalogSource: liveCatalog ? "read-only live 3101 catalog (unfiltered)" : "production projection with fixture IDs; default-disabled entries excluded after UUID assignment", catalog: business.models.map(({ id, modelId, name, publicDescription, imageParameterProfile, imageSupportsMask, imageSupportsOfficialFallback, capabilities }) => ({ id, modelId, name, publicDescription, imageParameterProfile, imageSupportsMask, imageSupportsOfficialFallback, capabilities })), grokOptIn: { requested: enableGrok, enabled: false, scope: "explicit isolated browser mock only; no real backend configuration writes" }, scenarios: [], submissions: [], paidOther: [], uploads: [], unexpectedWrites: [], externalRequests: [], errors: [] };
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, serviceWorkers: "block" });
await context.routeWebSocket("**/*", socket => socket.close());
const page = await context.newPage(); page.setDefaultTimeout(15000);
page.on("pageerror", error => report.errors.push(error.message));
const assets = new Map(), tasks = new Map(); let nextAsset = 0, nextTask = 0;
const makeTask = input => {
  const id = `e8000000-0000-4000-8000-${String(++nextTask).padStart(12, "0")}`;
  const resultId = `f8000000-0000-4000-8000-${String(nextTask).padStart(12, "0")}`;
  assets.set(resultId, fixture);
  const task = { ...input, id, status: "success", ownerUserId: "new-models-qa", resultUrls: [`/api/assets/${resultId}/content`], failureReason: null, createdAt: new Date().toISOString() };
  tasks.set(id, task); return task;
};
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
  if (!["http:", "https:"].includes(url.protocol)) return route.continue();
  if (url.origin !== origin) { report.externalRequests.push({ pathname, method }); return route.abort("blockedbyclient"); }
  if (!pathname.startsWith("/api/")) return ["GET", "HEAD"].includes(method) ? route.continue() : route.abort("blockedbyclient");
  const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  if (pathname === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
  if (pathname === "/api/auth/session") return json({ user: { id: "new-models-qa", username: "qa", displayName: "新增模型隔离 QA", role: "designer", status: "active", mustChangePassword: false, creditBalance: 999, avatarUrl: "", departmentId: null, groupId: null } });
  if (pathname === "/api/models") return json(business);
  if (pathname === "/api/modules") return json(modules);
  if (pathname === "/api/assets/upload-request" && method === "POST") {
    const id = `a8000000-0000-4000-8000-${String(++nextAsset).padStart(12, "0")}`;
    report.uploads.push({ id, ...request.postDataJSON() }); return json({ assetId: id, uploadUrl: `/api/assets/${id}/content-upload` });
  }
  const asset = /^\/api\/assets\/([^/]+)\/(content|content-upload)$/.exec(pathname);
  if (asset && method === "PUT") { assets.set(asset[1], request.postDataBuffer()); return json({}); }
  if (asset && method === "GET") return route.fulfill({ status: 200, contentType: "image/png", body: assets.get(asset[1]) || fixture });
  if (pathname === "/api/tasks" && method === "POST") { const input = request.postDataJSON(); report.submissions.push(input); return json({ task: makeTask(input) }, 201); }
  if (method === "POST" && /^\/api\/(tasks|chat|batch)(\/|$)/.test(pathname)) { report.paidOther.push({ pathname, input: request.postDataJSON() }); return json({ message: "Paid endpoint blocked by isolated browser QA" }, 409); }
  if (pathname === "/api/tasks" && method === "GET") return json({ tasks: [...tasks.values()] });
  if (pathname.startsWith("/api/tasks/") && method === "GET") return json({ task: tasks.get(pathname.split("/").at(-1)) });
  if (pathname === "/api/projects/sync") return json({ project: { id: "qa-project" } });
  if (!["GET", "HEAD"].includes(method)) { report.unexpectedWrites.push({ pathname, method }); return json({ message: "Unknown write blocked; no upstream request" }, 403); }
  return json({ code: 0, data: [], items: [], assets: [], projects: [], documents: [], history: [], tasks: [], total: 0 });
});
const waitUntil = async predicate => { const deadline = Date.now() + 20000; while (!await predicate()) { if (Date.now() > deadline) throw new Error("QA condition timed out"); await new Promise(resolve => setTimeout(resolve, 40)); } };
const modelByName = name => { const found = business.models.find(model => model.name === name); assert.ok(found, `Model not available: ${name}`); return found; };
const modelLabel = model => model.publicDescription?.trim() ? `${model.name} · ${model.publicDescription.trim()}` : model.name;
// Exact complete labels prevent gpt2 from accidentally matching gpt2.5 variants.
const modelOption = name => page.getByRole("option", { name: modelLabel(modelByName(name)), exact: true });
const selectModel = async (name, scope = page) => {
  await scope.locator(".canvas-composer-model-picker").first().click();
  await modelOption(name).click();
};
const pickerLabel = async (scope = page) => scope.locator(".canvas-composer-model-picker").first().innerText();
const uploadWorkbench = async count => {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "上传图片", exact: true }).click()]);
  await chooser.setFiles(Array.from({ length: count }, (_, index) => ({ name: `qa-reference-${nextAsset}-${index + 1}.png`, mimeType: "image/png", buffer: fixture })));
};
const referenceCount = async () => page.getByRole("region", { name: "参考图", exact: true }).locator("img").count();
const newCanvas = async () => {
  await page.goto(`${origin}/canvas`);
  await page.getByRole("button", { name: "新建画布", exact: true }).first().click();
  const panel = page.getByTestId("canvas-quick-generate-panel"); await panel.waitFor(); return panel;
};
const uploadCanvas = async (panel, count) => {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), panel.getByRole("button", { name: "添加参考图", exact: true }).click()]);
  await chooser.setFiles(Array.from({ length: count }, (_, index) => ({ name: `qa-canvas-reference-${nextAsset}-${index + 1}.png`, mimeType: "image/png", buffer: fixture })));
};
const canvasReferenceCount = panel => panel.locator(".cw-reference-remove").count();
const canvasNodes = async () => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wireless-canvas"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    const key = JSON.stringify(["wireless-canvas:canvas_store:project-documents:v1", location.pathname.split("/").at(-1)]);
    const stored = await new Promise((resolve, reject) => { const request = db.transaction("app_state", "readonly").objectStore("app_state").get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return (JSON.parse(stored || "{}").nodes || []).map(node => ({ id: node.id, title: node.title, type: node.type, metadata: Object.fromEntries(Object.entries(node.metadata || {}).filter(([key]) => !["content", "compareSources"].includes(key))) }));
  } finally { db.close(); }
});
const recipeProject = async () => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wireless-canvas"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    return await new Promise((resolve, reject) => { const request = db.transaction("series_recipe_workspaces", "readonly").objectStore("series_recipe_workspaces").get("project:new-models-qa"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  } finally { db.close(); }
});
const noQuantityControl = async (scope = page) => {
  assert.equal(await scope.getByLabel("生成张数", { exact: true }).count(), 0);
  assert.equal(await scope.getByRole("button", { name: "增加生成张数", exact: true }).count(), 0);
};
const capture = async name => {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: "disabled" });
  await fs.writeFile(path.join(output, `${name}.txt`), await page.locator("body").innerText());
};
const scenario = async (name, run, { always = false, skipReason } = {}) => {
  const only = process.argv.indexOf("--only"); if (!always && only >= 0 && process.argv[only + 1] !== name) return;
  if (skipReason) { report.scenarios.push({ name, status: "skipped", reason: skipReason }); return; }
  const item = { name, status: "running" }; report.scenarios.push(item); console.log(`New models QA: ${name}`);
  try { await run(item); await page.waitForLoadState("networkidle"); item.status = "passed"; }
  catch (error) { item.status = "failed"; item.error = String(error); console.log(item.error); }
  await capture(name);
  return item;
};
try {
  const defaultCatalog = await scenario("00-default-catalog", async item => {
    await page.goto(`${origin}/image`); await page.getByLabel("图像提示词", { exact: true }).waitFor();
    await page.locator(".canvas-composer-model-picker").first().click();
    await modelOption("gpt-image-2").waitFor();
    item.options = await page.getByRole("option").allTextContents();
    item.grokPresentInCatalog = business.models.some(model => model.name === "aplmart-grok2");
    assert.equal(item.grokPresentInCatalog, false, "Default-catalog validation is invalid: Grok is already enabled in the supplied catalog; the live catalog was not silently filtered");
    assert.equal(await page.getByRole("option", { name: /^aplmart-grok2(?: ·|$)/ }).count(), 0);
    for (const model of MARK_PLATFORM_MODELS.filter(model => model.defaultEnabled !== false)) {
      assert.ok(business.models.some(item => item.name === model.name), `Default catalog missing ${model.name}`);
    }
    const available = business.models.filter(model => !model.modelId.startsWith("demo-") && model.capabilities.some(capability => ["generate", "edit"].includes(capability)));
    for (const model of available) assert.ok(model.publicDescription?.trim(), `Missing public usage description: ${model.name}`);
    assert.deepEqual([...item.options].sort(), available.map(modelLabel).sort(), "Every visible image option must show its complete name and usage");
    await page.keyboard.press("Escape");
    item.selections = [];
    for (const model of available) {
      await selectModel(model.name);
      assert.equal(await pickerLabel(), modelLabel(model));
      const selectedId = await page.evaluate(() => JSON.parse(localStorage.getItem("wireless-canvas:ai_config_store")).state.config.imageModel);
      assert.equal(selectedId, model.modelId, `Usage label changed the selected model identifier: ${model.name}`);
      item.selections.push({ name: model.name, id: model.id, modelId: model.modelId, label: modelLabel(model), selectedId });
    }
    await selectModel("gpt-image-2");
    await page.locator(".canvas-composer-model-picker").first().click();
    item.defaultGrokAbsent = true; item.usageLabelsPreserveModelIds = true;
  }, { always: true });
  let grokSkipReason = "Grok is default-disabled; pass --enable-grok for explicitly isolated Grok QA";
  if (enableGrok && defaultCatalog.status === "passed") {
    const rawGrok = rawModels.find(model => model.name === "aplmart-grok2");
    assert.ok(rawGrok, "Grok fixture is missing from the full catalog");
    const grok = presentPublicModel(rawGrok, "designer");
    business = { ...business, models: [...business.models, grok] };
    report.grokOptIn = { ...report.grokOptIn, enabled: true, enabledAfter: defaultCatalog.name, model: grok };
    grokSkipReason = undefined;
  } else if (enableGrok) {
    grokSkipReason = "Explicit Grok opt-in was not applied because default-catalog validation failed";
  }
  report.grokOptIn.reason = grokSkipReason || "Explicitly enabled only in intercepted /api/models responses after the default catalog passed";
  await scenario("00-legacy-count-normalization", async item => {
    item.cases = [];
    for (const [legacyCount, modelName] of [["3", "gpt-image-2"], ["10", "aplmart-gpt2"]]) {
      await page.goto(`${origin}/image`); await page.getByLabel("图像提示词", { exact: true }).waitFor();
      await selectModel(modelName);
      await page.evaluate(count => {
        const key = "wireless-canvas:ai_config_store", stored = JSON.parse(localStorage.getItem(key));
        stored.state.config.count = count; stored.state.config.canvasImageCount = count;
        localStorage.setItem(key, JSON.stringify(stored));
      }, legacyCount);
      await page.reload(); await page.getByLabel("图像提示词", { exact: true }).waitFor();
      await noQuantityControl(); await page.getByText("1 个任务", { exact: true }).first().waitFor();
      await page.getByLabel("图像提示词", { exact: true }).fill(`QA legacy ${legacyCount} normalizes to one image`);
      const generate = page.getByRole("button", { name: "开始生成", exact: true }), before = report.submissions.length;
      await generate.click(); await waitUntil(() => report.submissions.length === before + 1); await waitUntil(async () => await generate.isEnabled());
      await page.waitForLoadState("networkidle"); assert.equal(report.submissions.length, before + 1);
      const payload = report.submissions.at(-1); assert.equal(payload.parameters.count, 1);
      assert.equal(payload.modelConfigId, modelByName(modelName).id);
      item.cases.push({ seededLegacyCount: legacyCount, modelName, taskPosts: 1, outboundCount: payload.parameters.count, quantityControlsAbsent: true });
    }
  });
  await scenario("01-mj-workbench", async item => {
    await page.goto(`${origin}/image`);
    await page.getByLabel("图像提示词", { exact: true }).waitFor();
    await selectModel("gpt-image-2");
    const beforeLabel = await pickerLabel();
    await noQuantityControl();
    await page.goto(`${origin}/image?tool=midjourney-blend`);
    await page.getByRole("heading", { name: "MJ 多图融合", exact: true }).waitFor();
    await waitUntil(async () => (await pickerLabel()) === modelLabel(modelByName("aplmart-mj-blend")));
    assert.equal(await page.getByLabel("图像提示词", { exact: true }).count(), 0);
    await page.locator(".canvas-composer-model-picker").first().click();
    const options = await page.getByRole("option").allTextContents();
    assert.deepEqual(options, [modelLabel(modelByName("aplmart-mj-blend"))]);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByLabel("生成张数", { exact: true }).count(), 0);
    await page.getByText("1 个任务", { exact: true }).first().waitFor();
    const generate = page.getByRole("button", { name: "开始融合", exact: true });
    const states = [];
    states.push({ references: 0, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, true);
    await uploadWorkbench(1); await waitUntil(async () => await referenceCount() === 1);
    states.push({ references: 1, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, true);
    await uploadWorkbench(1); await waitUntil(async () => await referenceCount() === 2);
    states.push({ references: 2, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, false);
    const submitTwo = report.submissions.length; await generate.click();
    await waitUntil(() => report.submissions.length === submitTwo + 1);
    await waitUntil(async () => await generate.isEnabled());
    const two = report.submissions.at(-1);
    assert.equal(two.modelConfigId, modelByName("aplmart-mj-blend").id); assert.equal(two.toolKey, "midjourney-blend");
    assert.equal(two.operationType, "image_generation"); assert.equal(two.sourceUrls.length, 2); assert.equal(two.parameters.count, 1);
    await uploadWorkbench(2); await waitUntil(async () => await referenceCount() === 4);
    states.push({ references: 4, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, false);
    const submitFour = report.submissions.length; await generate.click();
    await waitUntil(() => report.submissions.length === submitFour + 1); await waitUntil(async () => await generate.isEnabled());
    const four = report.submissions.at(-1); assert.equal(four.sourceUrls.length, 4); assert.equal(four.parameters.count, 1);
    await uploadWorkbench(1); await waitUntil(async () => await referenceCount() === 5);
    states.push({ references: 5, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, true);
    await capture("01-mj-five-reference-guard");
    item.referenceStates = states; item.payloads = [two, four]; item.options = options;
    await page.goto(`${origin}/image`); await page.getByLabel("图像提示词", { exact: true }).waitFor();
    await waitUntil(async () => (await pickerLabel()) === modelLabel(modelByName("gpt-image-2")));
    assert.equal(await pickerLabel(), beforeLabel, "Visiting the dedicated Blend page must not replace the prior global image-model selection");
    item.globalModelUnchanged = true;
  });
  await scenario("02-gpt2-channel-isolation", async item => {
    await page.goto(`${origin}/image`); await page.getByLabel("图像提示词", { exact: true }).waitFor();
    await page.locator(".canvas-composer-model-picker").first().click();
    const labels = await page.getByRole("option").allTextContents();
    for (const name of ["gpt-image-2", "aplmart-gpt2", "aplmart-gpt2.5-flare", "aplmart-gpt2.5-sunburst"]) {
      assert.equal(await modelOption(name).count(), 1);
    }
    await page.keyboard.press("Escape");
    const oldModel = modelByName("gpt-image-2"), nextModel = modelByName("aplmart-gpt2");
    assert.notEqual(oldModel.id, nextModel.id); assert.notEqual(oldModel.modelId, nextModel.modelId);
    await selectModel("gpt-image-2");
    await noQuantityControl();
    await page.getByLabel("图像提示词", { exact: true }).fill("QA 旧 OpenToken 渠道 UUID 隔离检查");
    const generate = page.getByRole("button", { name: "开始生成", exact: true });
    let before = report.submissions.length; await generate.click(); await waitUntil(() => report.submissions.length === before + 1); await waitUntil(async () => await generate.isEnabled());
    const oldPayload = report.submissions.at(-1); assert.equal(oldPayload.modelConfigId, oldModel.id);
    await selectModel("aplmart-gpt2");
    const resolution = page.getByRole("group", { name: "分辨率", exact: true });
    assert.deepEqual(await resolution.getByRole("button").allTextContents(), ["1K", "2K", "4K"]);
    await resolution.getByRole("button", { name: "4K", exact: true }).click();
    await page.getByLabel("宽高比", { exact: true }).selectOption("1:1");
    assert.equal(await page.getByLabel("图片质量", { exact: true }).count(), 0);
    await page.getByLabel("图像提示词", { exact: true }).fill("QA 新 APIMart GPT2 分辨率与 UUID 隔离检查");
    before = report.submissions.length; await generate.click(); await waitUntil(() => report.submissions.length === before + 1); await waitUntil(async () => await generate.isEnabled());
    const nextPayload = report.submissions.at(-1); assert.equal(nextPayload.modelConfigId, nextModel.id);
    assert.equal(nextPayload.parameters.resolution, "4k"); assert.equal(Object.hasOwn(nextPayload.parameters, "quality"), false); assert.equal(nextPayload.parameters.count, 1);
    item.options = labels; item.oldPayload = oldPayload; item.apimartPayload = nextPayload;
  });
  await scenario("02b-nano2-official", async item => {
    await page.goto(`${origin}/image`); await page.getByLabel("图像提示词", { exact: true }).waitFor();
    const nano = modelByName("aplmart-nano2");
    assert.equal(nano.imageParameterProfile, "resolution");
    assert.equal(nano.imageSupportsMask, false);
    assert.equal(nano.imageSupportsOfficialFallback, false);
    assert.equal(Object.hasOwn(nano, "parameterModelId"), false);
    assert.match(nano.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(nano.modelId, nano.id);
    await selectModel(nano.name);
    assert.equal(await pickerLabel(), modelLabel(nano));
    assert.equal(await page.locator(".canvas-composer-model-picker").first().getAttribute("title"), modelLabel(nano));
    const resolution = page.getByRole("group", { name: "分辨率", exact: true });
    assert.deepEqual(await resolution.getByRole("button").allTextContents(), ["0.5K", "1K", "2K", "4K"]);
    assert.equal(await page.getByLabel("图片质量", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("清晰度 / 分辨率", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("允许官方渠道回退", { exact: true }).count(), 0);
    await resolution.getByRole("button", { name: "0.5K", exact: true }).click();
    assert.equal(await resolution.getByRole("button", { name: "0.5K", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByLabel("宽高比", { exact: true }).selectOption("1:1");
    await noQuantityControl();
    await page.getByLabel("图像提示词", { exact: true }).fill("QA Nano2 官方版 0.5K 参数与 UUID 隔离检查");
    const generate = page.getByRole("button", { name: "开始生成", exact: true }), before = report.submissions.length;
    await generate.click(); await waitUntil(() => report.submissions.length === before + 1); await waitUntil(async () => await generate.isEnabled());
    const payload = report.submissions.at(-1);
    assert.equal(payload.modelConfigId, nano.id); assert.equal(payload.parameters.resolution, "0.5k"); assert.equal(payload.parameters.count, 1);
    assert.equal(Object.hasOwn(payload.parameters, "quality"), false); assert.equal(Object.hasOwn(payload.parameters, "official_fallback"), false);
    item.model = nano; item.selectedLabel = await pickerLabel(); item.resolutionOptions = ["0.5K", "1K", "2K", "4K"]; item.payload = payload;
    item.qualityControlAbsent = true; item.officialFallbackControlAbsent = true; item.maskSupported = false;
  });
  await scenario("03-grok-reference-quality", async item => {
    await page.goto(`${origin}/image`); await page.getByLabel("图像提示词", { exact: true }).waitFor();
    await selectModel("aplmart-grok2");
    const quality = page.getByLabel("图片质量", { exact: true });
    assert.deepEqual(await quality.locator("option").evaluateAll(options => options.map(option => option.value)), ["low", "medium"]);
    await quality.selectOption("low");
    const resolution = page.getByLabel("清晰度 / 分辨率", { exact: true });
    assert.deepEqual(await resolution.locator("option").evaluateAll(options => options.map(option => option.value)), ["1k", "2k"]);
    await resolution.selectOption("2k"); await page.getByLabel("宽高比", { exact: true }).selectOption("9:19.5");
    await noQuantityControl();
    await page.getByLabel("图像提示词", { exact: true }).fill("QA Grok quality 仅文生图生效");
    const generate = page.getByRole("button", { name: "开始生成", exact: true });
    let before = report.submissions.length; await generate.click(); await waitUntil(() => report.submissions.length === before + 1); await waitUntil(async () => await generate.isEnabled());
    const textPayload = report.submissions.at(-1);
    assert.equal(textPayload.modelConfigId, modelByName("aplmart-grok2").id); assert.equal(textPayload.parameters.quality, "low"); assert.equal(textPayload.parameters.resolution, "2k"); assert.equal(textPayload.parameters.size, "9:19.5");
    await uploadWorkbench(1); await waitUntil(async () => await referenceCount() === 1);
    await page.getByText("参考图模式不提交 quality；移除全部参考图后可设置图片质量。", { exact: true }).waitFor();
    assert.equal(await quality.count(), 0);
    before = report.submissions.length; await generate.click(); await waitUntil(() => report.submissions.length === before + 1); await waitUntil(async () => await generate.isEnabled());
    const referencePayload = report.submissions.at(-1);
    assert.equal(referencePayload.modelConfigId, modelByName("aplmart-grok2").id); assert.equal(referencePayload.sourceUrls.length, 1);
    assert.equal(Object.hasOwn(referencePayload.parameters, "quality"), false); assert.equal(Object.hasOwn(referencePayload.parameters.inputArchive.parameters, "quality"), false); assert.equal(referencePayload.parameters.resolution, "2k");
    await uploadWorkbench(2); await waitUntil(async () => await referenceCount() === 3); assert.equal(await generate.isEnabled(), true); assert.equal(await quality.count(), 0);
    await capture("03-grok-three-references-quality-hidden");
    await uploadWorkbench(1); await waitUntil(async () => await referenceCount() === 4); assert.equal(await generate.isDisabled(), true);
    item.textPayload = textPayload; item.referencePayload = referencePayload; item.maxReferences = 3; item.qualityHiddenForReferences = true;
  }, { skipReason: grokSkipReason });
  await scenario("04-canvas-blend", async item => {
    const panel = await newCanvas(); await selectModel("aplmart-mj-blend", panel);
    assert.equal(await panel.getByLabel("描述图像", { exact: true }).count(), 0);
    const generate = panel.getByRole("button", { name: "开始融合", exact: true });
    const states = [{ references: 0, disabled: await generate.isDisabled() }]; assert.equal(states.at(-1).disabled, true);
    await panel.getByRole("button", { name: /生成设置/ }).click();
    await panel.getByText("1 个任务", { exact: true }).waitFor();
    assert.equal(await panel.getByLabel("生成张数", { exact: true }).count(), 0);
    await panel.getByRole("group", { name: "生成速度", exact: true }).getByRole("button", { name: "极速", exact: true }).click();
    await panel.getByLabel("比例预设", { exact: true }).selectOption("LANDSCAPE");
    assert.equal(await panel.getByLabel("宽高比", { exact: true }).inputValue(), "3:2");
    await panel.getByLabel("自定义宽高比", { exact: true }).fill("7:5"); await panel.getByLabel("自定义宽高比", { exact: true }).blur();
    assert.equal(await panel.getByLabel("比例预设", { exact: true }).inputValue(), "LANDSCAPE");
    await uploadCanvas(panel, 1); await waitUntil(async () => await canvasReferenceCount(panel) === 1);
    states.push({ references: 1, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, true);
    await uploadCanvas(panel, 1); await waitUntil(async () => await canvasReferenceCount(panel) === 2);
    states.push({ references: 2, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, false);
    assert.equal(await pickerLabel(panel), modelLabel(modelByName("aplmart-mj-blend")));
    const before = report.submissions.length; await generate.click(); await waitUntil(() => report.submissions.length === before + 1);
    const payload = report.submissions.at(-1);
    assert.equal(payload.modelConfigId, modelByName("aplmart-mj-blend").id); assert.equal(payload.toolKey, "canvas-image"); assert.equal(payload.operationType, "image_generation");
    assert.equal(payload.sourceUrls.length, 2); assert.equal(payload.parameters.count, 1); assert.equal(payload.parameters.midjourneySpeed, "turbo"); assert.equal(payload.parameters.dimensions, "LANDSCAPE"); assert.equal(payload.parameters.size, "7:5");
    await waitUntil(async () => (await canvasNodes()).some(node => node.metadata.status === "success"));
    await uploadCanvas(panel, 2); await waitUntil(async () => await canvasReferenceCount(panel) === 4);
    states.push({ references: 4, disabled: await generate.isDisabled() }); assert.equal(states.at(-1).disabled, false);
    assert.equal(await panel.getByRole("button", { name: "添加参考图", exact: true }).isDisabled(), true);
    await selectModel("gpt-image-2", panel); await uploadCanvas(panel, 1); await waitUntil(async () => await canvasReferenceCount(panel) === 5);
    await panel.locator(".canvas-composer-model-picker").first().click();
    assert.equal(await modelOption("aplmart-mj-blend").count(), 0);
    await page.keyboard.press("Escape");
    states.push({ references: 5, mode: "edit-only", blendSelectable: false });
    item.referenceStates = states; item.payload = payload; item.nodes = await canvasNodes();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture("04-canvas-mobile"); await page.setViewportSize({ width: 1512, height: 1100 });
  });
  await scenario("04b-canvas-grok-reference", async item => {
    const panel = await newCanvas(); await selectModel("aplmart-grok2", panel);
    await panel.getByRole("button", { name: /生成设置/ }).click();
    await panel.getByLabel("图片质量", { exact: true }).selectOption("low");
    await panel.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("2k");
    await noQuantityControl(panel);
    await panel.getByLabel("描述图像", { exact: true }).fill("QA Canvas Grok 参考图模式仅保留2K不传quality");
    await uploadCanvas(panel, 1); await waitUntil(async () => await canvasReferenceCount(panel) === 1);
    await panel.getByText("参考图模式不提交 quality；移除全部参考图后可设置图片质量。", { exact: true }).waitFor();
    assert.equal(await panel.getByLabel("图片质量", { exact: true }).count(), 0);
    const before = report.submissions.length; await panel.getByRole("button", { name: "生成修改图", exact: true }).click();
    await waitUntil(() => report.submissions.length === before + 1); const payload = report.submissions.at(-1);
    assert.equal(payload.modelConfigId, modelByName("aplmart-grok2").id); assert.equal(payload.toolKey, "canvas-edit"); assert.equal(payload.operationType, "inpaint");
    assert.equal(payload.sourceUrls.length, 1); assert.equal(payload.parameters.resolution, "2k"); assert.equal(Object.hasOwn(payload.parameters, "quality"), false);
    await waitUntil(async () => (await canvasNodes()).some(node => node.metadata.status === "success"));
    item.payload = payload; item.nodes = await canvasNodes();
    item.inactiveSavedQualityAllowed = true;
  }, { skipReason: grokSkipReason });
  await scenario("05-mobile-model-parameters", async item => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/image?tool=midjourney-blend`);
    await page.getByRole("heading", { name: "MJ 多图融合", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.getByRole("button", { name: "参数", exact: true }).click();
    let drawer = page.getByRole("dialog", { name: "参数", exact: true }); await drawer.waitFor();
    await drawer.getByLabel("比例预设", { exact: true }).selectOption("LANDSCAPE");
    assert.equal(await drawer.getByLabel("宽高比", { exact: true }).inputValue(), "3:2");
    await drawer.getByLabel("自定义宽高比", { exact: true }).fill("7:5");
    await drawer.getByLabel("自定义宽高比", { exact: true }).blur();
    assert.equal(await drawer.getByLabel("宽高比", { exact: true }).inputValue(), "7:5");
    assert.equal(await drawer.getByLabel("比例预设", { exact: true }).inputValue(), "LANDSCAPE");
    await drawer.getByRole("group", { name: "生成速度", exact: true }).getByRole("button", { name: "极速", exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture("05-mobile-mj-parameters");
    if (!grokSkipReason) {
      await page.goto(`${origin}/image`); await page.getByRole("heading", { name: "文生图", exact: true }).waitFor();
      await page.getByRole("button", { name: "参数", exact: true }).click();
      drawer = page.getByRole("dialog", { name: "参数", exact: true }); await drawer.waitFor();
      await selectModel("aplmart-grok2", drawer);
      await drawer.getByLabel("图片质量", { exact: true }).selectOption("medium");
      await drawer.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("2k");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await capture("05-mobile-grok-parameters");
      item.grok = { status: "passed", explicitIsolatedOptIn: true };
    } else item.grok = { status: "skipped", reason: grokSkipReason };
    item.width = 390; item.noHorizontalOverflow = true; item.blendDimensions = "LANDSCAPE"; item.blendSize = "7:5"; item.blendSpeed = "turbo";
    await page.setViewportSize({ width: 1512, height: 1100 });
  });
  await scenario("06-batch-multiple-files-guard", async item => {
    await newCanvas();
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "批量改图", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "批量一键改图", exact: true }); await modal.waitFor();
    await noQuantityControl(modal);
    await modal.locator(".canvas-composer-model-picker").first().click();
    assert.equal(await modelOption("aplmart-mj-blend").count(), 0, "Generate-only Blend must be excluded from edit-only batch");
    // Escape also closes the containing Ant Design modal; select an allowed entry instead.
    await modelOption("gpt-image-2").click();
    const beforeUploads = report.uploads.length, beforeTasks = report.submissions.length, beforeOther = report.paidOther.length;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), modal.getByRole("button", { name: "选择 1 张图片", exact: true }).click()]);
    assert.equal(chooser.isMultiple(), false);
    await assert.rejects(chooser.setFiles([{ name: "multi-a.png", mimeType: "image/png", buffer: fixture }, { name: "multi-b.png", mimeType: "image/png", buffer: fixture }]), /multiple|single|Non-multiple/i);
    // Explicitly exercise the component boundary as a synthetic two-file change event.
    // The native single-file chooser already rejects this selection; no actual upload is sent.
    await (await chooser.element()).evaluate((input, base64) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0)), transfer = new DataTransfer();
      for (const name of ["multi-a.png", "multi-b.png"]) transfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    }, fixture.toString("base64"));
    await page.getByText("每次只能处理 1 张图片，请重新选择 1 张；原列表未改变。", { exact: true }).waitFor();
    await modal.getByText("待处理图片 0 张", { exact: true }).waitFor();
    await modal.getByRole("button", { name: "一键生图", exact: true }).click();
    await page.getByText("每次只能处理 1 张图片，请选择 1 张图片；已有多图列表请先清空后重新选择。", { exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(report.uploads.length, beforeUploads); assert.equal(report.submissions.length, beforeTasks); assert.equal(report.paidOther.length, beforeOther);
    item.nativeChooserMultiple = false; item.syntheticTwoFileChangeRejected = true; item.newUploads = 0; item.newTaskPosts = 0; item.blendExcludedFromEditOnly = true;
  });
  await scenario("07-series-single-and-legacy", async item => {
    await page.goto(`${origin}/creative/series-recipe`); await page.getByRole("heading", { name: "系列配方", exact: true }).waitFor();
    await page.getByLabel("上传参考底图（必需）", { exact: true }).setInputFiles({ name: "series-source.png", mimeType: "image/png", buffer: fixture });
    await page.getByText("模型与出图设置", { exact: true }).click(); await selectModel("aplmart-gpt2"); await noQuantityControl();
    await page.locator(".canvas-composer-model-picker").first().click();
    assert.equal(await modelOption("aplmart-mj-blend").count(), 0);
    await page.keyboard.press("Escape");
    let before = report.submissions.length; await page.getByRole("button", { name: /运行配方/ }).click();
    await waitUntil(() => report.submissions.length === before + 1);
    await waitUntil(async () => (await recipeProject())?.run?.branches?.[0]?.status === "success");
    let saved = await recipeProject(); assert.equal(saved.form.count, 1); assert.equal(saved.run.form.count, 1); assert.equal(saved.run.branches.length, 1); assert.equal(report.submissions.length, before + 1); assert.equal(report.submissions.at(-1).parameters.count, 1);
    item.newRun = { formCount: saved.form.count, branchCount: saved.run.branches.length, taskPosts: 1, payload: report.submissions.at(-1) };
    const oldImage = { id: "legacy-result-keep", name: "legacy-candidate-keep.png", type: "image/png", dataUrl: `data:image/png;base64,${fixture.toString("base64")}` };
    const oldReference = { ...oldImage, id: "legacy-source", name: "legacy-source.png" }, oldForm = { ...saved.form, count: 3 };
    const oldSettings = { ...saved.settings, count: "3" };
    const legacy = { version: 1, kind: "series-recipe", ownerId: "new-models-qa", form: oldForm, references: [oldReference], settings: oldSettings, run: { id: "legacy-series-run", ownerId: "new-models-qa", createdAt: "2026-10-14T01:00:00.000Z", form: oldForm, references: [oldReference], settings: oldSettings, branches: [0, 1, 2].map(index => ({ id: `variant-${index + 1}`, index, prompt: `Legacy branch ${index + 1}`, status: index ? "waiting" : "success", attempts: index ? 0 : 1, taskIds: [], submissionStarted: !index, images: index ? [] : [oldImage], selected: !index, error: "" })) } };
    page.once("dialog", dialog => dialog.accept());
    await page.getByLabel("导入系列配方项目", { exact: true }).setInputFiles({ name: "legacy-three-candidates.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy)) });
    await page.getByText("项目已导入。候选图片已保留，未完成任务不会自动重发。", { exact: true }).waitFor();
    saved = await recipeProject(); assert.equal(saved.form.count, 1); assert.equal(saved.run.form.count, 3); assert.equal(saved.run.branches.length, 3); assert.deepEqual(saved.run.branches[0].images, [oldImage]); assert.equal(saved.run.branches[0].selected, true);
    item.legacySteps = [];
    for (let index = 1; index < 3; index++) {
      before = report.submissions.length; await page.getByRole("button", { name: new RegExp(`继续未提交分支 \\(${3 - index}\\)`) }).click();
      await waitUntil(() => report.submissions.length === before + 1);
      await waitUntil(async () => (await recipeProject()).run.branches[index].status === "success");
      await page.waitForLoadState("networkidle"); saved = await recipeProject();
      assert.equal(report.submissions.length, before + 1); assert.equal(saved.run.branches.length, 3); assert.deepEqual(saved.run.branches[0].images, [oldImage]); assert.equal(saved.run.branches[0].selected, true); assert.equal(report.submissions.at(-1).parameters.count, 1);
      if (index === 1) assert.equal(saved.run.branches[2].status, "waiting");
      item.legacySteps.push({ click: index, newTaskPosts: 1, statuses: saved.run.branches.map(branch => branch.status), oldCandidateRetained: true });
    }
    item.blendExcludedFromEditOnly = true; item.oldCandidateImageId = oldImage.id;
  });
  assert.deepEqual(report.paidOther, []);
  assert.deepEqual(report.unexpectedWrites, []);
  assert.deepEqual(report.errors, []);
} finally {
  report.completedAt = new Date().toISOString(); report.success = report.scenarios.some(item => item.status === "passed") && report.scenarios.every(item => ["passed", "skipped"].includes(item.status)) && !report.errors.length && !report.unexpectedWrites.length && !report.paidOther.length;
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
  console.log(JSON.stringify({ success: report.success, grokOptIn: report.grokOptIn, scenarios: report.scenarios.map(({ name, status, error, reason }) => ({ name, status, error, reason })), interceptedGenerationPosts: report.submissions.length, upstreamCalls: 0 }));
  if (!report.success) process.exitCode = 1;
}
