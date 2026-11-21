import {expect,test,fixturePng} from "./fixtures";

test("curator sees twelve positions, publishes the reviewed replacement and hides the public model",async({page,api},info)=>{
    api.role="super_admin";
    await page.route("**/api/auth/methods",r=>r.fulfill({json:{password:true,wecom:false,oa:false}}));
    const slot={id:"c0000000-0000-4000-8000-000000000001",name:"女模特",identity:"white-woman",audience:"women",framing:"head",sortOrder:0,status:"published",assetId:"c0000000-0000-4000-8000-000000000002",draftAssetId:"c0000000-0000-4000-8000-000000000003" as string|null},writes:string[]=[];
    const mocks:Record<string,unknown>={accounts:{users:[]},departments:{departments:[]},"audit-logs":{auditLogs:[]},history:{history:[],tasks:[],total:0},"credit-policy":{creditsEnabled:false}};
    let jobs:{id:string;status:string;identity:string;framing:string}[]=[],submissions=0,original="",checks=0;
    await page.route("**/api/admin/**",route=>{
        const req=route.request(),key=new URL(req.url()).pathname.split("/").slice(3).join("/");
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
    await expect(panel.locator('input[type="file"]')).toHaveCount(12);
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
