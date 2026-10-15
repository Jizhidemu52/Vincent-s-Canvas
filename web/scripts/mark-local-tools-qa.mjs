import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(path.resolve(process.cwd(), "../labs/design-workbench/package.json"))("playwright");

const origin = process.env.MARK_LOCAL_QA_URL || "http://127.0.0.1:5188";
const output = path.resolve(process.cwd(), "../output/mark-local-qa");
const garmentPath = process.env.MARK_LOCAL_GARMENT;
await fs.mkdir(output, { recursive: true });
const previousReport=path.join(output,"report.json");
try { await fs.copyFile(previousReport,path.join(output,`report-before-${Date.now()}.json`)); } catch {}
const report = { startedAt: new Date().toISOString(), scope: "Isolated browser context, local tools only; every API request is mocked and every external HTTP request aborted. No real backend writes or provider calls.", input: garmentPath || "controlled local fixture", scenarios: [], requests: [], blocked: [], pageErrors: [] };
try {
  await fs.access(path.join(output,"08-svg-trace-failure.png"));
  report.earlierExploratoryFinding = { status:"observed in an earlier exploratory run; not re-exercised by the normal workflow suite", action:"SVG threshold Home followed by 95 rapid ArrowRight keypresses", error:"React Maximum update depth exceeded in Ant Design Portal setInnerContainer", screenshot:"08-svg-trace-failure.png", normalSliderChanges:"covered below" };
} catch {}
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "chrome" });
const context = await browser.newContext({ viewport: { width: 1512, height: 1120 }, acceptDownloads: true, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on("pageerror", error => report.pageErrors.push(error.message));
const flags = ["creative", "creative-garment-colorway", "creative-pattern-colorway", "creative-style-to-sketch", "creative-local-restyle", "photo-color-picker", "standard-colors", "pattern-recolor", "svg-trace", "creative-selection", "pattern-placement", "pattern-repeat", "assets", "prompts", "reference-import", "design-library"];
const models = [{ id: "local-qa-model", modelId: "local-qa-model", name: "隔离验证模型（禁止提交）", imageParameterProfile: "quality-resolution", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 }];
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (!["http:", "https:"].includes(url.protocol)) return route.continue();
  if (url.origin !== origin) { report.blocked.push({ reason: "external", url: request.url(), method: request.method() }); return route.abort("blockedbyclient"); }
  if (!url.pathname.startsWith("/api/")) return route.continue();
  const entry = { path: url.pathname, method: request.method() };
  report.requests.push(entry);
  if (request.method() !== "GET" || /tasks|generate|completions|responses|providers/.test(url.pathname)) {
    report.blocked.push({ reason: "api-write-or-generation", ...entry });
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "QA safety guard: no real writes or paid generation allowed" }) });
  }
  const json = url.pathname === "/api/deployment" ? { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false }
    : url.pathname === "/api/auth/session" ? { user: { id: "mark-local-qa", username: "mark-local-qa", displayName: "本地工具隔离验证", role: "designer", status: "active", mustChangePassword: false, avatarUrl: "", groupId: null } }
    : url.pathname === "/api/modules" ? { modules: flags.map(moduleKey => ({ moduleKey, enabled: true })) }
    : url.pathname === "/api/models" ? { models, prices: [], tools: [] }
    : { code: 0, data: [], items: [], projects: [], documents: [], prompts: [], templates: [], categories: [], entries: [], tags: [], assets: [], total: 0 };
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
});
const button = name => page.getByRole("button", { name, exact: true });
const dialog = () => page.getByRole("dialog");
async function screenshot(name) { const file = `${name}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); return file; }
async function scenario(tool, name, action) {
  console.log(`QA: ${tool} / ${name}`);
  const record = { tool, name, status: "running" };
  report.scenarios.push(record);
  try { record.evidence = await action(); record.status = "passed"; record.screenshot = await screenshot(`${String(report.scenarios.length).padStart(2,"0")}-${tool}`); }
  catch (error) { record.status = "failed"; record.error = error.message; record.url = page.url(); record.screenshot = await screenshot(`${String(report.scenarios.length).padStart(2,"0")}-${tool}-failure`).catch(() => undefined); console.error(`${tool}/${name}: ${error.message}`); await page.keyboard.press("Escape").catch(() => {}); }
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
async function download(locator, filename) {
  const pending = page.waitForEvent("download"); await locator.click(); const item = await pending;
  const destination = path.join(output, filename); await item.saveAs(destination); return fs.readFile(destination);
}
async function numeric(name, value) { const input = page.getByRole("spinbutton", { name, exact: true }); await input.fill(String(value)); await input.press("Tab"); }
async function scene(id, file) {
  await page.goto(`${origin}/creative/${id}`, { waitUntil:"domcontentloaded" });
  await page.locator('.cs-form-body input[type="file"]').first().waitFor({ state: "attached" });
  await page.locator('.cs-form-body input[type="file"]').first().setInputFiles(file);
  await page.locator(".cs-upload-preview").first().waitFor();
}
async function canvasRgba(locator, x, y) { return locator.evaluate((canvas, [x,y]) => [...canvas.getContext("2d").getImageData(x,y,1,1).data], [x,y]); }
async function canvasPixelsCount(locator) { return locator.evaluate(canvas => { const data = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data; let n=0; for(let i=3;i<data.length;i+=4) if(data[i]) n++; return n; }); }
async function dragCanvas(locator, start, end) { await locator.click({trial:true,position:{x:1,y:1}}); const b = await locator.boundingBox(); assert.ok(b); await page.mouse.move(b.x+b.width*start[0], b.y+b.height*start[1]); await page.mouse.down(); await page.mouse.move(b.x+b.width*end[0], b.y+b.height*end[1], { steps: 12 }); await page.mouse.up(); }
async function selectionReady() { await page.waitForFunction(()=>{const c=document.querySelector('canvas[aria-label="修改区域画布"]');return c&&c.width>300&&getComputedStyle(c).pointerEvents==="auto"}); }
async function closeDialog() { if (!await dialog().count()) return; await page.keyboard.press("Escape"); await dialog().waitFor({state:"hidden"}); }

try {
  await page.goto(`${origin}/creative/garment-colorway`, { waitUntil:"domcontentloaded" });
  await page.locator('.cs-form-body input[type="file"]').first().waitFor({state:"attached"});
  const fixtureBase64 = await page.evaluate(() => {
    const c=document.createElement("canvas"); c.width=256;c.height=192;const x=c.getContext("2d");
    x.fillStyle="#CC3344";x.fillRect(0,0,128,192);x.fillStyle="#2255AA";x.fillRect(128,0,128,192);
    x.fillStyle="#111111";x.fillRect(32,64,192,8);x.fillRect(60,32,8,128);x.clearRect(0,0,8,8);return c.toDataURL("image/png").split(",")[1];
  });
  const fixture = { name: "local-qa-color-blocks.png", mimeType: "image/png", buffer: Buffer.from(fixtureBase64,"base64") };
  await fs.writeFile(path.join(output, fixture.name), fixture.buffer);
  const garment = garmentPath || fixture;
  if (process.env.MARK_LOCAL_INSPECT) { console.log((await page.locator("body").innerText()).slice(0,18000)); console.log(await page.locator("input[type=file]").evaluateAll(items=>items.map(x=>x.outerHTML))); }

  await scenario("photo-color", "click sample at known red pixel", async () => {
    await scene("garment-colorway", fixture);
    await page.getByRole("radio", {name:"指定颜色",exact:true}).check();
    await button("从标准色库选择颜色 1").click();
    await dialog().locator(".sc-card").first().waitFor();
    await dialog().getByText("从已上传的款式图取色",{exact:true}).click();
    const image = dialog().getByAltText("已上传的衣服照片"); await image.waitFor(); const b=await image.boundingBox();
    await page.mouse.click(b.x+b.width*.1,b.y+b.height*.8);
    await dialog().getByText("已取色 #CC3344，已用于查找相近色", {exact:true}).waitFor();
    assert.equal(await dialog().getByLabel("参考色",{exact:true}).inputValue(),"#CC3344");
    return { selectedHex:"#CC3344", mode:"nearest", fixture:fixture.name };
  });
  await scenario("photo-color", "keyboard precise movement on uploaded garment", async () => {
    await closeDialog(); await scene("garment-colorway", garment);
    await page.getByRole("radio", {name:"指定颜色",exact:true}).check(); await button("从标准色库选择颜色 1").click();
    await dialog().locator(".sc-card").first().waitFor(); await dialog().getByText("从已上传的款式图取色",{exact:true}).click();
    const sampler=dialog().getByRole("button",{name:"衣服照片取色",exact:true}); await sampler.waitFor(); await sampler.focus();
    await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("Shift+ArrowDown"); await page.keyboard.press("Enter");
    await dialog().locator(".cs-photo-sampler-status").filter({hasText:"已取色"}).waitFor();
    const message=await dialog().locator(".cs-photo-sampler-status").innerText(); const hex=await dialog().getByLabel("参考色",{exact:true}).inputValue(); assert.match(hex,/^#[0-9A-F]{6}$/);
    const image=dialog().getByAltText("已上传的衣服照片"); const bounds=await image.boundingBox(); await page.mouse.click(bounds.x+bounds.width*.32,bounds.y+bounds.height*.2);
    const clickedHex=await dialog().getByLabel("参考色",{exact:true}).inputValue(); assert.match(clickedHex,/^#[0-9A-F]{6}$/);
    return { input:garmentPath||fixture.name, keyboardHex:hex, clickedHex, message };
  });
  await scenario("standard-colors", "catalog search and apply named TCX color", async () => {
    await closeDialog(); await button("从标准色库选择颜色 1").click();
    const search=dialog().getByRole("searchbox"); await search.fill("18-1664");
    await dialog().locator(".sc-card").first().waitFor(); const card=dialog().locator(".sc-card").first(); const title=await card.getAttribute("aria-label"); await card.click();
    await dialog().getByRole("button",{name:"应用到颜色 1",exact:true}).click(); await dialog().waitFor({state:"hidden"});
    const hex=await page.getByRole("textbox",{name:"颜色 1 HEX 色值",exact:true}).inputValue(); assert.match(title,new RegExp(hex,"i"));
    assert.ok(await page.getByRole("link",{name:"查看颜色 1 来源",exact:true}).count()); return { selection:title, appliedHex:hex, sourceStored:true };
  });
  await scenario("standard-colors", "switch library, nearest matching and malformed hex guard", async () => {
    await button("从标准色库选择颜色 1").click();
    const select=dialog().locator(".sc-filters select"); const values=await select.locator("option").evaluateAll(xs=>xs.map(x=>({value:x.value,label:x.textContent})));
    const target=values.find(x=>/RAL/i.test(x.value)) || values.find(x=>x.value && !/TCX/.test(x.value)); assert.ok(target); await select.selectOption(target.value);
    await dialog().getByLabel("参考色",{exact:true}).fill("#12345Z"); assert.equal(await dialog().getByRole("button",{name:"寻找相近色",exact:true}).isDisabled(),true);
    await dialog().getByLabel("参考色",{exact:true}).fill("#2255AA"); await dialog().getByRole("button",{name:"寻找相近色",exact:true}).click();
    await dialog().locator(".sc-card").first().waitFor(); await dialog().getByText("按 ΔE2000 从小到大排列",{exact:true}).waitFor();
    const nearest=await dialog().locator(".sc-card").first().innerText(); assert.match(nearest,/ΔE/); return { library:target.value, nearest, malformedHexBlocked:true };
  });

  await scenario("recolor", "single mapping preserves geometry and alpha in exported PNG", async () => {
    await closeDialog(); await scene("pattern-colorway",fixture); await page.getByRole("button",{name:/精确换色/}).click();
    await dialog().getByRole("textbox",{name:"原色 HEX 1",exact:true}).fill("#CC3344"); await dialog().getByRole("textbox",{name:"目标色 HEX 1",exact:true}).fill("#22AA66");
    const preview=dialog().getByLabel("换色预览",{exact:true}); await page.waitForFunction(()=>{const c=document.querySelector('canvas[aria-label="换色预览"]');return c?.width===256&&c.getContext("2d").getImageData(20,150,1,1).data[1]===170});
    assert.deepEqual(await canvasRgba(preview,20,150),[34,170,102,255]); assert.deepEqual(await canvasRgba(preview,200,150),[34,85,170,255]); assert.equal((await canvasRgba(preview,1,1))[3],0);
    await dialog().locator(".ant-modal-footer button").filter({hasText:"保存换色结果"}).click(); await dialog().waitFor({state:"hidden"});
    const png=await download(page.getByRole("button",{name:"下载原图",exact:true}).first(),"recolor-single.png"); assert.equal(png.readUInt32BE(16),256); assert.equal(png.readUInt32BE(20),192);
    return { mapping:"#CC3344 → #22AA66", redChanged:true, bluePreserved:true, alphaPreserved:true, output:"recolor-single.png", dimensions:[256,192] };
  });
  await scenario("recolor", "multiple mappings and no-change safety", async () => {
    await scene("pattern-colorway",fixture); await page.getByRole("button",{name:/精确换色/}).click();
    await dialog().locator(".ant-modal-footer button").filter({hasText:"保存换色结果"}).click(); await dialog().getByText("没有发生颜色变化，请调整原色、目标色或容差",{exact:true}).waitFor();
    await dialog().getByRole("textbox",{name:"原色 HEX 1",exact:true}).fill("#CC3344"); await dialog().getByRole("textbox",{name:"目标色 HEX 1",exact:true}).fill("#EEAA11");
    await dialog().getByRole("button",{name:"添加映射",exact:true}).click(); await dialog().getByRole("textbox",{name:"原色 HEX 2",exact:true}).fill("#2255AA"); await dialog().getByRole("textbox",{name:"目标色 HEX 2",exact:true}).fill("#8833BB");
    await page.waitForFunction(()=>{const c=document.querySelector('canvas[aria-label="换色预览"]');return c?.getContext("2d").getImageData(200,150,1,1).data[0]===136});
    assert.deepEqual(await canvasRgba(dialog().getByLabel("换色预览",{exact:true}),20,150),[238,170,17,255]);
    await dialog().locator(".ant-modal-footer button").filter({hasText:"保存换色结果"}).click(); await dialog().waitFor({state:"hidden"});
    await download(page.getByRole("button",{name:"下载原图",exact:true}).first(),"recolor-multiple.png"); return { mappings:2, noChangeBlocked:true, output:"recolor-multiple.png" };
  });

  for (const [name, points, targets] of [
    ["garment single sampled yarn replacement", [[.32,.2]], ["#167D8D"]],
    ["garment two sampled yarn replacements", [[.32,.2],[.35,.3]], ["#684D9D","#267743"]],
  ]) await scenario("recolor-garment", name, async () => {
    await scene("pattern-colorway",garment); await page.getByRole("button",{name:/精确换色/}).click();
    const source=dialog().getByAltText("换色原图（点击取色）"); await source.click({trial:true});
    const sampled=[];
    for(let i=0;i<points.length;i++) {
      if(i) await dialog().getByRole("button",{name:"添加映射",exact:true}).click();
      const b=await source.boundingBox(); await page.mouse.click(b.x+b.width*points[i][0],b.y+b.height*points[i][1]);
      sampled.push(await dialog().getByRole("textbox",{name:`原色 HEX ${i+1}`,exact:true}).inputValue());
      await dialog().getByRole("textbox",{name:`目标色 HEX ${i+1}`,exact:true}).fill(targets[i]);
    }
    await dialog().getByText("换色预览",{exact:true}).waitFor();
    await dialog().locator(".ant-modal-footer button").filter({hasText:"保存换色结果"}).click(); await dialog().waitFor({state:"hidden"});
    const filename=`recolor-knit-${points.length}.png`; const png=await download(page.getByRole("button",{name:"下载原图",exact:true}).first(),filename);
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[1024,1024]);
    const description=await page.locator(".cs-operation-note").innerText(); assert.match(description,/改变 [1-9]\d* 个像素/);
    return { input:garmentPath, sampled, targets, description, dimensions:[1024,1024], output:filename };
  });

  await scenario("svg-trace", "trace uploaded garment into editable path SVG", async () => {
    await scene("style-to-sketch",garment); await button("已有线稿转 SVG").click();
    const link=dialog().getByRole("link",{name:"下载 SVG",exact:true}); await link.waitFor(); await page.waitForFunction(()=>!!document.querySelector('a[download$=".svg"]')?.getAttribute("href"));
    const svg=(await download(link,"trace-default.svg")).toString(); assert.match(svg,/^<svg/); assert.match(svg,/<path\b/); assert.doesNotMatch(svg,/<(?:image|script|foreignObject)\b/i);
    return { input:garmentPath||fixture.name, paths:(svg.match(/<path\b/g)||[]).length, bytes:Buffer.byteLength(svg), output:"trace-default.svg", noEmbeddedBitmap:true };
  });
  await scenario("svg-trace", "change threshold and smoothing then export a distinct trace", async () => {
    const sliders=dialog().getByRole("slider"); await sliders.nth(0).press("ArrowLeft");
    await sliders.nth(2).press("ArrowRight");
    await dialog().getByText("正在描摹…",{exact:true}).waitFor();
    await page.waitForFunction(()=>!!document.querySelector('a[download$=".svg"]')?.getAttribute("href"));
    const svg=(await download(dialog().getByRole("link",{name:"下载 SVG",exact:true}),"trace-adjusted.svg")).toString(); assert.match(svg,/<path\b/); const previous=await fs.readFile(path.join(output,"trace-default.svg"),"utf8"); assert.notEqual(svg,previous);
    return { paths:(svg.match(/<path\b/g)||[]).length, bytes:Buffer.byteLength(svg), output:"trace-adjusted.svg", changedFromDefault:true };
  });

  await scenario("selection", "brush selection and persistence across dialog reopen", async () => {
    await closeDialog(); await scene("local-restyle",garment); await button("涂选修改区域").click(); const canvas=dialog().getByLabel("修改区域画布",{exact:true}); await canvas.waitFor();
    await selectionReady(); await dragCanvas(canvas,[.3,.35],[.7,.55]); const pixels=await canvasPixelsCount(canvas); assert.ok(pixels>0);
    const dimensions=await canvas.evaluate(c=>[c.width,c.height]); await dialog().getByRole("button",{name:"保存选区",exact:true}).click(); await dialog().waitFor({state:"hidden"}); await button("编辑修改选区").click();
    const restored=dialog().getByLabel("修改区域画布",{exact:true}); await selectionReady(); assert.equal(await canvasPixelsCount(restored),pixels);
    return { drawnPixels:pixels, dimensions, restoredExactly:true };
  });
  await scenario("selection", "erase, clear, empty-save guard and repaint", async () => {
    const canvas=dialog().getByLabel("修改区域画布",{exact:true}); const before=await canvasPixelsCount(canvas);
    await dialog().getByText("擦除",{exact:true}).click(); await dragCanvas(canvas,[.3,.35],[.5,.45]); const after=await canvasPixelsCount(canvas); assert.ok(after<before);
    await dialog().getByRole("button",{name:/清\s*空/}).click(); assert.equal(await canvasPixelsCount(canvas),0);
    await dialog().getByRole("button",{name:"保存选区",exact:true}).click(); await dialog().getByText("请先涂选需要修改的区域",{exact:true}).waitFor();
    await dialog().getByText("涂选",{exact:true}).click(); await dragCanvas(canvas,[.45,.25],[.55,.75]); assert.ok(await canvasPixelsCount(canvas)>0);
    await dialog().getByRole("button",{name:"保存选区",exact:true}).click(); await dialog().waitFor({state:"hidden"}); return { before, afterErase:after, clearWorked:true, emptySaveBlocked:true, repaintSaved:true };
  });

  await scenario("placement", "upload garment and motif, resize and rotate, export full-size composition", async () => {
    await page.goto(`${origin}/creative/pattern-placement`, {waitUntil:"domcontentloaded"}); await button("胸前花朵").waitFor(); await page.locator('[data-input="base"]').setInputFiles(garment); await page.locator('[data-input="art"]').setInputFiles(fixture); await button(fixture.name).waitFor();
    await numeric("图案宽度",80); await numeric("旋转角度",25); await numeric("横向 X",100); await numeric("纵向 Y",100);
    const dimensions=await page.locator(".placement-demo canvas").evaluate(c=>[c.width,c.height]);
    const png=await download(button("导出合成 PNG"),"placement-composite.png"); assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],dimensions);
    const project=JSON.parse((await download(button("导出工程 JSON"),"placement-project.json")).toString()); assert.equal(project.layers.at(-1).width,80); assert.equal(project.layers.at(-1).rotation,25);
    return { dimensions, layers:project.layers.length, output:"placement-composite.png", project:"placement-project.json" };
  });
  await scenario("placement", "duplicate, undo and restore editable local project", async () => {
    const count=await page.locator(".placement-layer").count(); await button("复制").click(); assert.equal(await page.locator(".placement-layer").count(),count+1); await button("撤销").click(); assert.equal(await page.locator(".placement-layer").count(),count);
    await button("本地保存").click(); await page.getByText(/本地已保存 ·/).waitFor(); await numeric("图案宽度",120); await button("打开本地工程").click(); await page.waitForFunction(()=>document.querySelector('input[data-prop="width"]')?.value==="80");
    const project=await fs.readFile(path.join(output,"placement-project.json")); await button("删除").click(); await page.locator('[data-input="project"]').setInputFiles({name:"restore.json",mimeType:"application/json",buffer:project}); await button(fixture.name).waitFor();
    assert.equal(await page.getByRole("spinbutton",{name:"图案宽度",exact:true}).inputValue(),"80"); return { duplicateUndo:true, savedWidthRestored:80, jsonImport:true };
  });

  await scenario("repeat", "half-drop physical dimensions and imported motif export", async () => {
    await page.goto(`${origin}/creative/pattern-repeat`, {waitUntil:"domcontentloaded"}); await page.getByTestId("repeat-canvas").waitFor(); await page.locator('[data-role="image-file"]').setInputFiles(garment); await page.locator('[data-role="layers"] button').nth(7).waitFor();
    await page.getByTestId("repeat-width").fill("5"); await page.getByTestId("repeat-width").press("Tab"); await page.getByTestId("repeat-height").fill("4"); await page.getByTestId("repeat-height").press("Tab"); await page.getByTestId("repeat-dpi").selectOption("150");
    await page.getByTestId("repeat-mode-half").click(); await page.getByTestId("repeat-size").fill("0.4"); await page.getByTestId("repeat-angle").fill("42");
    const png=await download(page.getByTestId("repeat-export-unit"),"repeat-half.png"); assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[590,236]);
    const project=JSON.parse((await download(page.getByTestId("repeat-export-json"),"repeat-project.json")).toString()); assert.equal(project.elements.at(-1).angle,42); assert.equal(project.metadata.pngDpiMetadata,false);
    await page.getByTestId("repeat-save").click(); await page.locator('[data-role="status"]').filter({hasText:"已保存"}).waitFor(); return { output:"repeat-half.png", dimensions:[590,236], cm:[5,4],dpi:150,noPngDpiClaim:true };
  });
  await scenario("repeat", "mirror repeat, transparent export and oversized-export guard", async () => {
    await page.getByTestId("repeat-mode-mirror").click(); await page.getByTestId("repeat-transparent").check();
    const png=await download(page.getByTestId("repeat-export-unit"),"repeat-mirror-transparent.png"); assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[590,472]);
    await page.getByTestId("repeat-width").fill("60"); await page.getByTestId("repeat-width").press("Tab"); assert.equal(await page.getByTestId("repeat-export-unit").isDisabled(),true);
    await page.getByTestId("repeat-restore").click(); await page.locator('[data-testid="repeat-mode-half"][aria-pressed="true"]').waitFor(); assert.equal(await page.getByTestId("repeat-export-unit").isDisabled(),false);
    return { output:"repeat-mirror-transparent.png", dimensions:[590,472], oversizedExportBlocked:true, restoredHalfDrop:true };
  });

  await scenario("assets-ui", "search and clear a mocked empty server catalog", async () => {
    await page.goto(`${origin}/assets`,{waitUntil:"domcontentloaded"});
    const search=page.getByPlaceholder("搜索标题、内容、标签或来源"); await search.fill("针织毛衫QA"); await page.getByText("没有找到匹配素材",{exact:true}).waitFor();
    await button("清除筛选").click(); assert.equal(await search.inputValue(),""); await page.getByText("先收好你的第一份素材",{exact:true}).waitFor();
    return { scope:"UI only; mocked empty catalog", searchAndClear:true, backendPersistence:"not tested" };
  });
  await scenario("assets-ui", "compose text asset preview and cancel without saving", async () => {
    await button("新增素材").click(); await dialog().getByPlaceholder("给素材起一个容易检索的名字").fill("针织开衫测试说明");
    await dialog().getByPlaceholder("保存提示词、说明文案、参考描述等文本素材").fill("复杂费尔岛针织开衫；只预览，不上传服务器。");
    await dialog().getByText("针织开衫测试说明",{exact:true}).waitFor(); await closeDialog();
    return { scope:"local form only", preview:true, cancelled:true, serverWrites:0 };
  });
  await scenario("prompts-ui", "search and clear personal template filters", async () => {
    await page.goto(`${origin}/my-prompts`,{waitUntil:"domcontentloaded"}); const search=page.getByPlaceholder("搜索名称、提示词或分类"); await search.fill("针织QA");
    await page.getByText("没有匹配的模板",{exact:true}).waitFor(); await button("清除筛选").click(); assert.equal(await search.inputValue(),"");
    return { scope:"UI only; mocked empty templates", searchAndClear:true, backendPersistence:"not tested" };
  });
  await scenario("prompts-ui", "new template required-field validation before any API write", async () => {
    await button("新建模板").click(); await dialog().getByRole("button",{name:"保存模板",exact:true}).click();
    await dialog().locator(".ant-form-item-explain-error").first().waitFor(); const validation=await dialog().locator(".ant-form-item-explain-error").allTextContents(); assert.ok(validation.length>=2);
    await dialog().getByPlaceholder("例如：女装白底商品图").fill("复杂针织开衫提示词"); await dialog().getByPlaceholder("保存可以直接复用的完整提示词").fill("保留费尔岛图案、绞花组织和开衫纽扣结构。"); await closeDialog();
    return { validation, draftEntry:true, cancelled:true, serverWrites:0 };
  });
  await scenario("reference-import-ui", "empty URL and empty import remain disabled", async () => {
    await page.goto(`${origin}/reference-import`,{waitUntil:"domcontentloaded"}); await page.getByTestId("reference-scan").waitFor();
    assert.equal(await page.getByTestId("reference-scan").isDisabled(),true); assert.equal(await page.getByTestId("reference-confirm").isDisabled(),true);
    await page.getByLabel("公开网页链接",{exact:true}).fill("not a url"); await page.getByTestId("reference-scan").click();
    assert.equal(await page.getByLabel("公开网页链接",{exact:true}).evaluate(x=>x.validity.valid),false); assert.equal(await page.getByTestId("reference-draft").count(),0);
    return { emptyScanDisabled:true, emptyImportDisabled:true, malformedUrlBlockedByBrowser:true, actualRemoteCollection:"not tested" };
  });
  await scenario("reference-import-ui", "expand optional extension guidance and return to assets", async () => {
    await page.getByText("可选：使用 Chrome 扩展采集当前网页",{exact:true}).click(); await page.getByText("chrome://extensions",{exact:true}).waitFor();
    const back=page.getByRole("link",{name:"返回素材库",exact:true}); await back.click(); await page.waitForURL(`${origin}/assets`);
    return { extensionInstructionsVisible:true, returnToAssets:true, extensionInstall:"not performed", remoteImport:"not tested" };
  });
  await scenario("company-library-ui", "OA-disabled mode blocks company sharing", async () => {
    await page.goto(`${origin}/design-library`,{waitUntil:"domcontentloaded"}); await page.getByRole("heading",{name:"公司共享需要员工身份",exact:true}).waitFor();
    assert.equal(await button("分享我的设计").count(),0); return { oaEnabled:false, shareActionAbsent:true, corporateBackend:"not tested" };
  });
  await scenario("company-library-ui", "direct publish query cannot bypass employee identity gate", async () => {
    await page.goto(`${origin}/design-library?publish=1`,{waitUntil:"domcontentloaded"}); await page.getByRole("heading",{name:"公司共享需要员工身份",exact:true}).waitFor();
    assert.equal(await dialog().count(),0); assert.equal(await button("分享我的设计").count(),0);
    return { directPublishBlocked:true, corporateBackend:"not tested" };
  });
} finally {
  report.finishedAt=new Date().toISOString(); report.passed=report.scenarios.length>=14&&report.scenarios.every(x=>x.status==="passed")&&report.pageErrors.length===0;
  report.realNetworkWrites=0; report.paidCalls=0;
  await fs.writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,scenarios:report.scenarios.map(({tool,name,status,error})=>({tool,name,status,error})),blocked:report.blocked,pageErrors:report.pageErrors,output},null,2));
  await context.close();await browser.close(); if(!report.passed) process.exitCode=1;
}
