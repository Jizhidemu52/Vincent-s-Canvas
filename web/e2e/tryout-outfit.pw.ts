import {test,expect,fixturePng} from "./fixtures";

test("drag another product onto a completed wear result; leaving costs nothing, release creates one new outfit",async({page,api},info)=>{
    const project="cf000000-0000-4000-8000-000000000001",asset="cf000000-0000-4000-8000-000000000002",wornAsset="cf000000-0000-4000-8000-000000000003",original="cf000000-0000-4000-8000-000000000004",taskId="cf000000-0000-4000-8000-000000000005",now=new Date().toISOString();
    api.assetBytes.set(asset,fixturePng(99));api.assetBytes.set(wornAsset,fixturePng(185));
    const product={id:"scarf",type:"image",title:"围脖",position:{x:175,y:170},width:155,height:155,metadata:{serverAssetId:asset,status:"success"}};
    const wear={...product,id:"wear",title:"帽子上身",position:{x:530,y:170},metadata:{serverAssetId:wornAsset,sourceTaskId:original,status:"success",tryout:{version:1,kind:"wear",tier:"quick",rootNodeId:"hat",sourceNodeId:"hat",products:["hat"],model:{name:"原模特"},prompt:"戴上帽子"}}};
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"同模特搭配",createdAt:now,updatedAt:now,nodes:[product,wear],connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    const calls:unknown[]=[];
    await page.route("**/api/tryout/quick",r=>{const input=r.request().postDataJSON(),owner=r.request().headers()["x-canvas-owner-id"];calls.push(input);
        api.tasks.set(taskId,{id:taskId,requestId:"tryout:"+owner+":"+input.requestId,userId:owner,status:"waiting",createdAt:now,resultUrls:[],failureReason:null});
        return r.fulfill({json:{taskId,model:{name:"原模特"},prompt:"同一模特戴帽子及围脖"}});
    });
    await page.goto("/canvas/"+project);await page.getByRole("button",{name:"试款台",exact:true}).click();
    const img=(id:string)=>page.locator('[data-node-id="'+id+'"] img[data-canvas-image-resolution]').first();
    const drag=async(leave=false)=>{const a=(await img("scarf").boundingBox())!,b=(await img("wear").boundingBox())!;
        await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:18});
        await expect(page.getByText("松手生成 1 张搭配图")).toBeVisible();
        if(leave){await page.mouse.move(a.x+a.width/2,a.y+a.height/2,{steps:18});await expect(page.getByText("松手生成 1 张搭配图")).toHaveCount(0);}
        await page.mouse.up();};
    await expect(img("scarf")).toBeVisible();await expect(img("wear")).toBeVisible();
    await drag(true);expect(calls).toHaveLength(0);
    await drag();await expect(page.getByRole("dialog")).toHaveCount(0);
    const result=()=>api.document(project)?.nodes.find((n:any)=>n.metadata.imageTask?.taskId===taskId);
    await expect.poll(()=>result()?.metadata.tryout?.products).toEqual(["hat","scarf"]);
    expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({kind:"outfit",originTaskId:original,originNodeId:"wear",sourceAssetId:asset});
    expect(calls[0]).not.toHaveProperty("model");expect(calls[0]).not.toHaveProperty("productAssetIds");
    expect(api.document(project)?.nodes.find((n:any)=>n.id==="scarf").position).toEqual(product.position);
    await page.screenshot({path:info.outputPath("outfit-one-receipt.png")});
});
