import {expect,test} from "./fixtures";

test("super admin binds HD and a stale quick editor cannot overwrite another admin",async({api,page},info)=>{
    api.role="super_admin";
    await page.route("**/api/auth/methods",r=>r.fulfill({json:{password:true,wecom:false,oa:false}}));
    const model={id:"c0000000-0000-4000-8000-000000000001",modelId:"gpt-image-2.6-flare",provider:"测试服务",name:"试款图像"};
    const slots={quick:{tier:"quick",modelConfigId:null as string|null,revision:1},hd:{tier:"hd",modelConfigId:null as string|null,revision:1}};
    const sent:string[]=[];
    const admin:Record<string,unknown>={accounts:{users:[]},departments:{departments:[]},"audit-logs":{auditLogs:[]},history:{history:[],tasks:[],total:0},"model-configuration/tool-configurations":{tools:[]},"model-configuration/providers":{providers:[]},"model-configuration/models":{models:[]},workflows:{workflows:[]}};
    await page.route("**/api/admin/**",r=>{
        const key=new URL(r.request().url()).pathname.slice("/api/admin/".length);
        return key in admin?r.fulfill({json:admin[key]}):r.fallback();
    });
    await page.route("**/api/admin/tryout-bindings**",r=>{
        if(r.request().method()==="GET")return r.fulfill({json:{bindings:Object.values(slots),models:[model]}});
        expect(r.request().headers()["x-canvas-owner-id"]).toBeTruthy();
        const key=r.request().url().split("/").at(-1) as keyof typeof slots;
        const body=r.request().postDataJSON();
        expect(body).toEqual({modelConfigId:model.id,revision:1});sent.push(key);
        if(key==="quick"){Object.assign(slots.quick,{modelConfigId:"unavailable-id",revision:2});return r.fulfill({status:409,json:{message:"配置已被更改，请刷新后核对"}});}
        Object.assign(slots.hd,{modelConfigId:model.id,revision:2});return r.fulfill({json:{binding:slots.hd}});
    });
    await page.goto("/admin?tab=api");
    await page.getByRole("tab",{name:"试款模型",exact:true}).click();
    const hd=page.getByLabel("高清试款模型",{exact:true}),quick=page.getByLabel("快速试款模型",{exact:true});
    await expect(hd).toHaveValue("");await expect(quick).toHaveValue("");
    await hd.selectOption(model.id);await page.getByRole("button",{name:"保存高清档"}).click();
    await expect(page.getByText("已保存，新绑定只影响之后提交的任务。")).toBeVisible();
    await quick.selectOption(model.id);await page.getByRole("button",{name:"保存快速档"}).click();
    await expect(page.getByText("配置已被更改，请刷新后核对")).toBeVisible();
    await expect(quick).toHaveValue("unavailable-id");await expect(hd).toHaveValue(model.id);
    await expect(page.getByRole("button",{name:"保存快速档"})).toBeDisabled();
    await page.screenshot({path:info.outputPath("binding-conflict.png")});
    expect(sent).toEqual(["hd","quick"]);
    await page.route("**/api/admin/tryout-bindings/speed",r=>r.fulfill({json:{days:7,models:[{modelId:model.id,name:"隔离示例模型",issues:[{state:"paused",kind:"result_repair",code:"RESULT_STORAGE_FAILED",hasUpstreamId:true,count:1}],tasks:3,succeeded:2,paused:1,failed:0,...Object.fromEntries(["admission","provider","display","total"].flatMap(k=>[[k+"Samples",k==="display"?0:2],[k+"P50",k==="display"?null:400],[k+"P90",k==="display"?null:2400]]))}]}}));
    await page.getByRole("tab",{name:"试款速度",exact:true}).click();
    const speed=page.getByRole("region",{name:"试款速度"});await expect(speed.getByRole("heading",{name:"隔离示例模型"})).toBeVisible();
    await expect(speed.getByRole("row",{name:/松手 → 首次显示/})).toContainText("2.40 s");await expect(speed.getByRole("row",{name:/收到结果 → 显示回执/})).toContainText("—");
    await speed.getByText("暂停与失败原因分布").click();await expect(speed.getByText(/有上游 ID：1 单/)).toBeVisible();
    await page.screenshot({path:info.outputPath("tryout-speed-fixture.png")});
});
