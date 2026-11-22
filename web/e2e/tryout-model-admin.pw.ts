import {expect,test,fixturePng} from "./fixtures";
import {join} from "node:path";
import {modelFramings,modelIdentities} from "../../shared/model-match";

test("saved model order and names drive the responsive review grid after a reload",async({page,api},info)=>{
    api.role="super_admin";
    await page.route("**/api/auth/methods",r=>r.fulfill({json:{password:true,wecom:false,oa:false}}));
    for(const [key,json] of Object.entries({accounts:{users:[]},departments:{departments:[]},"audit-logs":{auditLogs:[]},history:{history:[],tasks:[],total:0},"credit-policy":{creditsEnabled:false}})){
        await page.route("**/api/admin/"+key+"*",r=>r.fulfill({json}));
    }
    const rows=modelIdentities.flatMap((m,i)=>modelFramings.map((framing,j)=>({...m,framing,sortOrder:i,assetId:"photo-"+i+j,id:"slot-"+i+j,status:"published",draftAssetId:null}))).reverse();
    const changes:string[]=[];
    await page.route("**/api/admin/model-presets**",async route=>{
        const req=route.request(),path=new URL(req.url()).pathname;
        if(path.endsWith("/generation"))return route.fulfill({json:{jobs:[]}});
        if(path.endsWith("/thumb")){
            const row=rows.find(r=>path.endsWith("/"+r.id+"/thumb"));
            const photos=process.env.TRYOUT_REVIEW_FIXTURES;
            return row&&photos?route.fulfill({path:join(photos,row.identity+"-"+row.framing+".png"),contentType:"image/png"}):route.fulfill({body:fixturePng(145),contentType:"image/png"});
        }
        if(req.method()==="PATCH"){
            const identity=path.split("/").at(-1),update=req.postDataJSON();
            expect(identity).toBe("white-woman");
            rows.filter(r=>r.identity===identity).forEach(r=>Object.assign(r,update));changes.push("sort");return route.fulfill({status:204});
        }
        expect(req.method()).toBe("GET");return route.fulfill({json:{presets:rows}});
    });
    await page.setViewportSize({width:1440,height:1000});await page.goto("/admin?tab=model-library");
    const library=page.getByRole("region",{name:"模特库管理",exact:true}),groups=library.locator(".portrait-identity");
    await expect(groups.first().getByRole("heading")).toHaveText("女模特");
    await groups.first().getByText("编辑名称与顺序").click();
    await groups.first().getByLabel("顺序",{exact:true}).fill("4");await groups.first().getByLabel("显示名称").fill("女装样衣");
    await groups.first().getByRole("button",{name:"保存名称与顺序"}).click();
    await expect(groups.last().getByRole("heading")).toHaveText("女装样衣");await page.reload();
    await expect(groups.getByRole("heading")).toHaveText(["男模特","女童模特","男童模特","女装样衣"]);
    const frames=groups.first().locator("fieldset");
    await expect(frames.locator("legend")).toHaveText(["全身","半身","头肩"]);
    const coords=()=>frames.evaluateAll(els=>els.map(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}}));
    let b=await coords();expect(Math.max(...b.map(a=>a.y))-Math.min(...b.map(a=>a.y))).toBeLessThan(2);expect(b[2].x).toBeGreaterThan(b[1].x+b[1].width-1);
    await expect(groups.first().locator("img")).toHaveCount(3);
    await expect.poll(()=>groups.first().locator("img").evaluateAll(imgs=>imgs.every(img=>(img as HTMLImageElement).naturalWidth>0))).toBe(true);
    await groups.first().scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("model-library-desktop.png")});
    await page.setViewportSize({width:390,height:844});b=await coords();
    expect(b[1].y).toBeGreaterThanOrEqual(b[0].y+b[0].height-1);
    expect(await library.evaluate(e=>e.scrollWidth-e.clientWidth)).toBeLessThanOrEqual(1);
    await groups.first().scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("model-library-mobile.png")});
    expect(changes).toEqual(["sort"]);
});

test("curator sees twelve positions, publishes the reviewed replacement and hides the public model",async({page,api},info)=>{
    api.role="super_admin";
    await page.route("**/api/auth/methods",r=>r.fulfill({json:{password:true,wecom:false,oa:false}}));
    const slot={id:"c0000000-0000-4000-8000-000000000001",name:"女模特",identity:"white-woman",audience:"women",framing:"head",sortOrder:0,status:"published",assetId:"c0000000-0000-4000-8000-000000000002",draftAssetId:"c0000000-0000-4000-8000-000000000003" as string|null},writes:string[]=[];
    const mocks:Record<string,unknown>={accounts:{users:[]},departments:{departments:[]},"audit-logs":{auditLogs:[]},history:{history:[],tasks:[],total:0},"credit-policy":{creditsEnabled:false}};
    let jobs:{id:string;status:string;identity:string;framing:string}[]=[],submissions=0,original="",checks=0;
    await page.route("**/api/admin/**",route=>{
        const req=route.request(),key=new URL(req.url()).pathname.split("/").slice(3).join("/");
        if(key==="model-presets/company")return route.fulfill({json:{models:[]}});
        if(key==="model-presets")return route.fulfill({json:{presets:[slot]}});
        if(key==="model-presets/generation"){
            if(req.method()==="GET")return route.fulfill({json:{jobs}});
            const data=req.postDataJSON();expect(req.headers()["x-canvas-owner-id"]).toBeTruthy();expect(data.confirmedCount).toBe(4);
            expect(data.slots.map((s:any)=>s.framing)).toEqual(["full","full","full","full"]);
            submissions++;original=data.requestId;jobs=data.slots.map((s:any,i:number)=>({...s,id:"test-"+i,status:"waiting"}));
            return route.abort("connectionreset");
        }
        if(key==="model-presets/generation/"+original){checks++;return route.fulfill({json:{jobs}});}
        if(key.endsWith("/thumb"))return route.fulfill({body:fixturePng(180),contentType:"image/png"});
        if(key.startsWith("model-presets/")){
            const action=key.split("/").at(-1)!;expect(req.headers()["x-canvas-owner-id"]).toBeTruthy();
            expect(req.postDataJSON()).toMatchObject({expectedAssetId:slot.draftAssetId??slot.assetId});writes.push(action);
            if(action==="publish"){slot.assetId=slot.draftAssetId!;slot.draftAssetId=null;}else if(action==="hide")slot.status="hidden";
            return route.fulfill({status:204});
        }
        return key in mocks?route.fulfill({json:mocks[key]}):route.fallback();
    });
    await page.goto("/admin?tab=model-library");
    const panel=page.getByRole("region",{name:"模特库管理",exact:true});
    await expect(panel.locator('.portrait-frame input[type="file"]')).toHaveCount(12);
    await expect(panel.getByText("已发布 · 替换待审核")).toBeVisible();
    await page.screenshot({path:info.outputPath("model-review.png")});
    await panel.getByRole("button",{name:"确认发布此图"}).click();await expect(panel.getByText("已发布",{exact:true})).toBeVisible();
    await panel.getByRole("button",{name:"下架当前图"}).click();await expect(panel.getByText("已下架",{exact:true})).toBeVisible();
    await page.reload();await expect(panel.getByText("已下架",{exact:true})).toBeVisible();expect(writes).toEqual(["publish","hide"]);
    const batch=panel.getByRole("button",{name:"补齐可生成的空位（4 张）"}),dialog=panel.getByRole("alertdialog");
    await batch.click();await expect(dialog).toContainText("4 张高清模特图");await dialog.getByRole("button",{name:"取消"}).click();expect(submissions).toBe(0);
    await batch.click();await page.screenshot({path:info.outputPath("model-generation-count.png")});await dialog.getByRole("button",{name:"确认生成 4 张"}).click();
    await expect(dialog.getByRole("button",{name:"按原编号核对"})).toBeVisible();await page.reload();
    await dialog.getByRole("button",{name:"按原编号核对"}).click();await expect(panel.getByText("已受理 4 张，结果只进入待审核区。")).toBeVisible();
    expect(submissions).toBe(1);expect(checks).toBe(1);await expect(panel.getByText("排队中",{exact:true})).toHaveCount(4);
});
