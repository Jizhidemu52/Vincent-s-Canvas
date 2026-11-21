import {expect,test,fixturePng} from "./fixtures";

test("multi-selected product nodes each get a separate wear placeholder, not a single combined outfit",async({page,api})=>{
    const project="e0000000-0000-4000-8000-000000000031",now=new Date().toISOString();
    const assets=[1,2].map(i=>"e0000000-0000-4000-8000-00000000000"+i);
    const nodes=assets.map((id,i)=>{api.assetBytes.set(id,fixturePng(100+i));return {id:"style"+i,type:"image",title:"试款"+i,width:150,height:130,position:{x:140+230*i,y:150},metadata:{serverAssetId:id,status:"success"}};});
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"多款上身",createdAt:now,updatedAt:now,nodes,connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    let batches=0,singles=0;
    await page.route("**/api/tryout/quick",r=>{singles++;return r.abort();});
    await page.route("**/api/tryout/quick/batch",r=>{batches++;const req=r.request(),owner=req.headers()["x-canvas-owner-id"],items=req.postDataJSON().items;
        expect(items.map((i:{productAssetIds:string[]})=>i.productAssetIds)).toEqual(assets.map(a=>[a]));
        const tasks=items.map((item:{requestId:string;model:unknown},i:number)=>{expect(item.model).toEqual({auto:true});
            const taskId="e0000000-0000-4000-8000-00000000002"+i;api.tasks.set(taskId,{id:taskId,requestId:"tryout:"+owner+":"+item.requestId,userId:owner,status:"waiting",createdAt:now,resultUrls:[],failureReason:null});
            return {requestId:item.requestId,taskId,prompt:"模拟上身"};});return r.fulfill({json:{tasks}});
    });
    await page.goto("/canvas/"+project);await page.locator('[data-node-id="style0"]').first().click({position:{x:28,y:28}});
    await page.keyboard.press("Control+a");await page.getByRole("button",{name:"试款台",exact:true}).click();
    await page.getByRole("button",{name:"全部上身 2 张 · 自动配模特"}).click();
    const outputs=()=>(api.document(project)?.nodes??[]).filter((n:any)=>n.metadata.tryout?.kind==="wear"&&n.metadata.imageTask?.taskId);
    await expect.poll(()=>outputs().length).toBe(2);
    expect(outputs().map((n:any)=>[n.metadata.tryout.sourceNodeId,n.position.x,n.position.y])).toEqual([["style0",140,316],["style1",370,316]]);
    expect(singles).toBe(0);expect(batches).toBe(1);
});

for(const mode of ["cancel queued","partial receipts","lost batch response"])test("one color palette gesture uses one batch and recovers each original: "+mode,async({page,api},info)=>{
    const project="d0000000-0000-4000-8000-000000000001",asset="d0000000-0000-4000-8000-000000000002",now=new Date().toISOString();
    const node={id:"product",type:"image",title:"测试原款",width:170,height:150,position:{x:180,y:150},metadata:{serverAssetId:asset,status:"success"}};
    api.assetBytes.set(asset,fixturePng(90));
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"企划色板",createdAt:now,updatedAt:now,nodes:[node],connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    let singles=0,batches=0,lookups=0;const requests:string[]=[],cancelled:string[]=[];
    await page.route("**/api/tryout/quick",r=>{singles++;return r.fulfill({status:500,json:{}});});
    await page.route("**/api/tasks/by-request/*",r=>{const requestId=decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-1)!);lookups++;const task=[...api.tasks.values()].find(t=>t.requestId===requestId);return r.fulfill(task?{json:{task}}:{status:404,json:{}});});
    await page.route("**/api/tasks/*/cancel",r=>{
        expect(r.request().headers()["x-canvas-owner-id"]).toBeTruthy();const id=new URL(r.request().url()).pathname.split("/").at(-2)!;
        cancelled.push(id);return r.fulfill(cancelled.length===1?{status:409,json:{error:"INVALID_TASK_STATE"}}:{json:{status:"cancelled"}});
    });
    await page.route("**/api/tryout/quick/batch",async r=>{
        batches++;const req=r.request(),owner=req.headers()["x-canvas-owner-id"],items=req.postDataJSON().items as Array<{nodeId:string;requestId:string;sourceAssetId:string}>;
        expect(items).toHaveLength(6);expect(new Set(items.map(i=>i.nodeId)).size).toBe(6);
        const tasks=items.map((item,i)=>{
            expect(item.sourceAssetId).toBe(asset);requests.push(item.requestId);
            if(i===2&&mode==="partial receipts")return {requestId:item.requestId,error:{code:"CREDIT_LIMIT",message:"超过额度，本款未受理"}};
            const taskId="d0000000-0000-4000-8000-00000000001"+i;
            api.tasks.set(taskId,{id:taskId,requestId:"tryout:"+owner+":"+item.requestId,userId:owner,status:"waiting",createdAt:now,resultUrls:[],failureReason:null});
            return {requestId:item.requestId,taskId,prompt:"独立试色 "+i};
        });
        return mode==="lost batch response"?r.abort("connectionreset"):r.fulfill({json:{tasks:tasks.reverse()}});
    });
    await page.goto("/canvas/"+project);await page.locator('[data-node-id="product"]').first().click({position:{x:42,y:35}});
    await page.getByRole("toolbar",{name:"图片工具栏"}).getByRole("button",{name:"试色",exact:true}).click();
    await page.getByRole("button",{name:"试整组色板 · 6 款"}).click();
    const outputs=()=>(api.document(project)?.nodes??[]).filter((n:{id:string})=>n.id!=="product");
    await expect.poll(()=>outputs().length).toBe(6);
    await expect.poll(()=>outputs().filter((n:any)=>n.metadata.imageTask?.taskId).length,{timeout:35000}).toBe(mode==="partial receipts"?5:6);
    expect(new Set(outputs().map((n:any)=>n.position.x)).size).toBe(6);
    if(mode==="cancel queued"){
        await page.getByRole("button",{name:"取消排队"}).click();await expect(page.getByText("已撤回 5 款 · 已开始或已结束 1 款 · 待核查 0 款")).toBeVisible();
        expect(new Set(cancelled).size).toBe(6);await page.screenshot({path:info.outputPath("cancel-queued.png")});
    }else if(mode==="partial receipts"){
        expect(outputs().filter((n:any)=>n.metadata.status==="error"&&!n.metadata.imageTask)).toHaveLength(1);await expect(page.getByText("已受理 5 款")).toBeVisible();
        await page.screenshot({path:info.outputPath("partial-batch.png")});
    }else{expect(lookups).toBeGreaterThan(0);}
    await page.reload();await expect(page.locator('[data-node-id="product"]').first()).toBeVisible();
    expect(batches).toBe(1);expect(singles).toBe(0);expect(new Set(requests).size).toBe(6);
});
