import {expect,test,fixturePng} from "./fixtures";

for(const mode of ["select and submit","drag onto product","image toolbar","command search","click main color"])test("one tryout request from the chosen product: "+mode,async({page,api},info)=>{
    const project="ba000000-0000-4000-8000-000000000087",asset="ba000000-0000-4000-8000-000000000088",taskId="ba000000-0000-4000-8000-000000000089",preset="ba000000-0000-4000-8000-000000000090",now=new Date().toISOString();
    const node={id:"product",type:"image",title:"试款样品",width:185,height:140,position:{x:260,y:155},metadata:{serverAssetId:asset,status:"success"}};
    api.assetBytes.set(asset,fixturePng(110));
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"试款上身",createdAt:now,updatedAt:now,nodes:[node],connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    await page.route("**/api/tryout/models",r=>r.fulfill({json:{presets:[{id:preset,identity:"white-woman",name:"女模特",audience:"women",framing:"head",assetId:preset}],mine:[],preference:{}}}));
    await page.route("**/api/tryout/models/presets/*/thumb",r=>r.fulfill({body:fixturePng(90),contentType:"image/png"}));
    const calls:Array<{nodeId:string;requestId:string}>=[];
    await page.route("**/api/tryout/quick",r=>{const req=r.request(),input=req.postDataJSON(),owner=req.headers()["x-canvas-owner-id"];calls.push(input);api.tasks.set(taskId,{id:taskId,userId:owner,requestId:"tryout:"+owner+":"+input.requestId,status:"waiting",createdAt:now,resultUrls:[],failureReason:null});return r.fulfill({json:{taskId,prompt:"隔离模特上身"}});});
    await page.goto("/canvas/"+project);
    const product=page.locator('[data-node-id="product"]').first();await product.click({position:{x:45,y:36}});
    const toolbar=page.getByRole("toolbar",{name:"图片工具栏"});
    if(mode==="image toolbar"||mode==="click main color"){
        await expect(toolbar.getByRole("button").first()).toHaveText("试色");
        await expect(toolbar.getByRole("button").nth(1)).toHaveText("上身 1 张");
        await expect(toolbar.getByRole("button").nth(2)).toHaveText("出提案");
        await toolbar.getByRole("button",{name:mode==="image toolbar"?"上身 1 张":"试色",exact:true}).click();
        if(mode==="click main color"){expect(calls).toHaveLength(0);await page.getByRole("button",{name:"拖动换色：海军蓝"}).click();}
    }else if(mode==="command search"){
        await page.keyboard.press("Control+k");const search=page.getByRole("combobox",{name:"搜索命令、节点和素材"});await search.fill("上身");expect(calls).toHaveLength(0);await search.press("Enter");
    }else{
        await page.getByRole("button",{name:"试款台",exact:true}).click();
        await page.getByRole("button",{name:"选择模特"}).click();
    const model=page.getByRole("button",{name:"女模特",exact:true});
    if(mode==="select and submit"){
        await model.click();await expect(model).toHaveAttribute("aria-pressed","true");expect(calls).toHaveLength(0);
        await page.getByRole("button",{name:"上身 1 张 · 女模特"}).click();
    }else{
        await model.scrollIntoViewIfNeeded();const a=(await model.boundingBox())!,b=(await product.boundingBox())!;
        await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:16});await page.mouse.up();
    }
    }
    await expect.poll(()=>calls.length).toBe(1);
    if(mode==="click main color"){
        expect(calls[0]).toMatchObject({kind:"color",sourceAssetId:asset,color:{hex:"#1F2F55"}});expect(calls[0]).not.toHaveProperty("fallbackHex");
    }else{
        expect(calls[0]).toMatchObject({kind:"wear",model:mode==="image toolbar"||mode==="command search"?{auto:true}:{presetIdentity:"white-woman"},productAssetIds:[asset]});
        expect(calls[0]).not.toHaveProperty("sourceAssetId");
    }
    const output=()=>api.document(project)?.nodes.find((n:{id:string})=>n.id===calls[0].nodeId);
    await expect.poll(()=>output()?.metadata.imageTask?.taskId).toBe(taskId);
    expect(output().position).toEqual(mode==="click main color"?{x:481,y:155}:{x:260,y:331});
    expect(output().metadata.tryout).toMatchObject(mode==="click main color"?{kind:"color",sourceNodeId:"product"}:{kind:"wear",sourceNodeId:"product",products:["product"]});
    await page.screenshot({path:info.outputPath("tryout-result.png")});await page.reload();await expect(product).toBeVisible();expect(calls).toHaveLength(1);
});
