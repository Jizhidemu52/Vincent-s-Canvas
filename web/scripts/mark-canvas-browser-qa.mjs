// From web/: bun build scripts/mark-canvas-browser-qa.mjs --target=node --packages=external --outfile=../output/mark-canvas-qa/runner.mjs
// Then: node ../output/mark-canvas-qa/runner.mjs. Every API request is fulfilled locally; no real provider calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog.ts";
import { MARK_IMAGE_MODELS, MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models.ts";
import { presentPublicModel, selectCreativeModels } from "../../server/src/model-presentation.ts";

const { chromium } = createRequire(path.resolve(process.cwd(), "../labs/design-workbench/package.json"))("playwright");
const { zipSync, strToU8 } = createRequire(path.resolve(process.cwd(), "package.json"))("fflate");
const origin = "http://127.0.0.1:5188";
const output = path.resolve(process.cwd(), "../output/mark-canvas-qa");
const garmentPath = path.resolve(process.cwd(), "../output/mark-provider-live/image-knit-A-1.png");
const garment = await fs.readFile(garmentPath);
await fs.mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: "Isolated browser; all API HTTP requests mocked, all external HTTP/WebSocket traffic blocked; no provider calls.", input: garmentPath, scenarios: [], submissions: [], batches: [], chats: [], uploads: [], blocked: [], unhandled: [], errors: [], requestFailures: [] };
console.log("Canvas QA: launching browser");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
console.log("Canvas QA: browser launched");
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, serviceWorkers: "block", acceptDownloads: true });
console.log("Canvas QA: context created");
await context.routeWebSocket("**/*", socket => socket.close());
console.log("Canvas QA: websocket isolation ready");
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", error => report.errors.push(error.message));
const pendingRequests = new Set();
page.on("request", request => pendingRequests.add(new URL(request.url()).pathname));
page.on("requestfinished", request => pendingRequests.delete(new URL(request.url()).pathname));
page.on("requestfailed", request => { pendingRequests.delete(new URL(request.url()).pathname); report.requestFailures.push({ error: request.failure()?.errorText, pathname: new URL(request.url()).pathname, method: request.method(), at: new Date().toISOString() }); });
const models = [
  { id: "10000000-0000-4000-8000-000000000001", name: "OpenToken Flare", modelId: "gpt-image-2.5-flare", providerName: "OpenToken", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 },
  ...MARK_IMAGE_MODELS.map((model, i) => ({ ...model, id: `d5000000-0000-4000-8000-00000000000${i + 1}`, providerId: MARK_IMAGE_PROVIDER_ID, providerName: "Mark 出图", protocol: "apimart", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 })),
  { id: "d5000000-0000-4000-8000-000000000004", name: "aplmart-gpt6-astra", modelId: "gpt-6-astra", providerId: MARK_IMAGE_PROVIDER_ID, providerName: "Mark 平台", protocol: "apimart", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
  { id: "d5000000-0000-4000-8000-000000000005", name: "aplmart-happyhorse1.1", modelId: "happyhorse-1.1", providerId: MARK_IMAGE_PROVIDER_ID, providerName: "Mark 平台", protocol: "apimart", capabilities: ["video"], creditCost: 0, rmbCost: 0 },
];
const tasks = new Map(), assets = new Map();
let nextAsset = 0, nextTask = 0, resultBytes = garment;
const createTask = input => {
  const id = `e5000000-0000-4000-8000-${String(++nextTask).padStart(12, "0")}`;
  const resultId = `f5000000-0000-4000-8000-${String(nextTask).padStart(12, "0")}`;
  assets.set(resultId, resultBytes);
  const task = { ...input, id, status: "success", ownerUserId: "mark-canvas-qa", resultUrls: [`/api/assets/${resultId}/content`], failureReason: null, createdAt: new Date().toISOString() };
  tasks.set(id, task); return task;
};
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
  if (!["http:", "https:"].includes(url.protocol)) return route.continue();
  if (url.origin !== origin) { report.blocked.push({ url: request.url(), method }); return route.abort("blockedbyclient"); }
  if (!pathname.startsWith("/api/")) return ["GET", "HEAD"].includes(method) ? route.continue() : route.abort("blockedbyclient");
  const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  if (pathname === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
  if (pathname === "/api/auth/session") return json({ user: { id: "mark-canvas-qa", username: "qa", displayName: "隔离画布QA", role: "designer", status: "active", mustChangePassword: false, creditBalance: 999, avatarUrl: "", departmentId: null, groupId: null } });
  if (pathname === "/api/models") return json({ models: selectCreativeModels(models).map(model => presentPublicModel(model, "designer")), prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) });
  if (pathname === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
  if (pathname === "/api/generation-capabilities") return json({ models: [{ id: models[5].id, modelId: "happyhorse-1.1", name: models[5].name, capability: { minImages: 0, maxImages: 2, sizes: ["16:9", "9:16", "1:1", "4:3", "3:4"], seconds: [3, 15], resolutions: ["720p", "1080p"], supportsAudio: false } }] });
  if (pathname === "/api/chat/responses" && method === "POST") {
    const input = request.postDataJSON(); report.chats.push(input);
    if (input.input.some(item => item.type === "function_call_output")) return json({ content: "QA 模拟工具调用已完成。", toolCalls: [], stopReason: "stop" });
    return json({ content: "QA 将按已选图像参数生成。", toolCalls: [{ id: `qa-tool-${report.chats.length}`, type: "function", function: { name: "canvas_generate_image", arguments: JSON.stringify({ prompt: "QA Agent 图像设置实际提交测试，生成针织毛衣白底图", editIntent: "new" }) } }], stopReason: "tool_calls" });
  }
  if (pathname === "/api/assets/upload-request" && method === "POST") { const id = `a5000000-0000-4000-8000-${String(++nextAsset).padStart(12, "0")}`; report.uploads.push({ id, ...request.postDataJSON() }); return json({ assetId: id, uploadUrl: `/api/assets/${id}/content-upload` }); }
  const asset = /^\/api\/assets\/([^/]+)\/(content|content-upload)$/.exec(pathname);
  if (asset && method === "PUT") { assets.set(asset[1], request.postDataBuffer()); return json({}); }
  if (asset && method === "GET") return route.fulfill({ status: 200, contentType: "image/png", body: assets.get(asset[1]) || garment });
  if (pathname === "/api/tasks" && method === "POST") { const input = request.postDataJSON(); report.submissions.push(input); return json({ task: createTask(input) }, 201); }
  if (pathname === "/api/tasks" && method === "GET") return json({ tasks: [...tasks.values()] });
  if (pathname === "/api/tasks/batch" && method === "POST") { const input = request.postDataJSON(); report.batches.push(input); return json({ batchId: crypto.randomUUID(), tasks: input.items.map((item, itemIndex) => ({ ...createTask({ ...input, ...item }), itemIndex })), failures: [] }, 201); }
  if (pathname.startsWith("/api/tasks/") && method === "GET") return json({ task: tasks.get(pathname.split("/").at(-1)) });
  if (pathname === "/api/projects/sync") return json({ project: { id: "qa-project" } });
  if (!["GET", "HEAD"].includes(method)) { report.unhandled.push({ pathname, method }); return json({ message: "Unimplemented mock; real request blocked" }, 403); }
  return json({ code: 0, data: [], items: [], assets: [], projects: [], documents: [], history: [], tasks: [], total: 0 });
});
const waitUntil = async predicate => { const deadline = Date.now() + 20000; while (!await predicate()) { if (Date.now() > deadline) throw new Error("Canvas QA condition timed out"); await new Promise(resolve => setTimeout(resolve, 40)); } };
const chooseModel = async (scope, index) => {
  await scope.locator(".canvas-composer-model-picker").first().click();
  await page.getByRole("option", { name: new RegExp(MARK_IMAGE_MODELS[index].name.replaceAll(".", "\\.")) }).click();
};
const newCanvas = async () => {
  await page.goto(`${origin}/canvas`);
  await page.getByRole("button", { name: "新建画布", exact: true }).first().click();
  await page.getByLabel("描述图像", { exact: true }).waitFor();
};
const snapshot = async name => {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  await fs.writeFile(path.join(output, `${name}.txt`), await page.locator("body").innerText());
};
const projectState = async () => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const open = indexedDB.open("wireless-canvas"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  try {
    const key = JSON.stringify(["wireless-canvas:canvas_store:project-documents:v1", location.pathname.split("/").at(-1)]);
    const stored = await new Promise((resolve, reject) => { const request = db.transaction("app_state", "readonly").objectStore("app_state").get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const project = JSON.parse(stored || "{}");
    return {
      nodes: (project?.nodes || []).map(node => ({ id: node.id, title: node.title, type: node.type, metadata: Object.fromEntries(Object.entries(node.metadata || {}).filter(([key]) => !["content", "compareSources"].includes(key))) })),
      messages: (project?.chatSessions || []).flatMap(session => session.messages).map(message => ({ id: message.id, role: message.role, text: message.text, detail: message.detail?.mediaWorkflow ? { mediaWorkflow: message.detail.mediaWorkflow } : message.detail ? { kind: message.detail.kind, status: message.detail.status, settings: message.detail.settings, generationSettings: message.detail.generationSettings } : undefined })),
    };
  } finally { db.close(); }
});
const nodes = async () => (await projectState()).nodes;
const scenario = async (name, run) => {
  const selected = process.argv.indexOf("--only");
  if (selected >= 0 && process.argv[selected + 1] !== name) return;
  console.log(`Canvas QA: ${name}`);
  const item = { name, status: "running" }; report.scenarios.push(item);
  try { await run(item); await page.waitForLoadState("networkidle"); item.status = "passed"; }
  catch (error) { item.status = "failed"; item.error = String(error); item.pendingRequests = [...pendingRequests]; console.log(`${name}: ${item.error}`); }
  await snapshot(name);
  Object.assign(item, await projectState().catch(() => ({ nodes: [], messages: [] })));
};
try {
  await scenario("01-normal-generation", async item => {
    await newCanvas();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await chooseModel(panel, 0);
    await panel.getByRole("button", { name: /生成设置/ }).click();
    await panel.getByLabel("图片质量", { exact: true }).selectOption("max");
    await panel.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("4k");
    await panel.getByLabel("宽高比", { exact: true }).selectOption("1:1");
    await panel.getByLabel("生成张数", { exact: true }).press("Home");
    await panel.getByLabel("描述图像", { exact: true }).fill("QA画布普通生图 保留复杂针织结构");
    const count = report.submissions.length;
    await panel.getByRole("button", { name: "生成", exact: true }).click();
    await waitUntil(() => report.submissions.length === count + 1);
    item.payload = report.submissions.at(-1);
    assert.equal(item.payload.modelConfigId, models[1].id);
    assert.equal(item.payload.parameters.quality, "max");
    assert.equal(item.payload.parameters.resolution, "4k");
    await waitUntil(async () => (await nodes()).some(node => node.metadata.status === "success"));
  });
  await scenario("02-angle-generation", async item => {
    await newCanvas();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles(garmentPath);
    await page.locator("[data-node-id]").first().hover();
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "多角度", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "AI 多角度", exact: true }).waitFor();
    await chooseModel(dialog, 1);
    await dialog.getByLabel("图片质量", { exact: true }).selectOption("xhigh");
    await dialog.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("2k");
    const count = report.submissions.length;
    await dialog.getByRole("button", { name: "AI 生成", exact: true }).click();
    await waitUntil(() => report.submissions.length === count + 1);
    item.payload = report.submissions.at(-1);
    assert.equal(item.payload.modelConfigId, models[2].id);
    assert.equal(item.payload.parameters.quality, "xhigh");
    assert.equal(item.payload.parameters.resolution, "2k");
    await waitUntil(async () => (await nodes()).some(node => node.metadata.status === "success" && node.metadata.prompt));
  });
  await scenario("03-mask-exact-pixels", async item => {
    await newCanvas();
    const portrait = await page.evaluate(async dataUrl => { const image = new Image(); image.src = dataUrl; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = 768; canvas.height = 1024; canvas.getContext("2d").drawImage(image, 128, 0, 768, 1024, 0, 0, 768, 1024); return canvas.toDataURL("image/png"); }, `data:image/png;base64,${garment.toString("base64")}`);
    resultBytes = Buffer.from(portrait.split(",")[1], "base64");
    const portraitPath = path.join(output, "portrait-768x1024.png"); await fs.writeFile(portraitPath, resultBytes);
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await chooseModel(panel, 0);
    await panel.getByRole("button", { name: /生成设置/ }).click();
    await panel.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("4k");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles(portraitPath);
    await page.locator("[data-node-id]").first().hover();
    await page.getByRole("button", { name: "更多图片工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "局部重绘", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("输出尺寸锁定为原图 768 × 1024px", { exact: true }).waitFor();
    await chooseModel(dialog, 0);
    assert.equal(await dialog.getByLabel("清晰度 / 分辨率", { exact: true }).count(), 0);
    await dialog.getByLabel("图片质量", { exact: true }).selectOption("high");
    const box = await dialog.locator("canvas:visible").boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 12 }); await page.mouse.up();
    await dialog.getByPlaceholder("例如：把选中区域改成金属材质，保持原图光影").fill("QA只将涂抹处针织改为浅蓝，其他不变");
    const count = report.submissions.length;
    await dialog.getByRole("button", { name: "AI 修改", exact: true }).click();
    await waitUntil(() => report.submissions.length === count + 1);
    item.payload = report.submissions.at(-1);
    assert.equal(item.payload.modelConfigId, models[1].id);
    assert.equal(item.payload.parameters.size, "768x1024");
    assert.equal(item.payload.parameters.resolution, undefined);
    assert.equal(item.payload.parameters.quality, "high");
    assert.equal(item.payload.parameters.inputArchive.maskReferenceIndex, 1);
    assert.equal(item.payload.sourceUrls.length, 2);
    await waitUntil(async () => (await nodes()).some(node => node.metadata.status === "success" && node.metadata.prompt));
    resultBytes = garment;
  });
  await scenario("04-batch-generation", async item => {
    resultBytes = garment;
    await newCanvas();
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "批量改图", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await chooseModel(dialog, 2);
    assert.equal(await dialog.getByLabel("图片质量", { exact: true }).count(), 0);
    await dialog.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("2k");
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "选择多张图片", exact: true }).click();
    await (await chooser).setFiles([{ name: "A-knit.png", mimeType: "image/png", buffer: garment }, { name: "B-knit.png", mimeType: "image/png", buffer: garment }]);
    await dialog.getByPlaceholder("例如：白底图产品摄影，保留产品结构，提升质感和光影，适合电商详情页").fill("QA批量保留毛衣结构，只提高白底商品图清晰度");
    const count = report.batches.length;
    await dialog.getByRole("button", { name: "一键生图", exact: true }).click();
    await waitUntil(() => report.batches.length === count + 1);
    item.payload = report.batches.at(-1);
    assert.equal(item.payload.modelConfigId, models[3].id);
    assert.equal(item.payload.parameters.resolution, "2k");
    assert.equal(item.payload.parameters.quality, undefined);
    assert.equal(item.payload.items.length, 2);
    await waitUntil(async () => (await nodes()).filter(node => node.metadata.status === "success" && node.metadata.generationType === "edit").length === 2);
  });
  await scenario("05-assistant-generation", async item => {
    await newCanvas();
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    await page.getByPlaceholder("直接问当前画布上的内容…").waitFor({ timeout: 45000 });
    const agent = page.locator(".cw-agent-panel");
    await agent.getByTestId("canvas-agent-text-model").locator(".canvas-composer-model-picker").click();
    await page.getByRole("option", { name: /aplmart-gpt6-astra/ }).click();
    const imagePicker = agent.locator(".canvas-composer-model-picker").last();
    await imagePicker.click();
    await page.getByRole("option", { name: new RegExp(MARK_IMAGE_MODELS[1].name.replaceAll(".", "\\.")) }).click();
    await agent.getByRole("button", { name: "图像设置", exact: true }).click();
    await page.getByLabel("图片质量", { exact: true }).selectOption("max");
    await page.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("2k");
    await page.getByLabel("生成张数", { exact: true }).press("Home");
    await agent.getByRole("button", { name: "图像设置", exact: true }).click();
    await page.getByPlaceholder("直接问当前画布上的内容…").fill("QA生成一张复杂针织毛衣白底图");
    const count = report.submissions.length;
    await agent.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "批准执行", exact: true }).click();
    await waitUntil(() => report.submissions.length === count + 1);
    item.payload = report.submissions.at(-1);
    assert.equal(item.payload.modelConfigId, models[2].id);
    assert.equal(item.payload.parameters.quality, "max");
    assert.equal(item.payload.parameters.resolution, "2k");
    await waitUntil(async () => (await nodes()).some(node => node.metadata.status === "success" && node.metadata.prompt));
    const generated = (await nodes()).find(node => node.metadata.generationType === "generation");
    assert.ok(generated);
    assert.equal(generated.metadata.quality, "max");
    assert.equal(JSON.parse(generated.metadata.imageOptions).resolution, "2k");
  });
  await scenario("06-restored-workflow-card", async item => {
    const now = new Date().toISOString();
    const workflow = { id: "qa-imported-workflow", intent: "image_to_video", prompt: "QA工作流候选图，保留复杂针织毛衣结构", imageModel: models[1].id, videoModel: "happyhorse-1.1", imageCount: 1, imageQuality: "high", imageOptions: "{\"resolution\":\"1k\"}", videoSeconds: "5", aspectRatio: "1:1", referenceNodeIds: [], candidates: [], imageStatus: "idle", videoStatus: "idle" };
    const project = { id: "qa-workflow-project", title: "QA工作流恢复", createdAt: now, updatedAt: now, nodes: [], connections: [], chatSessions: [{ id: "qa-workflow-chat", title: "QA工作流对话", createdAt: now, updatedAt: now, messages: [{ id: "qa-workflow-message", role: "assistant", text: "QA导入既有工作流进行参数和按钮验收", detail: { mediaWorkflow: workflow } }] }], activeChatId: "qa-workflow-chat", backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    const archive = zipSync({ "projects.json": strToU8(JSON.stringify({ app: "wireless-canvas", version: 3, exportedAt: now, projects: [{ project, files: [] }] })) });
    const archivePath = path.join(output, "workflow-fixture.zip"); await fs.writeFile(archivePath, archive);
    item.entry = "Imported a synthetic existing-workflow archive through the normal Import Canvas button; does not claim natural-language creation of a new workflow.";
    await page.goto(`${origin}/canvas`);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入画布", exact: true }).click();
    await (await chooser).setFiles(archivePath);
    await page.getByRole("heading", { name: "QA工作流恢复", exact: true }).click();
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    const card = page.getByRole("region", { name: "图片转视频工作流", exact: true });
    await card.waitFor({ timeout: 45000 });
    await card.getByLabel("选择图片模型", { exact: true }).click();
    await page.getByRole("option", { name: MARK_IMAGE_MODELS[1].name, exact: true }).click();
    await card.getByLabel("选择视频模型", { exact: true }).click();
    await page.getByRole("option", { name: /happyhorse/ }).click();
    await card.getByLabel("图片质量", { exact: true }).selectOption("xhigh");
    await card.getByLabel("清晰度 / 分辨率", { exact: true }).selectOption("4k");
    await card.getByLabel("生成张数", { exact: true }).press("Home");
    const count = report.submissions.length;
    await card.getByRole("button", { name: "生成候选图", exact: true }).click();
    await waitUntil(() => report.submissions.length === count + 1);
    item.payload = report.submissions.at(-1);
    assert.equal(item.payload.modelConfigId, models[2].id);
    assert.equal(item.payload.parameters.quality, "xhigh");
    assert.equal(item.payload.parameters.resolution, "4k");
    await waitUntil(async () => (await projectState()).messages.some(message => message.detail?.mediaWorkflow?.imageStatus === "success"));
    await card.locator('label[for="qa-imported-workflow-candidate-1"]').click();
    assert.equal(await card.getByRole("radio", { name: "候选图 1", exact: true }).isChecked(), true);
    assert.equal(await card.getByRole("button", { name: "生成视频", exact: true }).isEnabled(), true);
  });
  console.log(JSON.stringify({ scenarios: report.scenarios.map(({ name, status, error }) => ({ name, status, error })), submissions: report.submissions.length, batches: report.batches.length, errors: report.errors, unhandled: report.unhandled }));
  if (report.scenarios.some(item => item.status !== "passed") || report.errors.length || report.unhandled.length) process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
}
