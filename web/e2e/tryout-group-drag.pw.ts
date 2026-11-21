import {expect,test} from "./fixtures";

for(const kind of ["material","color"])test("an unselected product accepts one whole "+kind+" kit only on its foreground",async({page,api},info)=>{
    const project="ab000000-0000-4000-8000-000000000001",asset="ab000000-0000-4000-8000-000000000002";
    const now=new Date().toISOString(),colors=[{id:"red",name:"酒红",hex:"#823B45"},{id:"lime",name:"梨绿",hex:"#B8D977"}];
    const materials=["粗针","细针"].map((name,i)=>({name,id:"p"+i,presetId:"60000000-0000-4000-8000-00000000000"+(i+1)}));
    const png=await page.evaluate(()=>{const c=document.createElement("canvas");c.width=c.height=256;const ctx=c.getContext("2d")!;ctx.fillStyle="#fff";ctx.fillRect(0,0,256,256);ctx.fillStyle="#263754";ctx.fillRect(35,35,186,186);return c.toDataURL().split(",")[1];});
    api.assetBytes.set(asset,Buffer.from(png,"base64"));
    const node={id:"source",type:"image",title:"样品",width:220,height:220,position:{x:220,y:160},metadata:{serverAssetId:asset,status:"success"}};
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"整组拖动",createdAt:now,updatedAt:now,nodes:[node],connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]},tryoutKit:{version:1,colors,materials}}});
    const calls:string[][]=[];
    await page.route("**/api/tryout/quick/batch",r=>{
        const owner=r.request().headers()["x-canvas-owner-id"],items=r.request().postDataJSON().items;
        calls.push(items.map((i:{color?:{hex:string};material?:{presetId:string}})=>i.color?.hex??i.material?.presetId));
        const tasks=items.map((item:{kind:string;requestId:string;sourceAssetId:string;fallbackHex:string},i:number)=>{
            expect(item).toMatchObject({kind,sourceAssetId:asset});expect(item.fallbackHex.toUpperCase()).toBe("#263754");
            const taskId="ab000000-0000-4000-8000-00000000001"+i;
            api.tasks.set(taskId,{id:taskId,requestId:"tryout:"+owner+":"+item.requestId,userId:owner,status:"waiting",createdAt:now,resultUrls:[],failureReason:null});
            return {requestId:item.requestId,taskId,prompt:"模拟整组"};
        });return r.fulfill({json:{tasks}});
    });
    await page.goto("/canvas/"+project);await page.getByRole("button",{name:"试款台",exact:true}).click();
    const handle=page.getByRole("button",{name:(kind==="color"?"试整组色板":"试整组材质")+" · 2 款",exact:true});
    const target=page.locator('[data-node-id="source"] img[data-canvas-image-resolution]').first();
    await expect.poll(()=>target.evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const drag=async(frac:number)=>{await handle.scrollIntoViewIfNeeded();const a=(await handle.boundingBox())!,b=(await target.boundingBox())!;
        await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width*frac,b.y+b.height*frac,{steps:12});await page.mouse.up();};
    await drag(.05);await expect(page.getByText("这里是背景，未提交试款")).toBeVisible();expect(calls).toHaveLength(0);
    await drag(.5);await expect.poll(()=>calls).toEqual([kind==="color"?colors.map(c=>c.hex):materials.map(m=>m.presetId)]);
    await expect(page.getByText("已受理 2 款")).toBeVisible();
    await page.screenshot({path:info.outputPath("group-"+kind+".png")});
});
