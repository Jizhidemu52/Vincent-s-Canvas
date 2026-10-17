/** Explicit authorized interactive paid QA. Never run in CI. Shared hard cap: 50. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(path.resolve('../labs/design-workbench/package.json'))('playwright');
const origin = process.env.MARK_QA_URL || 'http://127.0.0.1:5190';
const output = path.resolve('../output/mark-provider-live');
const ledgerPath = path.join(output, 'ledger.json');
const group = process.argv[2];
if (!['seed', 'boards', 'chat', 'video', 'new-images', 'blend', 'accessory-corrected', 'nano2'].includes(group)) throw Error('Choose an explicit paid QA group; no default paid execution');
const replayRequested = process.env.MARK_QA_CHAT_RETEST === 'replay-responses-plan';
if (replayRequested && group !== 'chat') throw Error('The paid-plan replay flag is only valid for the chat group');
const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
assert.equal(ledger.limit, 50);
const savedPlanReplay = replayRequested ? prepareChatPlanReplay(ledger) : null;
if (savedPlanReplay) {
  const sourceBytes = await fs.readFile(path.join(output, savedPlanReplay.sourceFilename));
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), savedPlanReplay.sourceSha256, 'Replay source bytes differ from the original paid source');
}
const persist = () => fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
// Only a proven local rejection before task creation can release a budget slot.
for (const entry of ledger.cases) {
  if (entry.submissionStarted && !entry.taskId && entry.httpStatus === 400 && entry.error?.includes('"error":"MODEL_DISABLED"')) {
    entry.preflightAttempts = [...(entry.preflightAttempts || []), { at: entry.submissionStarted, error: entry.error, billed: false }];
    delete entry.submissionStarted; ledger.submitted--; entry.status = 'ui-failed';
  }
}
await persist();
const modelIds = [1, 2, 3, 6, 7, 8, 9].map(n => `d5000000-0000-4000-8000-00000000000${n}`);
const modelNames = ['aplmart-gpt2.5-flare', 'aplmart-gpt2.5-sunburst', 'aplmart-nano2.1'];
const chatModelId = 'd5000000-0000-4000-8000-000000000004';
const videoModelId = 'd5000000-0000-4000-8000-000000000005';
const planRequests = new Map();
let replayedPlanningResponses = 0;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
let active;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === 'POST' && url.pathname === '/api/tasks') {
    const payload = request.postDataJSON();
    const allowedModel = active?.tool === 'video' ? payload.modelConfigId === videoModelId : modelIds.includes(payload.modelConfigId) && (!active?.modelId || payload.modelConfigId === active.modelId);
    const allowedReplayTask = !savedPlanReplay || (active?.id === savedPlanReplay.replayCaseId && active.planningReplay?.fulfilledAt
      && payload.modelConfigId === modelIds[1] && payload.operationType === 'inpaint' && payload.prompt?.includes(savedPlanReplay.prompt) && payload.sourceUrls?.length === 1);
    if (!active || active.submissionStarted || ledger.submitted >= 50 || !allowedModel || !allowedReplayTask || (payload.parameters?.n ?? 1) !== 1) {
      const reason = `Blocked unbudgeted task ${active?.id || 'none'}`;
      errors.push(reason); if (active) { active.error = reason; active.rejectedTaskPayload = payload; active.blockedBeforeSubmission = true; await persist(); }
      return route.abort();
    }
    assert.equal(payload.parameters?.tool, active.tool);
    ledger.submitted++;
    Object.assign(active, { submissionStarted: new Date().toISOString(), payload, status: 'submitted' });
    await persist();
    console.log(JSON.stringify({ id: active.id, phase: 'submit', used: ledger.submitted, limit: 50 }));
  }
  if (request.method() === 'POST' && /\/chat\//.test(url.pathname)) {
    const payload = request.postDataJSON();
    if (savedPlanReplay) {
      try {
        assert.equal(active?.id, savedPlanReplay.replayCaseId, 'Replay cannot run a different case');
        assert.equal(replayedPlanningResponses, 0, 'A saved plan may only be replayed once; further chat requests are blocked');
        assert.equal(Boolean(active.submissionStarted || active.taskId), false, 'An image task already started for this replay');
        validateReplayPlanningPayload(payload, savedPlanReplay);
        replayedPlanningResponses++;
        active.planningReplay = { sourceCaseId: savedPlanReplay.sourceCaseId, sourcePlanId: savedPlanReplay.sourcePlanId,
          responseSha256: savedPlanReplay.responseSha256, sourceSha256: savedPlanReplay.sourceSha256, attachmentId: savedPlanReplay.attachmentId,
          fulfilledAt: new Date().toISOString(), newChatCharges: 0 };
        await persist();
        console.log(JSON.stringify({ id: active.id, phase: 'replay-paid-plan', sourcePlanId: savedPlanReplay.sourcePlanId, newChatCharges: 0, used: ledger.submitted }));
        return route.fulfill({ status: 200, contentType: 'application/json', body: savedPlanReplay.responseJson });
      } catch (error) {
        const reason = `Blocked paid-plan replay: ${error.message}`;
        errors.push(reason); if (active) active.error = reason;
        await persist();
        // Never continue a replay chat request to the server, including unexpected follow-up requests.
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'QA_REPLAY_GUARD', message: reason }) });
      }
    }
    if (group !== 'chat' || !active || payload.modelId !== chatModelId || ledger.submitted >= 50 || (active.planningCalls || 0) >= 2) {
      errors.push(`Blocked text-model charge ${url.pathname}`); return route.abort();
    }
    active.planningStarted ||= new Date().toISOString(); active.planningCalls = (active.planningCalls || 0) + 1;
    const entry = { id: `${active.id}-plan-${active.planningCalls}`, parentId: active.id, tool: 'gpt-chat', modelId: chatModelId,
      submissionStarted: new Date().toISOString(), status: 'submitted', toolCount: payload.tools?.length || 0 };
    ledger.cases.push(entry); ledger.submitted++; planRequests.set(request, { entry, parent: active }); await persist();
    console.log(JSON.stringify({ id: entry.id, phase: 'submit-text', used: ledger.submitted, limit: 50 }));
  }
  return route.continue();
});
page.on('response', async response => {
  const planned = planRequests.get(response.request());
  if (planned) {
    const body = await response.json().catch(() => ({}));
    planned.entry.httpStatus = response.status(); planned.entry.status = response.ok() ? 'success' : 'failed';
    planned.entry.response = body; planned.entry.completedAt = new Date().toISOString();
    if (!response.ok()) planned.parent.error = `Mark text ${response.status()}: ${JSON.stringify(body)}`;
    else if (!Array.isArray(body.toolCalls) || !body.toolCalls.some(call => ['create_image', 'inspect_images'].includes(planningToolName(call)))) planned.parent.error = 'Mark planning returned text without an image-generation tool call';
    await persist();
  }
  if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks' && active) {
    const body = await response.json().catch(() => ({}));
    active.taskId = body.task?.id || body.data?.task?.id;
    active.httpStatus = response.status();
    if (!active.taskId) active.error = JSON.stringify(body);
    await persist();
  }
});
async function choose(index, quality = 'high', resolution = '1k') {
  await page.locator('.canvas-composer-model-picker').first().click();
  await page.getByRole('option', { name: new RegExp(modelNames[index].replaceAll('.', '\\.')) }).click();
  await page.getByLabel('宽高比', { exact: true }).selectOption('1:1');
  await page.getByLabel('清晰度 / 分辨率', { exact: true }).selectOption(resolution);
  if (index !== 2) await page.getByLabel('图片质量', { exact: true }).selectOption(quality);
  const count = page.getByLabel('生成张数', { exact: true });
  if (await count.count()) await count.fill('1');
}
async function run(spec, setup) {
  const existing = ledger.cases.find(item => item.id === spec.id);
  if (existing?.submissionStarted || existing?.planningStarted || existing?.planningReplay?.fulfilledAt) { console.log(JSON.stringify({ id: spec.id, phase: 'skip-existing', status: existing.status })); return existing; }
  active = existing || { ...spec, startedAt: new Date().toISOString(), status: 'preparing' };
  if (!existing) ledger.cases.push(active);
  delete active.error; active.status = 'preparing'; await persist();
  try {
    await setup();
    const deadline = Date.now() + (spec.tool === 'video' ? 900_000 : 300_000);
    while (!active.taskId) { if (active.error || Date.now() > deadline) throw Error(active.error || 'No task returned'); await page.waitForTimeout(200); }
    while (Date.now() < deadline) {
      const response = await context.request.get(`${origin}/api/tasks/${active.taskId}`);
      const body = await response.json();
      const task = body.task || body.data?.task;
      if (!task) throw Error('Task missing');
      active.task = task;
      if (['success', 'failed', 'paused', 'cancelled'].includes(task.status)) {
        active.status = task.status;
        active.outputs = [];
        for (const [index, url] of (task.resultUrls || []).entries()) {
          const asset = await context.request.get(new URL(url, origin).href);
          const bytes = await asset.body();
          const mime = asset.headers()['content-type'];
          const ext = mime?.startsWith('video/') ? 'mp4' : mime?.startsWith('image/jpeg') ? 'jpg' : mime?.startsWith('image/webp') ? 'webp' : 'png';
          const filename = `${spec.id}-${index + 1}.${ext}`;
          await fs.writeFile(path.join(output, filename), bytes);
          active.outputs.push({ filename, mimeType: mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(output, `${spec.id}-page.png`), fullPage: true });
        active.completedAt = new Date().toISOString(); await persist();
        console.log(JSON.stringify({ id: spec.id, phase: 'done', status: active.status, taskId: active.taskId, outputs: active.outputs, reason: task.failureReason, used: ledger.submitted }));
        return active;
      }
      await page.waitForTimeout(2500);
    }
    throw Error('Task timeout: do not resubmit');
  } catch (error) {
    active.status = active.submissionStarted || active.planningStarted || active.planningReplay?.fulfilledAt ? 'needs-review' : 'ui-failed'; active.error = error.message;
    await page.screenshot({ path: path.join(output, `${spec.id}-error.png`), fullPage: true }).catch(() => {});
    await persist(); console.log(JSON.stringify({ id: spec.id, phase: 'error', error: error.message, used: ledger.submitted }));
    throw error;
  } finally { active = null; }
}
const source = path.join(output, 'image-knit-A-1.png');
const jacquard = path.join(output, 'knit-jacquard.png');
const cable = path.join(output, 'knit-cable.png');
const button = path.join(output, 'knit-button.png');
async function upload(input, file = source) {
  await input.setInputFiles(file);
  await page.waitForTimeout(800);
}
function planningToolName(call) {
  return typeof call?.function?.name === 'string' ? call.function.name : typeof call?.name === 'string' ? call.name : '';
}
function prepareChatPlanReplay(ledger) {
  const sourceCaseId = 'chat-knit-A-responses';
  const sourceCase = ledger.cases.find(item => item.id === sourceCaseId);
  assert.ok(sourceCase, 'The original paid Responses case is missing');
  assert.equal(sourceCase.tool, 'gpt-chat-image');
  assert.equal(sourceCase.planningCalls, 1, 'Only this single-plan case can be replayed');
  assert.equal(Boolean(sourceCase.submissionStarted || sourceCase.taskId), false, 'The original case already started an image task; do not duplicate it');
  const plans = ledger.cases.filter(item => item.parentId === sourceCaseId);
  assert.equal(plans.length, 1, 'Replay requires exactly one previously paid planning response');
  const plan = plans[0];
  assert.equal(plan.id, `${sourceCaseId}-plan-1`); assert.equal(plan.status, 'success'); assert.equal(plan.httpStatus, 200);
  assert.equal(plan.modelId, 'd5000000-0000-4000-8000-000000000004');
  assert.ok(plan.submissionStarted, 'Replay requires a recorded paid planning request');
  const response = plan.response;
  assert.equal(response?.stopReason, 'tool_calls');
  assert.ok(Array.isArray(response.toolCalls)); assert.equal(response.toolCalls.length, 1);
  assert.equal(planningToolName(response.toolCalls[0]), 'create_image', 'Only a final image plan may be replayed, not an inspection loop');
  const args = JSON.parse(response.toolCalls[0].function.arguments);
  assert.equal(args.action, 'edit'); assert.ok(typeof args.prompt === 'string' && args.prompt.trim());
  assert.match(args.target_image_id, /^[a-f0-9-]{36}$/i);
  assert.equal((args.reference_image_ids || []).length, 0, 'This replay is limited to the original single reference');
  assert.ok(Array.isArray(args.preserve));
  const sourceFilename = 'image-knit-A-1.png';
  const original = ledger.cases.find(item => item.id === 'image-knit-A')?.outputs?.find(item => item.filename === sourceFilename);
  assert.match(original?.sha256 || '', /^[a-f0-9]{64}$/i, 'The original source hash must be recorded');
  const responseJson = JSON.stringify(response);
  return { sourceCaseId, sourcePlanId: plan.id, replayCaseId: `${sourceCaseId}-plan-replay-v2`, responseJson,
    responseSha256: createHash('sha256').update(responseJson).digest('hex'), attachmentId: args.target_image_id,
    sourceFilename, sourceSha256: original.sha256, prompt: args.prompt };
}
function validateReplayPlanningPayload(payload, replay) {
  assert.equal(payload.modelId, 'd5000000-0000-4000-8000-000000000004');
  assert.equal(payload.toolKey, 'gpt-chat');
  assert.ok(payload.tools?.some(tool => planningToolName(tool) === 'create_image'));
  const parts = (payload.input || []).flatMap(item => Array.isArray(item.content) ? item.content : []);
  const previews = parts.filter(item => item.type === 'input_text' && item.text?.startsWith('[图片预览 image_id='));
  assert.equal(previews.length, 1, 'Replay requires the original single image preview');
  assert.ok(previews[0].text.startsWith(`[图片预览 image_id=${replay.attachmentId};`), 'Replay attachment identity differs from the original paid plan');
  const images = parts.filter(item => item.type === 'input_image');
  assert.equal(images.length, 1); assert.match(images[0].image_url, /^data:image\//);
}
async function uploadReplayReference(input, replay) {
  // Reconstruct the same attachment identity; never rewrite the already-paid tool arguments or native output.
  await page.evaluate(id => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    const original = crypto.randomUUID;
    const state = { descriptor, original, used: 0 };
    globalThis.__markReplayAttachmentId = state;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => {
      if (!state.used) { state.used++; return id; }
      return original.call(crypto);
    } });
  }, replay.attachmentId);
  let consumed = 0;
  try {
    await upload(input, path.join(output, replay.sourceFilename));
    await page.getByRole('button', { name: `移除 ${replay.sourceFilename}`, exact: true }).waitFor();
  }
  finally {
    consumed = await page.evaluate(() => {
      const state = globalThis.__markReplayAttachmentId;
      if (state.descriptor) Object.defineProperty(crypto, 'randomUUID', state.descriptor);
      else delete crypto.randomUUID;
      delete globalThis.__markReplayAttachmentId;
      return state.used;
    });
  }
  assert.equal(consumed, 1, 'The original attachment UUID was not consumed; no planning request may be sent');
}
async function sceneSetup(scene, variant, model) {
  await page.goto(`${origin}/creative/${scene}`);
  await page.locator('.cs-output-settings > summary').click();
  await choose(model, variant === 0 ? 'high' : 'medium');
  const primary = page.locator('#cs-upload-primary');
  if (await primary.count()) await upload(primary, ['pattern-extract', 'pattern-colorway', 'pattern-craft'].includes(scene) ? (variant === 0 ? jacquard : cable) : scene === 'accessory-design' ? button : source);
  if (scene === 'text-to-style') {
    await page.getByLabel('款式描述').fill(variant === 0 ? '复杂针织开衫，米白主体，海军蓝费尔岛提花肩部，大身阿兰绞花和蜂窝针法，细罗纹领口袖口与下摆，长袖落肩，白底完整正面单件。' : '复杂针织圆领套头毛衫，森林绿主体，米白嵌花几何图案，中央菱形麻花与蜂窝针法组合，宽松长袖，罗纹收边，白底完整正面单件。');
    await page.getByLabel('服装品类', { exact: true }).selectOption('针织衫');
    await page.getByLabel('面料方向').fill('羊毛混纺，精细可见针织纹理');
  }
  if (scene === 'style-to-sketch') {
    await page.getByRole('radio', { name: variant === 0 ? '技术感线稿' : '极简线稿', exact: true }).check();
    await page.getByRole('radio', { name: variant === 0 ? '可见细节' : '主要轮廓', exact: true }).check();
  }
  if (scene === 'local-restyle') {
    await page.getByRole('radio', { name: variant === 0 ? '领口' : '袖子', exact: true }).check();
    await page.locator('#cs-local-restyle-change').fill(variant === 0 ? '仅将圆领改为小V领，领边保持米白色细罗纹，其他所有针织图案、纽扣、袖长和背景不变。' : '仅将左侧袖口罗纹改为双层翻折袖口，保留原色、长袖长度和所有绞花提花。');
    await page.locator('#cs-local-restyle-preserve').fill('保留衣身复杂提花与绞花、全部纽扣、白底与光影。');
    await page.getByRole('button', { name: '涂选修改区域', exact: true }).click();
    const canvas = page.getByLabel('修改区域画布');
    const rect = await canvas.boundingBox();
    const points = variant === 0 ? [[.40,.12],[.44,.18],[.50,.22],[.56,.18],[.60,.12]] : [[.05,.81],[.10,.82],[.15,.83],[.11,.87],[.05,.87]];
    await page.mouse.move(rect.x + points[0][0]*rect.width, rect.y + points[0][1]*rect.height); await page.mouse.down();
    for (const [x,y] of points) await page.mouse.move(rect.x + x*rect.width, rect.y + y*rect.height, { steps: 12 });
    await page.mouse.up();
    await page.getByRole('button', { name: '保存选区', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  if (scene.includes('colorway')) {
    await page.getByRole('radio', { name: variant === 0 ? '指定颜色' : '参考图配色', exact: true }).check();
    if (variant === 0) {
      await page.getByLabel('颜色 1 HEX 色值', { exact: true }).fill('#275B4A');
      if (await page.getByLabel('颜色 2 HEX 色值', { exact: true }).count()) await page.getByLabel('颜色 2 HEX 色值', { exact: true }).fill('#D8AD58');
      await page.getByLabel('改色区域').fill(scene === 'garment-colorway' ? '仅米白的大身及袖子绞花区域改森林绿，保持提花图案与纽扣' : '蓝色纹样改森林绿，红色纹样改芥末黄，米白底色保留');
    } else await upload(page.locator('#cs-upload-secondary'), scene === 'garment-colorway' ? jacquard : source);
  }
  if (scene === 'back-design') {
    await page.getByRole('radio', { name: variant === 0 ? '简洁' : '自由描述', exact: true }).check();
    if (variant === 1) await page.locator('#cs-back-design-description').fill('完整背面图，后肩增加协调的提花育克，下半身纵向绞花延续正面组织。保留长度与袖子，不在背面画纽扣。');
  }
  if (scene === 'pattern-extract') {
    await page.getByRole('radio', { name: variant === 0 ? '单独图案' : '完整可见花型', exact: true }).check();
    await page.getByRole('radio', { name: variant === 0 ? '白底' : '保留底色', exact: true }).check();
  }
  if (scene === 'accessory-design') {
    await page.getByRole('radio', { name: '钮扣', exact: true }).check();
    await upload(page.locator('#cs-upload-secondary'), variant === 0 ? jacquard : cable);
    await page.getByRole('radio', { name: variant === 0 ? '仅表面纹样' : '形状与纹样', exact: true }).check();
  }
  if (scene === 'pattern-craft') {
    await page.getByRole('radio', { name: variant === 0 ? '提花' : '毛巾绣', exact: true }).check();
    await page.getByLabel('承载面料', { exact: true }).selectOption(variant === 0 ? '针织面料' : '参考图原面料');
  }
  await page.locator('.cs-generate').click();
}
try {
  if (group === 'nano2') {
    await run({ id: 'aplmart-nano2-knit-A', tool: 'image', modelId: modelIds[6], scenario: 'Official Nano2 reference edit, 1K, distinct from Nano2.1' }, async () => {
      await page.goto(`${origin}/image`);
      await page.locator('.canvas-composer-model-picker').first().click();
      await page.getByRole('option', { name: /^aplmart-nano2 ·/ }).click();
      await page.getByLabel('宽高比', { exact: true }).selectOption('1:1');
      await page.getByRole('button', { name: '1K', exact: true }).click();
      await upload(page.locator('input[type=file]').first());
      await page.getByLabel('图像提示词').fill('只修改这件复杂针织开衫的8颗棕色钮扣：全部改为哑光海军蓝。钮扣数量和位置不变，保留米白绞花、蓝红黄费尔岛提花、圆领、袖口下摆罗纹与白色背景，完整正面单件。');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
    });
  }
  if (group === 'new-images') {
    for (const [label, index] of [['aplmart-gpt2', 4], ['aplmart-grok2', 5]]) for (let variant = 0; variant < 2; variant++) await run({ id: `${label}-knit-${variant ? 'B' : 'A'}`, tool: 'image', modelId: modelIds[index], scenario: variant ? '2K reference edit of cardigan buttons' : '1K complex knit generation or reference color edit' }, async () => {
      await page.goto(`${origin}/image`);
      await page.locator('.canvas-composer-model-picker').first().click();
      await page.getByRole('option', { name: new RegExp(`^${label} `) }).click();
      await page.getByLabel('宽高比', { exact: true }).selectOption(variant ? '3:4' : '1:1');
      if (index === 4) await page.getByRole('button', { name: variant ? '2K' : '1K', exact: true }).click();
      else {
        await page.getByLabel('清晰度 / 分辨率', { exact: true }).selectOption(variant ? '2k' : '1k');
        await page.getByLabel('图片质量', { exact: true }).selectOption('medium');
      }
      if (variant || index === 4) await upload(page.locator('input[type=file]').first());
      if (index === 5 && variant) assert.equal(await page.getByLabel('图片质量', { exact: true }).count(), 0, 'Grok reference editing must hide quality');
      await page.getByLabel('图像提示词').fill(variant ? '仅将复杂针织开衫的全部8颗棕色钮扣改为海军蓝哑光圆钮扣，位置数量不变，保留米白绞花、蓝红黄费尔岛纹样、圆领、长袖和白底。完整服装。' : index === 4 ? '仅将参考毛衫的大身米白绞花改为浅灰蓝，提花、罗纹、全部8颗钮扣、结构和白底保持不变。' : '完整正面商品图：女式复杂针织圆领开衫，米白羊毛，8颗棕色圆钮扣，上胸与袖子海军蓝砖红芥末黄费尔岛提花，下部清晰阿兰绞花、蜂窝与菱形针法，长袖落肩，罗纹收边，白底，无人无字。');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
    });
  }
  if (group === 'blend') {
    for (let variant = 0; variant < 2; variant++) await run({ id: `blend-knit-${variant ? 'B' : 'A'}`, tool: 'midjourney-blend', modelId: modelIds[3], scenario: variant ? 'four complex-knit references, landscape fast' : 'two complex-knit references, square fast' }, async () => {
      await page.goto(`${origin}/image?tool=midjourney-blend`);
      await page.getByRole('heading', { name: 'MJ 多图融合', exact: true }).waitFor();
      assert.equal(await page.getByLabel('图像提示词').count(), 0, 'Blend must not expose a prompt field');
      await page.locator('.canvas-composer-model-picker').first().click();
      await page.getByRole('option', { name: /^aplmart-mj-blend / }).click();
      await page.getByRole('button', { name: '快速', exact: true }).click();
      await page.getByLabel('宽高比', { exact: true }).selectOption(variant ? '3:2' : '1:1');
      await page.locator('input[type=file]').first().setInputFiles(variant ? [source, jacquard, cable, button] : [source, cable]);
      await page.getByRole('button', { name: '开始融合', exact: true }).click();
    });
  }
  if (group === 'accessory-corrected') {
    for (let variant = 0; variant < 2; variant++) await run({ id: `accessory-button-knit-${variant ? 'B' : 'A'}`, tool: 'creative-accessory-design', scenario: variant ? 'button shape and cable texture; explicit correct accessory type' : 'button surface Fair Isle motif; explicit correct accessory type', reference: source }, () => sceneSetup('accessory-design', variant, variant ? 2 : 0));
  }
  if (group === 'seed') {
    await run({ id: 'image-knit-A', tool: 'image', scenario: 'text-to-image complex cable and Fair Isle cardigan', expected: 'whole garment, cables, jacquard, 7 buttons, ivory background' }, async () => {
      await page.goto(`${origin}/image`);
      await page.getByLabel('图像提示词').waitFor();
      await choose(0);
      await page.getByLabel('图像提示词').fill('服装开发测试：输出一张复杂针织毛衫的正面白底商品照片。完整的女式圆领长袖开襟毛衫，宽松落肩版型，7颗深棕色圆形纽扣，门襟垂直居中；米白羊毛为主，海军蓝、砖红、芥末黄的精细费尔岛几何提花覆盖上胸和袖子上段；大身下半部有清晰凸起绞花、菱形绞花、蜂窝组织，袖口、圆领和下摆细罗纹。衣身左右结构对称，长袖自然向两侧展开，显示真实针织线圈和毛羽、细小缝线。没有人、衣架、文字、品牌、水印，柔和均匀灯光，服装不裁切，正视角，1024方图。');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
    });
  }
  if (group === 'boards') {
    await run({ id: 'image-knit-B', tool: 'image', scenario: 'reference garment colorway with Nano 2K' }, async () => {
      await page.goto(`${origin}/image`); await page.getByLabel('图像提示词').waitFor();
      await choose(2, 'high', '2k'); await upload(page.locator('input[type=file]').first());
      await page.getByLabel('图像提示词').fill('仅将这件复杂针织毛衫米白色绞花区域改为浅灰蓝色，深蓝、砖红、黄提花图案、全部纽扣和罗纹、服装结构、正面视角与白底保持不变。完整单件。');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
    });
    const tools = [
      ['detail-enhance','开始增强', ['增强这件毛衫下半部的绞花交叉、蜂窝针目、羊毛毛羽与罗纹清晰度，不改变原有结构、配色、图案和纽扣。','增强毛衫上半部费尔岛提花边缘与细密针目，保留各色区布局、纽扣数量和衣服轮廓，不添加装饰。']],
      ['image-edit','开始编辑', ['仅将这件毛衫圆领边的米白罗纹改为海军蓝，其余绞花、提花、所有纽扣及衣服形状保持不变。','仅将毛衫门襟全部深棕色钮扣改为米白珍珠光泽钮扣，位置数量不变，其余复杂针织结构和所有颜色保持不变。']],
      ['angle-control','生成角度图', ['展示同一件复杂针织毛衫左前45度商品视角，保留绞花、提花、罗纹及钮扣，完整服装，白底。','展示同一件复杂针织毛衫右侧面商品视角，合理延续可见针织结构，保持原色、版型与长度，白底完整服装。']],
    ];
    for (const [tool, label, prompts] of tools) for (let variant = 0; variant < 2; variant++) await run({ id: `${tool}-knit-${variant ? 'B' : 'A'}`, tool, scenario: prompts[variant] }, async () => {
      await page.goto(`${origin}/image?tool=${tool}`); await page.getByLabel('图像提示词').waitFor();
      await choose((variant + tools.findIndex(t => t[0] === tool)) % 3, variant ? 'medium' : 'high', tool === 'detail-enhance' && variant === 1 ? '2k' : '1k');
      await upload(page.locator('input[type=file]').first()); await page.getByLabel('图像提示词').fill(prompts[variant]);
      await page.getByRole('button', { name: label, exact: true }).click();
    });
    for (let variant = 0; variant < 2; variant++) await run({ id: `seamless-stitch-knit-${variant ? 'B' : 'A'}`, tool: 'seamless-stitch', scenario: variant ? 'cable repeat' : 'Fair Isle repeat' }, async () => {
      await page.goto(`${origin}/image?tool=seamless-stitch`); await choose(variant ? 2 : 1);
      await upload(page.locator('input[type=file]').first(), variant ? cable : jacquard);
      await page.getByRole('button', { name: '开始无缝拼接', exact: true }).click();
    });
    const scenes = ['text-to-style','style-to-sketch','local-restyle','garment-colorway','back-design','pattern-extract','pattern-colorway','accessory-design','pattern-craft'];
    for (const [index, scene] of scenes.entries()) for (let variant = 0; variant < 2; variant++) await run({ id: `${scene}-knit-${variant ? 'B' : 'A'}`, tool: `creative-${scene}`, scenario: `complex knit ${scene} variant ${variant + 1}`, reference: source }, () => sceneSetup(scene, variant, (index + variant) % 3));
    for (let variant = 0; variant < 2; variant++) await run({ id: `series-recipe-knit-${variant ? 'B' : 'A'}`, tool: 'series-recipe', scenario: variant ? 'pattern placement' : 'structure-preserved colorway' }, async () => {
      await page.goto(`${origin}/creative/series-recipe`);
      await page.getByLabel('选择流程', { exact: true }).selectOption(variant ? 'pattern' : 'structure');
      await upload(page.getByLabel('上传参考底图（必需）', { exact: true }));
      const files = page.locator('input[type=file]');
      if (variant) await upload(files.nth(1), jacquard);
      await page.getByLabel('候选数量', { exact: true }).selectOption('1');
      await page.getByLabel('设计方向', { exact: true }).fill(variant ? '仅在左胸局部增加与原提花协调的徽章形图案，其余绞花和结构保持不变。' : '把米白绞花部分变为浅灰，保留费尔岛纹样、全部钮扣和原版型。');
      await page.getByText('模型与出图设置', { exact: true }).click(); await choose(variant ? 1 : 0);
      await page.getByRole('button', { name: /^(运行配方|生成新一轮)/ }).click();
    });
  }
  if (group === 'chat') {
    for (const variant of (savedPlanReplay ? [0] : [0, 1])) await run({ id: savedPlanReplay?.replayCaseId || `chat-knit-${variant ? 'B' : 'A'}${!variant && ['tools-compatible', 'responses'].includes(process.env.MARK_QA_CHAT_RETEST) ? `-${process.env.MARK_QA_CHAT_RETEST}` : ''}`, tool: 'gpt-chat-image', scenario: savedPlanReplay ? 'Replay the exact paid Responses plan; only the image task can incur a new charge' : variant ? 'Mark text plans button replacement, Nano edit' : 'Mark text plans neckline recolor, Sunburst edit', ...(savedPlanReplay ? { replayedFromCaseId: savedPlanReplay.sourceCaseId } : {}) }, async () => {
      await page.goto(`${origin}/chat`);
      if (variant) await page.getByRole('button', { name: '新建对话', exact: true }).click();
      const configurationResponse = await context.request.get(`${origin}/api/models`);
      assert.ok(configurationResponse.ok(), 'Unable to verify the administrative chat binding before paid QA');
      const configuration = await configurationResponse.json();
      assert.equal(configuration.tools.find(tool => tool.toolKey === 'gpt-chat')?.modelConfigId, chatModelId, 'Paid QA requires the explicitly budgeted chat model to be bound in the backend; the runner never changes that binding');
      assert.equal(await page.getByLabel('对话模型', { exact: true }).count(), 0, 'Designer LLM selection must remain hidden');
      await page.getByLabel('出图模型', { exact: true }).selectOption(modelIds[variant ? 2 : 1]);
      await page.getByTestId(variant ? 'chat-image-quality' : 'chat-image-resolution').selectOption(variant ? '2k' : '1k');
      if (!variant) await page.getByTestId('chat-image-quality').selectOption('high');
      if (savedPlanReplay) await uploadReplayReference(page.locator('input[type=file]').first(), savedPlanReplay);
      else await upload(page.locator('input[type=file]').first());
      await page.getByLabel('对话内容', { exact: true }).fill(variant
        ? '请直接生成一张改图：将我上传的复杂针织毛衫全部8颗深棕色纽扣改成哑光海军蓝色纽扣，位置数量不变，保留米白绞花、费尔岛提花、圆领、长袖和白底。不要只回复文字，请执行改图，只生成1张。'
        : '请直接生成一张改图：仅把我上传毛衫的米白圆领罗纹改成海军蓝色；保留所有复杂提花、绞花、8颗纽扣、袖口、下摆和白底。不要只回复文字，请执行改图，只生成1张。');
      await page.getByRole('button', { name: '发送', exact: true }).click();
    });
  }
  if (group === 'video') {
    for (let variant = 0; variant < 2; variant++) await run({ id: `video-knit-${variant ? 'B' : 'A'}`, tool: 'video', scenario: variant ? 'two garment references, slow product showcase' : 'first-frame complex knit, gentle camera push' }, async () => {
      await page.goto(`${origin}/video`);
      if (variant) await page.locator('main').getByRole('button', { name: '新建', exact: true }).filter({ visible: true }).click();
      await page.locator('.canvas-composer-model-picker:visible').first().click();
      await page.getByRole('option', { name: /aplmart-happyhorse1.1/ }).click();
      await page.getByLabel('视频生成方式', { exact: true }).selectOption(variant ? 'reference' : 'first-frame');
      await page.getByLabel('视频时长', { exact: true }).selectOption('3');
      await page.getByRole('button', { name: '720P', exact: true }).filter({ visible: true }).click();
      await page.getByRole('button', { name: /^1:1/ }).filter({ visible: true }).click();
      const details = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '参考素材' }) });
      if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
      await page.locator('input[type=file][accept="image/jpeg,image/png,image/webp"]').setInputFiles(variant ? [source, path.join(output, 'back-design-knit-B-1.jpg')] : source);
      await page.getByLabel('视频提示词', { exact: true }).fill(variant
        ? 'A slow studio product showcase of the same complex ivory knitted cardigan, using the provided front and back references. Subtle three-quarter rotation, preserve Fair Isle colors, cable structure, eight front buttons and long sleeves. Clean white background, no person, no text, no added objects.'
        : 'Use the uploaded complex knitted cardigan as the exact first frame. A very gentle camera push toward the upper Fair Isle and cable knit details for three seconds. Keep the whole garment silhouette, colors, eight buttons and white background stable. No human, no text, no dramatic motion.');
      await page.getByRole('button', { name: '生成视频', exact: true }).filter({ visible: true }).click();
    });
  }
} finally {
  await fs.writeFile(path.join(output, 'browser-errors.json'), JSON.stringify(errors, null, 2));
  await context.close(); await browser.close();
}
