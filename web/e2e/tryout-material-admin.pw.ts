import {expect,test} from "./fixtures";

test("the curator publishes and hides a material from the admin content panel",async({page,api},info)=>{
    api.role="super_admin";
    await page.route("**/api/auth/methods",r=>r.fulfill({json:{password:true,wecom:false,oa:false}}));
    const base:Record<string,unknown>={accounts:{users:[]},departments:{departments:[]},"audit-logs":{auditLogs:[]},"credit-policy":{creditsEnabled:false},history:{history:[],tasks:[],total:0}};
    const presets:Array<{id:string;status:string;name:string;description:string}>=[];
    const writes:string[]=[];
    await page.route("**/api/admin/**",async route=>{
        const req=route.request(),key=new URL(req.url()).pathname.split("/").slice(3).join("/");
        if(key==="material-presets"||key.startsWith("material-presets/")){
            if(req.method()==="GET")return route.fulfill({json:{presets}});
            expect(req.headers()["x-canvas-owner-id"]).toBeTruthy();writes.push(req.method());
            if(req.method()==="POST")presets.push({...req.postDataJSON(),id:"60000000-0000-4000-8000-000000000009"});
            else Object.assign(presets[0],req.postDataJSON());
            return route.fulfill({json:{preset:presets[0]}});
        }
        if(key in base)return route.fulfill({json:base[key]});
        return route.fallback();
    });
    await page.goto("/admin?tab=materials");
    const panel=page.getByRole("region",{name:"材质库管理",exact:true});
    await panel.getByLabel("材质名称").fill("斜纹");
    await panel.getByLabel("材质描述").fill("紧密的右斜纹");
    await panel.getByRole("button",{name:"保存材质"}).click();
    await expect(panel.getByLabel("选择预设材质")).toHaveValue("60000000-0000-4000-8000-000000000009");
    await panel.getByLabel("员工可见").uncheck();await panel.getByRole("button",{name:"保存材质"}).click();
    await expect.poll(()=>presets[0]?.status).toBe("hidden");
    await page.reload();await panel.getByLabel("选择预设材质").selectOption({label:"斜纹 · 已隐藏"});
    await expect(panel.getByLabel("员工可见")).not.toBeChecked();await expect(panel.getByLabel("材质描述")).toHaveValue("紧密的右斜纹");
    expect(writes).toEqual(["POST","PATCH"]);await page.screenshot({path:info.outputPath("admin-material.png")});
});
