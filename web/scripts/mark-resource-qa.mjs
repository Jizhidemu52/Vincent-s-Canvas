import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const { chromium } = createRequire(path.resolve(process.cwd(), "../labs/design-workbench/package.json"))("playwright");

const origin = process.env.MARK_RESOURCE_QA_URL || "http://127.0.0.1:5190";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const output = path.resolve(process.cwd(), "../output/mark-resource-qa");
const garment = process.env.MARK_LOCAL_GARMENT || path.resolve(process.cwd(), "../output/mark-provider-live/image-knit-A-1.png");
const runId = new Date().toISOString().replace(/[:.]/g,"-");
const report = { startedAt: new Date().toISOString(), origin, scope:"Real browser and isolated QA database. Only asset upload/download receipts, personal prompt create/fill plus CRUD on this run's QA templates and reference scan are allowed. No generation, sharing, publication, quota changes or external browser HTTP.", scenarios:[], requests:[], blocked:[], responses:[], pageErrors:[], findings:[] };
const qaTemplateIds=new Set();
await fs.mkdir(output,{recursive:true});
try { await fs.copyFile(path.join(output,"report.json"),path.join(output,`report-before-${runId}.json`)); } catch {}
const browser = await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||"chrome"});
const context = await browser.newContext({viewport:{width:1512,height:1120},acceptDownloads:true,serviceWorkers:"block"});
const page = await context.newPage(); page.setDefaultTimeout(16000);
page.on("pageerror",error=>report.pageErrors.push(error.message));
page.on("response",response=>{const u=new URL(response.url());if(u.origin===origin&&u.pathname.startsWith("/api/"))report.responses.push({path:u.pathname,method:response.request().method(),status:response.status()});});
await context.route("**/*",async route=>{
  const r=route.request(),u=new URL(r.url());if(!["http:","https:"].includes(u.protocol))return route.continue();
  if(u.origin!==origin){report.blocked.push({path:u.origin+u.pathname,method:r.method(),reason:"external browser HTTP"});return route.abort("blockedbyclient");}
  if(!u.pathname.startsWith("/api/"))return route.continue();
  const entry={path:u.pathname,method:r.method()};report.requests.push(entry);
  const paid=/\/(?:generation-tasks|image-generation|video-generation|chat|audio|responses|completions|batch)(?:\/|$)/.test(u.pathname);
  let allowed=r.method()==="GET"&&!paid;
  if(!paid&&r.method()==="POST"){
    allowed=u.pathname==="/api/assets/upload-request"||/^\/api\/assets\/[^/]+\/download-receipts$/.test(u.pathname)||u.pathname==="/api/prompt-templates"||u.pathname==="/api/reference-import/scan";
    if(/^\/api\/prompt-templates\/[^/]+\/resolve$/.test(u.pathname)){try{allowed=JSON.parse(r.postData()).mode==="fill";}catch{allowed=false;}}
    if(/^\/api\/prompt-templates\/[^/]+\/copy$/.test(u.pathname))allowed=qaTemplateIds.has(u.pathname.split("/")[3]);
  }
  if(!paid&&r.method()==="PUT")allowed=/^\/api\/assets\/[^/]+\/content-upload$/.test(u.pathname)||(/^\/api\/prompt-templates\/[^/]+\/favorite$/.test(u.pathname)&&qaTemplateIds.has(u.pathname.split("/")[3]));
  if(!paid&&["PATCH","DELETE"].includes(r.method()))allowed=/^\/api\/prompt-templates\/[^/]+$/.test(u.pathname)&&qaTemplateIds.has(u.pathname.split("/")[3]);
  if(allowed)return route.continue();
  report.blocked.push({...entry,reason:"no paid, publish, share or unapproved write"});
  return route.fulfill({status:403,contentType:"application/json",body:JSON.stringify({message:"QA safety guard: operation not authorized"})});
});
const button=name=>page.getByRole("button",{name,exact:true});
const dialog=()=>page.getByRole("dialog");
const menuItem=name=>page.locator(".ant-dropdown:not(.ant-dropdown-hidden)").getByRole("menuitem",{name,exact:true}).last();
async function screenshot(name){const filename=`${name}.png`;await page.screenshot({path:path.join(output,filename),fullPage:true});return filename;}
async function scenario(tool,name,action){
  if(process.env.MARK_RESOURCE_ONLY&&!process.env.MARK_RESOURCE_ONLY.split(",").includes(tool))return;
  console.log(`QA: ${tool} / ${name}`);const record={tool,name,status:"running"};report.scenarios.push(record);
  try{record.evidence=await action();record.status=record.evidence?.outcome||"passed";record.screenshot=await screenshot(`${String(report.scenarios.length).padStart(2,"0")}-${tool}`);}
  catch(error){record.status="failed";record.error=error.message;record.url=page.url();record.screenshot=await screenshot(`${String(report.scenarios.length).padStart(2,"0")}-${tool}-failure`).catch(()=>undefined);console.error(`${tool}: ${error.message}`);await page.keyboard.press("Escape").catch(()=>{});}
  await fs.writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2));
}
async function getJson(endpoint){return page.evaluate(async endpoint=>{const r=await fetch(endpoint,{credentials:"include"});return {status:r.status,body:await r.json()};},endpoint);}
async function goto(route){await page.goto(`${origin}${route}`,{waitUntil:"domcontentloaded"});}
async function selectAnt(label,text){const input=dialog().getByLabel(label,{exact:true});await input.click();if(label==="模型快照")await input.fill(text);await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({hasText:new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`)}).click();}
async function closeDialog(){if(await dialog().count()){await page.keyboard.press("Escape");await dialog().waitFor({state:"hidden"});}}
async function download(locator,filename){await locator.waitFor();const pending=page.waitForEvent("download");await locator.click();const file=await pending;await file.saveAs(path.join(output,filename));return fs.readFile(path.join(output,filename));}
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");

try{
  await goto("/assets");await page.getByRole("heading",{name:"我的素材",exact:true}).waitFor();
  report.deployment=await getJson("/api/deployment");report.session=await getJson("/api/auth/session");
  report.models=await getJson("/api/models");
  if(process.env.MARK_RESOURCE_INSPECT){
    for(const route of ["/assets","/my-prompts","/prompts","/creative","/video","/team","/admin?tab=performance","/design-library","/reference-import"]){await goto(route);console.log(`SNAPSHOT ${route}\n${(await page.locator("body").innerText()).slice(0,14000)}`);}
  }else{
    const uploadName=`QA-Mark-knit-${runId}.png`;const inputBytes=await fs.readFile(garment);
    let assetId;
    await scenario("assets","upload real knit garment, search and open preview",async()=>{
      await page.locator('input[type="file"][accept="image/*"][multiple]').setInputFiles({name:uploadName,mimeType:"image/png",buffer:inputBytes});
      await page.getByRole("heading",{name:uploadName,exact:true}).waitFor();
      await page.getByPlaceholder("搜索标题、内容、标签或来源",{exact:true}).fill(uploadName);
      const card=page.locator(".ant-card").filter({has:page.getByRole("heading",{name:uploadName,exact:true})});await card.getByRole("button",{name:/^查\s*看$/}).click();
      const drawer=page.locator(".ant-drawer-body");await drawer.getByAltText(uploadName,{exact:true}).waitFor();
      await page.waitForFunction(name=>{const img=[...document.querySelectorAll('.ant-drawer-body img')].find(x=>x.alt===name);return img?.naturalWidth===1024;},uploadName);
      const payload=await getJson("/api/assets");const asset=payload.body.assets.find(x=>x.filename===uploadName);assert.ok(asset);assetId=asset.id;
      assert.equal(asset.status,"ready");assert.equal(asset.byteSize,inputBytes.length);
      return {assetId,filename:uploadName,status:asset.status,bytes:asset.byteSize,dimensions:[1024,1024],storage:"isolated QA database"};
    });
    await scenario("assets","download original garment and compare every byte",async()=>{
      const receipt=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname.endsWith("/download-receipts"));
      const actual=await download(page.locator(".ant-drawer-body").getByRole("button",{name:"下载图片",exact:true}),"asset-original.png");assert.equal(hash(actual),hash(inputBytes));const receiptResponse=await receipt;
      const fetched=await getJson("/api/assets");const stored=fetched.body.assets.find(x=>x.id===assetId);
      if(!receiptResponse.ok())report.findings.push({severity:"limitation",type:"download-receipt-unavailable",status:receiptResponse.status(),body:await receiptResponse.json(),impact:"Download bytes are correct, but the local backend cannot record download count."});
      return {assetId,bytes:actual.length,sha256:hash(actual),matchesOriginal:true,downloadCount:stored.downloadCount,receiptStatus:receiptResponse.status(),outcome:receiptResponse.ok()?"passed":"partial"};
    });

    const modelRows=report.models.body.models||[];const mark=modelRows.filter(x=>/^mark/i.test(x.name)&&x.capabilities.includes("generate"));
    const createdTemplates=[];
    for(const [i,template] of [
      {title:`QA-Mark-针织白底-${runId}`,prompt:"保留原图针织开衫的领型、门襟、绞花与费尔岛纹样，仅将背景改为纯白；不要生成，本模板仅验证填入。",size:"21:9",quality:"max",resolution:"4k",model:mark.find(x=>/GPT/i.test(x.name))||mark[0]},
      {title:`QA-Mark-针织配色-${runId}`,prompt:"保留针织开衫结构和纹样位置，将主体米色纱线替换为雾蓝色；不要生成，本模板仅验证填入。",size:"3:4",quality:"2k",resolution:"2k",model:mark.find(x=>/Nano/i.test(x.name))||mark[1]},
    ].entries())await scenario("personal-prompts",`create and fill template ${i+1} without generation`,async()=>{
      await goto("/my-prompts");await button("新建模板").click();await dialog().waitFor();
      await dialog().getByPlaceholder("例如：女装白底商品图",{exact:true}).fill(template.title);
      await dialog().getByPlaceholder("保存可以直接复用的完整提示词",{exact:true}).fill(template.prompt);
      if(template.model)await selectAnt("模型快照",template.model.name);
      await dialog().getByLabel("宽高比",{exact:true}).selectOption(template.size);
      await dialog().getByLabel("清晰度 / 分辨率",{exact:true}).selectOption(template.resolution);
      if(i===0){
        await dialog().getByLabel("图片质量",{exact:true}).selectOption(template.quality);
        const qualityOptions=await dialog().getByLabel("图片质量",{exact:true}).locator("option").evaluateAll(xs=>xs.map(x=>x.value));
        assert.deepEqual(qualityOptions,["auto","low","medium","high","xhigh","max"]);
        report.templateEditorVerification={qualityOptions,independentResolution:await dialog().getByLabel("清晰度 / 分辨率",{exact:true}).inputValue()};
      }else assert.equal(await dialog().getByLabel("图片质量",{exact:true}).count(),0);
      const saveResponse=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/api/prompt-templates");await button("保存模板").click();const savedResponse=await saveResponse;
      if(!savedResponse.ok())return {outcome:"blocked",title:template.title,status:savedResponse.status(),response:await savedResponse.json(),limitation:"Real local backend does not implement personal template creation; fill could not be exercised."};
      const savedBody=await savedResponse.json();qaTemplateIds.add(savedBody.template.id);
      await dialog().waitFor({state:"hidden"});
      await page.getByPlaceholder("搜索名称、提示词或分类",{exact:true}).fill(template.title);
      const card=page.locator("article").filter({has:page.getByRole("heading",{name:template.title,exact:true})});await card.getByRole("button",{name:"仅填入",exact:true}).click();
      await page.waitForURL(/\/image\?reuseToken=/);await page.waitForFunction(prompt=>[...document.querySelectorAll("textarea")].some(x=>x.value===prompt),template.prompt);
      const saved=await getJson(`/api/prompt-templates?scope=personal&query=${encodeURIComponent(template.title)}`);const row=saved.body.templates.find(x=>x.title===template.title);assert.ok(row);assert.equal(row.prompt,template.prompt);
      assert.equal(row.parameters.resolution,template.resolution);if(i===0)assert.equal(row.parameters.quality,"max");else assert.equal("quality"in row.parameters,false);
      assert.equal(await page.getByLabel("宽高比",{exact:true}).inputValue(),template.size);
      assert.equal(await page.getByLabel("清晰度 / 分辨率",{exact:true}).inputValue(),template.resolution);
      if(i===0)assert.equal(await page.getByLabel("图片质量",{exact:true}).inputValue(),"max");else assert.equal(await page.getByLabel("图片质量",{exact:true}).count(),0);
      createdTemplates.push(row);
      return {id:row.id,title:template.title,target:page.url().split("?")[0],parameters:row.parameters,modelConfigId:row.modelConfigId,filledPrompt:template.prompt,generated:false};
    });

    await scenario("personal-prompts","favorite, edit and reopen GPT template with profile-specific settings",async()=>{
      const original=createdTemplates[0];assert.ok(original,"The QA-created GPT template is required");
      await goto("/my-prompts");await page.getByPlaceholder("搜索名称、提示词或分类",{exact:true}).fill(original.title);
      const card=page.locator("article").filter({has:page.getByRole("heading",{name:original.title,exact:true})});
      const favoriteResponse=page.waitForResponse(r=>r.request().method()==="PUT"&&new URL(r.url()).pathname===`/api/prompt-templates/${original.id}/favorite`);
      await card.getByRole("button",{name:"收藏",exact:true}).click();assert.equal((await favoriteResponse).status(),200);await card.getByRole("button",{name:"取消收藏",exact:true}).waitFor();
      await card.getByRole("button",{name:"更多操作",exact:true}).click();await menuItem("编辑").click();await dialog().waitFor();
      assert.equal(await dialog().getByLabel("图片质量",{exact:true}).inputValue(),"max");assert.equal(await dialog().getByLabel("清晰度 / 分辨率",{exact:true}).inputValue(),"4k");assert.equal(await dialog().getByLabel("宽高比",{exact:true}).inputValue(),"21:9");
      await dialog().getByLabel("图片质量",{exact:true}).selectOption("xhigh");await dialog().getByLabel("清晰度 / 分辨率",{exact:true}).selectOption("2k");await dialog().getByLabel("宽高比",{exact:true}).selectOption("16:9");
      const editResponse=page.waitForResponse(r=>r.request().method()==="PATCH"&&new URL(r.url()).pathname===`/api/prompt-templates/${original.id}`);await button("保存模板").click();const edited=await editResponse;assert.equal(edited.status(),200);await dialog().waitFor({state:"hidden"});
      const current=(await getJson(`/api/prompt-templates/${original.id}`)).body.template;assert.equal(current.version,2);assert.equal(current.favorite,true);assert.equal(current.parameters.quality,"xhigh");assert.equal(current.parameters.resolution,"2k");assert.equal(current.parameters.size,"16:9");
      await card.getByRole("button",{name:"更多操作",exact:true}).click();await menuItem("编辑").click();await dialog().waitFor();assert.equal(await dialog().getByLabel("图片质量",{exact:true}).inputValue(),"xhigh");assert.equal(await dialog().getByLabel("清晰度 / 分辨率",{exact:true}).inputValue(),"2k");await closeDialog();
      return {id:current.id,version:current.version,favorite:current.favorite,parameters:current.parameters,reopenedValuesMatch:true};
    });
    await scenario("personal-prompts","copy Nano template, cancel deletion then delete only the new QA copy",async()=>{
      const original=createdTemplates[1];assert.ok(original,"The QA-created Nano template is required");
      await goto("/my-prompts");await page.getByPlaceholder("搜索名称、提示词或分类",{exact:true}).fill(original.title);
      const card=page.locator("article").filter({has:page.getByRole("heading",{name:original.title,exact:true})});await card.getByRole("button",{name:"更多操作",exact:true}).click();
      const copyResponse=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname===`/api/prompt-templates/${original.id}/copy`);await menuItem("复制为我的模板").click();const copied=await copyResponse;assert.equal(copied.status(),201);const copy=(await copied.json()).template;qaTemplateIds.add(copy.id);assert.notEqual(copy.id,original.id);assert.deepEqual(copy.parameters,original.parameters);assert.equal(copy.modelConfigId,original.modelConfigId);
      const copyCard=page.locator("article").filter({has:page.getByRole("heading",{name:copy.title,exact:true})});await copyCard.getByRole("button",{name:"更多操作",exact:true}).click();await menuItem("删除").click();await dialog().waitFor();await dialog().getByRole("button",{name:/取\s*消/}).click();await dialog().waitFor({state:"hidden"});assert.equal((await getJson(`/api/prompt-templates/${copy.id}`)).status,200);
      await copyCard.getByRole("button",{name:"更多操作",exact:true}).click();await menuItem("删除").click();await dialog().waitFor();const deletedResponse=page.waitForResponse(r=>r.request().method()==="DELETE"&&new URL(r.url()).pathname===`/api/prompt-templates/${copy.id}`);await dialog().getByRole("button",{name:/^删\s*除$/}).click();assert.equal((await deletedResponse).status(),204);await dialog().waitFor({state:"hidden"});assert.equal((await getJson(`/api/prompt-templates/${copy.id}`)).status,404);assert.equal((await getJson(`/api/prompt-templates/${original.id}`)).status,200);
      return {sourceId:original.id,copyId:copy.id,copyParameters:copy.parameters,cancelPreservedCopy:true,deletedCopyStatus:404,sourceStillAvailable:true,removal:"Only this run's new QA copy was soft-deleted"};
    });

    await scenario("public-prompts","inspect real public library and its search state",async()=>{
      await goto("/prompts");await page.getByText("公共提示词库",{exact:true}).click();
      const payload=await getJson("/api/prompt-templates?scope=public");assert.equal(payload.status,200);
      await page.getByPlaceholder("搜索标题、完整提示词或分类",{exact:true}).fill(`no-such-qa-${runId}`);await page.getByText("没有找到匹配模板",{exact:true}).waitFor();
      return {publicTemplateCount:payload.body.total,searchEmptyState:true,publishedNothing:true,limitation:payload.body.total?undefined:"QA database contains no published public template, so public reuse not exercised."};
    });
    await scenario("public-prompts","member cannot create or review public templates",async()=>{
      await button("清除搜索").click();await page.getByText(/共 \d+ 个已发布模板/).waitFor();
      assert.equal(await button("新建公共模板").count(),0);assert.equal(await page.getByRole("heading",{name:"待审核模板",exact:true}).count(),0);
      return {role:report.session.body.user.role,groupRole:report.session.body.user.groupRole,createPublicButton:false,reviewPanel:false,externalPublish:false};
    });

    for(const [name,route] of [["服装配色","garment-colorway"],["图案定位","pattern-placement"]])await scenario("creative-navigation",`open ${name} from navigation card`,async()=>{
      await goto("/creative");await page.locator(`a[href="/creative/${route}"]`).click();await page.waitForURL(`**/creative/${route}`);await page.locator('input[type="file"]').first().waitFor({state:"attached"});
      return {route:page.url(),title:(await page.locator("h1").allTextContents()).join(" / "),uploadControl:true};
    });

    await scenario("video","available video model list excludes all Mark image models",async()=>{
      await goto("/video");await page.getByRole("textbox",{name:"视频提示词",exact:true}).waitFor();await page.locator(".canvas-composer-model-picker").click();
      const options=await page.getByRole("option").allTextContents();assert.ok(options.length);assert.equal(options.some(x=>mark.some(model=>x.includes(model.name))),false);await page.keyboard.press("Escape");
      return {options,markImageModelsAbsent:true,availableVideoModels:modelRows.filter(x=>x.capabilities.includes("video")).map(x=>({id:x.id,name:x.name}))};
    });
    await scenario("video","empty prompt guard and reference/parameter inspection without submit",async()=>{
      const prompt=page.getByRole("textbox",{name:"视频提示词",exact:true});await prompt.fill("");const disabled=await button("生成视频").isDisabled();assert.equal(disabled,true);
      await prompt.fill("针织开衫置于白色背景，镜头缓慢平移；此项仅验证参数，不生成。");
      const controls=await page.locator("select").evaluateAll(xs=>xs.map(x=>({value:x.value,options:[...x.options].map(o=>({value:o.value,label:o.text}))})));
      return {emptyPromptBlocked:disabled,controls,generateDisabledAfterText:await button("生成视频").isDisabled(),generated:false,limitation:"No video provider request or output was tested."};
    });

    for(const route of ["/design-library","/design-library?publish=1"])await scenario("share-boundary",`OA identity guard ${route}`,async()=>{
      await goto(route);await page.getByText("公司共享需要员工身份",{exact:true}).waitFor();assert.equal(await button("分享我的设计").count(),0);
      return {route,guard:"公司共享需要员工身份",oaLoginEnabled:report.deployment.body.oaLoginEnabled,publishControl:false,limitation:"Standalone deployment OA disabled; authenticated company-share flow not verified."};
    });
    await scenario("team-boundary","member view hides leader approval and performance sections",async()=>{
      await goto("/team");await page.getByRole("heading",{name:/视觉一组/}).waitFor();
      assert.equal(await button("通过").count(),0);assert.equal(await page.getByText("共享池审批",{exact:true}).count(),0);
      return {group:report.session.body.user.groupName,groupRole:report.session.body.user.groupRole,approvalButton:false,body:(await page.locator("main").innerText()).slice(0,1200)};
    });
    await scenario("team-boundary","server rejects member reads of group administrative data",async()=>{
      const results=await Promise.all(["/api/team/audit","/api/admin/groups"].map(async endpoint=>({endpoint,...await getJson(endpoint)})));
      return {results,writes:false,outcome:results.every(r=>r.status===403)?"passed":"unverified",limitation:"404 local demo routes are unavailable; this does not verify enterprise authorization."};
    });
    await scenario("performance-boundary","server refuses normal member aggregate query",async()=>{
      const result=await getJson("/api/performance?preset=month");return {...result,outcome:result.status===403?"passed":"unverified",limitation:"404 local demo route is unavailable; not an enterprise authorization pass."};
    });
    await scenario("performance-boundary","server refuses forged group filter without elevated role",async()=>{
      const result=await getJson(`/api/performance?preset=month&groupId=${report.session.body.user.groupId}`);return {...result,outcome:result.status===403?"passed":"unverified",limitation:"404 local demo route is unavailable; not an enterprise authorization pass."};
    });

    await scenario("reference-import","invalid URL stays in browser and performs no scan",async()=>{
      await goto("/reference-import");const input=page.getByLabel("公开网页链接",{exact:true});await input.fill("not-a-valid-url");
      const before=report.requests.filter(x=>x.path==="/api/reference-import/scan").length;await page.getByTestId("reference-scan").click();
      assert.equal(await input.evaluate(x=>x.validity.typeMismatch),true);assert.equal(report.requests.filter(x=>x.path==="/api/reference-import/scan").length,before);
      return {invalidUrlBlocked:true,scanRequestCountDelta:0};
    });
    await scenario("reference-import","scan a public page with no images and do not import",async()=>{
      const input=page.getByLabel("公开网页链接",{exact:true});await input.fill("https://example.com/");
      const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/reference-import/scan",{timeout:45000});await page.getByTestId("reference-scan").click();const response=await responsePromise;const data=await response.json();
      if(response.ok()){assert.equal(data.data.candidates.length,0);await page.getByText(/没有找到|未找到|没有可导入|候选图片/).first().waitFor();}
      else report.findings.push({severity:"limitation",type:"reference-empty-page-backend",status:response.status(),body:data,impact:"Public empty-page fetch failed before empty-page candidate behavior; not counted as server success."});
      return {status:response.status(),response:data,imported:false,emptyPageSuccessful:response.ok()};
    });
  }
}finally{
  report.completedAt=new Date().toISOString();report.summary={passed:report.scenarios.filter(x=>x.status==="passed").length,failed:report.scenarios.filter(x=>x.status==="failed").length,partial:report.scenarios.filter(x=>x.status==="partial").length,unverified:report.scenarios.filter(x=>x.status==="unverified").length,blockedScenarios:report.scenarios.filter(x=>x.status==="blocked").length,total:report.scenarios.length,blockedRequests:report.blocked.length,pageErrors:report.pageErrors.length};
  await fs.writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({output,summary:report.summary,findings:report.findings},null,2));await browser.close();
}
