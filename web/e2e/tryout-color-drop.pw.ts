import {expect,fixturePng,test} from "./fixtures";

for(const mode of ["acknowledged color","lost submission response","preset material","chosen material","live first display"])test("a canvas background drop costs nothing and a whole-product drop survives reload: "+mode,async({page,api},info)=>{
    const lostAck=mode==="lost submission response",material=mode.endsWith("material"),presetId="60000000-0000-4000-8000-000000000001";
    const project="ba000000-0000-4000-8000-000000000001",asset="ba000000-0000-4000-8000-000000000002",taskId="ba000000-0000-4000-8000-000000000003";
    const png=await page.evaluate(()=>{
        const canvas=document.createElement("canvas");canvas.width=canvas.height=256;const ctx=canvas.getContext("2d")!;
        ctx.fillStyle="#fff";ctx.fillRect(0,0,256,256);ctx.fillStyle="#263754";ctx.fillRect(32,36,192,185);
        return canvas.toDataURL().split(",")[1];
    });
    api.assetBytes.set(asset,Buffer.from(png,"base64"));
    const now=new Date().toISOString(),nodes=[{id:"sample",type:"image",title:"隔离色块样品",width:220,height:220,position:{x:250,y:180},metadata:{serverAssetId:asset,status:"success"}}];
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"拖色恢复验证",createdAt:now,updatedAt:now,nodes,connections:[],groups:[],...(material?{tryoutKit:{version:1,colors:[],materials:[]}}:{}),viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    const calls:Array<{requestId:string;nodeId:string;sourceAssetId:string}>=[];
    const inspect=mode==="acknowledged color";
    const live=mode==="live first display",displays:Array<{source:string;droppedAt:number;submittedAt:number;shownAt:number}>=[];
    await page.route("**/api/tryout/results/"+taskId+"/display",route=>{expect(route.request().headers()["x-canvas-owner-id"]).toBeTruthy();displays.push(route.request().postDataJSON());return route.fulfill({status:204});});
    api.productCardsEnabled=inspect;
    let visible=false,observations=0,edits=0;
    let card={version:2,view:"flat",background:"白",items:[{category:"针织帽",parts:["帽体","翻边"],material:"罗纹",audience:"unknown",wearPosition:"head",colors:[{name:"蓝",hex:"#263754",part:"帽体"}],pattern:"",primary:true}]};
    if(inspect)await page.route("**/api/assets/"+asset+"/product-card",async route=>{
        const method=route.request().method();
        if(method==="POST")observations++;
        if(method==="PUT"){edits++;card=route.request().postDataJSON();}
        return route.fulfill({json:visible?{status:"ready",card}:{status:"pending"}});
    });
    let lookups=0;
    await page.route("**/api/tasks/by-request/*",route=>{
        const requestId=decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        lookups++;const task=api.tasks.get(taskId);
        return task?.requestId===requestId?route.fulfill({json:{task}}):route.fulfill({status:404,json:{}});
    });
    await page.route("**/api/tryout/quick",async route=>{
        const req=route.request(),input=req.postDataJSON(),owner=req.headers()["x-canvas-owner-id"];
        calls.push(input);api.tasks.set(taskId,{id:taskId,userId:owner,requestId:"tryout:"+owner+":"+input.requestId,status:"waiting",createdAt:now,resultUrls:[],failureReason:null});
        if(lostAck)await route.abort("connectionreset");
        else await route.fulfill({json:{taskId,prompt:"隔离供应商 · 整件试款"}});
    });
    await page.goto("/canvas/"+project);if(inspect){await expect(page.locator('[data-node-id="sample"] img[data-canvas-image-resolution]')).toBeVisible();await expect(page.getByRole("button",{name:"修改产品标签"})).toHaveCount(0);expect(observations).toBe(0);}await page.getByRole("button",{name:"试款台",exact:true}).click();
    if(material){
        await page.route("**/api/materials",route=>route.fulfill({json:{presets:[{id:presetId,name:"粗针",description:"线圈粗大",thumbAssetId:null}],mine:[]}}));
        await page.getByRole("button",{name:"从材质库换材质"}).click();const dialog=page.getByRole("dialog",{name:"材质库"});
        await dialog.getByRole("button",{name:"粗针",exact:true}).click();await expect(dialog.getByText("线圈粗大")).toBeVisible();
        await dialog.getByRole("button",{name:"加为新的"}).click();
        await expect.poll(()=>api.document(project)?.tryoutKit?.materials[0]?.presetId).toBe(presetId);
    }
    const swatch=page.getByRole("button",{name:material?"拖动换材质：粗针":"拖动换色：酒红",exact:true}),img=page.locator('[data-node-id="sample"] img[data-canvas-image-resolution]').first();
    await expect(img).toBeVisible();await expect.poll(()=>img.evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect.poll(()=>api.tryoutPrewarms.filter(a=>a===asset)).toHaveLength(1);expect(calls).toHaveLength(0);
    const drop=async(frac:number)=>{
        const a=(await swatch.boundingBox())!,b=(await img.boundingBox())!;
        await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width*frac,b.y+b.height*frac,{steps:12});await page.mouse.up();
    };
    await swatch.click();if(material)await expect(swatch).toHaveAttribute("aria-pressed","true");else await expect(page.getByRole("status").filter({hasText:"拖到产品上松手"})).toBeVisible();expect(calls).toHaveLength(0);
    await drop(-.35);expect(calls).toHaveLength(0);
    if(mode==="chosen material"){
        await img.locator('xpath=ancestor::*[@data-node-id][1]').click();
        const apply=page.getByRole("button",{name:/换材质 · 粗针 · 1 款/});await expect(apply).toBeEnabled();expect(calls).toHaveLength(0);
        await apply.click();
    }else await drop(.5);
    await expect(page.getByRole("dialog",{name:/圈选换料部位/})).toHaveCount(0);
    await expect.poll(()=>calls.length).toBe(1);
    if(inspect){
        expect(observations).toBeGreaterThan(0);await expect(page.getByRole("button",{name:"修改产品标签"})).toHaveCount(0);
        visible=true;
        const chip=page.getByRole("button",{name:"修改产品标签"});
        await chip.click();await page.getByRole("textbox",{name:"品类",exact:true}).fill("翻边冷帽");await page.getByRole("textbox",{name:"部位 1",exact:true}).fill("帽身");
        await page.getByRole("button",{name:"保存标签",exact:true}).click();await expect(chip).toHaveText(/翻边冷帽/);
        expect(edits).toBe(1);expect(card.items[0]?.colors[0]?.part).toBe("帽身");
        const imageBox=(await img.boundingBox())!, labelBox=(await chip.boundingBox())!;
        expect(labelBox.y).toBeGreaterThanOrEqual(imageBox.y+imageBox.height-1);
        await page.screenshot({path:info.outputPath("corrected-product-card.png")});
        await page.getByRole("button",{name:"收起试款台",exact:true}).click();await expect(chip).toHaveCount(0);
        await page.getByRole("button",{name:"试款台",exact:true}).click();await expect(chip).toHaveText(/翻边冷帽/);
    }
    const output=()=>api.document(project)?.nodes.find((n:any)=>n.id===calls[0]?.nodeId);
    await expect.poll(()=>output()?.metadata.imageTask?.taskId).toBe(taskId);
    expect(calls[0]).toMatchObject(material?{sourceAssetId:asset,kind:"material",tier:"quick",material:{presetId}}:{sourceAssetId:asset,kind:"color",tier:"quick",color:{name:"酒红",hex:"#7A1F2B"}});
    for(const key of ["fallbackHex","targetPoint","boundary","part"]) expect(calls[0]).not.toHaveProperty(key);
    expect(output().position.x).toBeGreaterThanOrEqual(nodes[0].position.x+nodes[0].width);
    expect(api.document(project)?.nodes.find((n:any)=>n.id==="sample")).toMatchObject(nodes[0]);
    const saved=output().metadata.imageTask.requestId;
    if(!live)await page.reload();
    if(inspect)await expect(page.getByRole("button",{name:"修改产品标签"})).toHaveText(/翻边冷帽/);
    const task=api.tasks.get(taskId)!;api.assetBytes.set(taskId,fixturePng(68));Object.assign(task,{status:"success",resultUrls:["/api/assets/"+taskId+"/content"],completedAt:new Date().toISOString()});
    await expect.poll(()=>output()?.metadata.status,{timeout:35000}).toBe("success");
    expect(output().metadata.imageTask).toBeUndefined();expect(task.requestId).toBe(saved);
    expect(output().metadata.tryout).toMatchObject({kind:material?"material":"color",sourceNodeId:"sample",rootNodeId:"sample"});
    expect(calls).toHaveLength(1);expect(api.submissions).toHaveLength(0);
    if(live){await expect.poll(()=>displays.length).toBe(1);const d=displays[0];expect(d.source).toBe("original");expect(d.shownAt).toBeGreaterThanOrEqual(d.submittedAt);expect(d.submittedAt).toBeGreaterThanOrEqual(d.droppedAt);}
    else expect(displays).toHaveLength(0);
    if(lostAck)expect(lookups).toBeGreaterThan(0);
    await page.screenshot({path:info.outputPath("recovered-color.png")});
});
