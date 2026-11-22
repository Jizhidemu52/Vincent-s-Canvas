import {test,expect,newCanvas,fixturePng} from "./fixtures";

for(const kind of ["fabric","portrait"] as const)test("administrator uploads, edits recognition and publishes a "+kind+" for designers",async({page,api},info)=>{
    api.role="super_admin";
    const fabric=kind==="fabric",text=fabric?"细罗纹":"正面全身",description=fabric?"纵向细条纹，哑光表面":"模特正面站立，身穿白色上衣",revised=text+"样本";
    const preset="60000000-0000-4000-8000-000000000031",rows:Record<string,string>[]=[];
    let analyses=0,asset="",writes=0;
    await page.route("**/api/auth/methods",r=>r.fulfill({json:{password:true}}));
    await page.route("**/api/admin/**",r=>{
        const req=r.request(),p=new URL(req.url()).pathname.split("/").slice(3).join("/");
        if(p.startsWith("preset-analysis/")){expect(req.method()).toBe("POST");analyses++;asset=p.split("/").at(-1)!;expect(api.assetBytes.has(asset)).toBe(true);return r.fulfill({json:{status:"ready",name:text,description}});}
        if(p.endsWith("/thumb"))return r.fulfill({body:fixturePng(157),contentType:"image/png"});
        if(p==="material-presets"||p.startsWith("model-presets/company")){
            if(req.method()==="GET")return r.fulfill({json:{presets:rows,models:rows}});
            writes++;rows.push({...req.postDataJSON(),id:fabric?preset:asset});return r.fulfill({json:fabric?{preset:rows[0]}:rows[0]});
        }
        const data:Record<string,unknown>={accounts:{users:[]},departments:{departments:[]},"audit-logs":{auditLogs:[]},"credit-policy":{creditsEnabled:false},history:{history:[],tasks:[],total:0},"model-presets":{presets:[]},"model-presets/generation":{jobs:[]}};
        return p in data?r.fulfill({json:data[p]}):r.fallback();
    });
    await page.goto("/admin?tab="+(fabric?"materials":"model-library"));
    if(!fabric)await page.getByText("上传或管理公司模特").click();
    const form=fabric?page.getByRole("region",{name:"材质库管理",exact:true}):page.getByRole("form",{name:"公司模特"});
    await form.getByLabel(fabric?"上传材质示意图":"上传模特图").setInputFiles({name:"样品.png",mimeType:"image/png",buffer:fixturePng(157)});
    await expect(form.getByLabel(fabric?"材质描述":"模特描述")).toHaveValue(description);expect(writes).toBe(0);
    await form.getByLabel(fabric?"材质名称":"模特名称").fill(revised);await form.getByRole("button",{name:fabric?"保存材质":"保存公司模特",exact:true}).click();
    await expect.poll(()=>rows[0]?.name).toBe(revised);expect(rows[0]?.status).toBe("published");expect(analyses).toBe(1);
    if(fabric)expect(rows[0]?.thumbAssetId).toBe(asset);else expect(rows[0]?.id).toBe(asset);
    api.role="designer";await page.route("**/api/materials",r=>r.fulfill({json:{presets:fabric?rows:[],mine:[]}}));
    await page.route("**/api/tryout/models",r=>r.fulfill({json:{custom:fabric?[]:rows,presets:[],mine:[],preference:{}}}));
    await page.route("**/presets/*/thumb*",r=>r.fulfill({body:fixturePng(157),contentType:"image/png"}));
    await newCanvas(page);await page.keyboard.press("t");if(fabric)await page.getByRole("button",{name:"从材质库换材质"}).click();
    const item=page.getByRole("button",{name:revised,exact:true});await item.click();await expect(item).toHaveAttribute("aria-pressed","true");expect(analyses).toBe(1);
    await page.screenshot({path:info.outputPath("designer-"+kind+".png")});expect(api.submissions).toHaveLength(0);
});
