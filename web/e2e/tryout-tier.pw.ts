import {expect,fixturePng,test} from "./fixtures";

test("HD keeps the quick image while pending and after a lost receipt, then restores it with no paid submission",async({page,api},info)=>{
    const prefix="bc000000-0000-4000-8000-00000000000",project=prefix+"1",quick=prefix+"2",hd=prefix+"3",owner="00000000-0000-4000-8000-000000000099",now=new Date().toISOString();
    const trace={version:1,rootNodeId:"sample",sourceNodeId:"sample",kind:"color",tier:"quick",prompt:"验证同一来源",picked:true,color:{name:"蓝",hex:"#223366"}};
    const node={id:"variant",type:"image",title:"蓝色试款",position:{x:245,y:184},width:218,height:225,metadata:{status:"success",serverAssetId:quick,sourceTaskId:quick,tryout:trace}};
    const original={id:quick,userId:owner,requestId:"tryout:"+owner+":"+prefix+"4",status:"success",createdAt:now,resultUrls:["/api/assets/"+quick+"/content"],failureReason:null};
    api.assetBytes.set(quick,fixturePng(65));api.tasks.set(quick,original);
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"高清原位恢复",createdAt:now,updatedAt:now,nodes:[node],connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    const current=()=>api.document(project)?.nodes[0],hdKey="tryout:"+owner+":hd:"+quick;
    let requests=0,lookups=0;
    await page.route("**/api/tasks/by-request/*",route=>{lookups++;return route.fulfill({json:{task:api.tasks.get(hd)}});});
    await page.route("**/api/tryout/quick",async route=>{
        requests++;
        expect(route.request().postDataJSON()).toEqual({kind:"refine",canvasId:project,nodeId:"variant",sourceTaskId:quick});
        api.tasks.set(hd,{...original,id:hd,requestId:hdKey,status:"waiting",resultUrls:[]});
        await route.abort("connectionreset");
    });
    const select=()=>page.locator('[data-node-id="variant"]').first().click({position:{x:42,y:35}});
    await page.goto("/canvas/"+project);await select();await page.getByRole("button",{name:"出高清",exact:true}).click();
    await expect.poll(()=>current()?.metadata.imageTask?.taskId).toBe(hd);
    await expect(page.getByRole("status").filter({hasText:"正在出高清，保留快速档"})).toBeVisible();
    expect(current().metadata).toMatchObject({status:"success",serverAssetId:quick,sourceTaskId:quick,tryout:{tier:"quick"}});
    await page.reload();
    api.assetBytes.set(hd,fixturePng(220));Object.assign(api.tasks.get(hd)!,{status:"success",resultUrls:["/api/assets/"+hd+"/content"]});
    await expect.poll(()=>current()?.metadata.tryout.tier,{timeout:35000}).toBe("hd");
    expect(current()).toMatchObject({id:"variant",width:218,height:225,position:node.position,metadata:{serverAssetId:hd,sourceTaskId:hd,tryout:{picked:true,quickTaskId:quick}}});
    expect(api.document(project)?.nodes).toHaveLength(1);
    await expect(page.getByRole("status").filter({hasText:"蓝 · 高清档"})).toBeVisible();
    await select();await expect(page.getByRole("button",{name:"恢复快速档",exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("hd-same-slot.png")});
    await page.getByRole("button",{name:"恢复快速档",exact:true}).click();
    await expect.poll(()=>current()?.metadata.tryout.tier).toBe("quick");
    expect(current()).toMatchObject({id:"variant",width:218,height:225,position:node.position,metadata:{serverAssetId:quick,sourceTaskId:quick}});
    expect(lookups).toBeGreaterThan(0);expect(requests).toBe(1);expect(api.submissions).toHaveLength(0);
});
