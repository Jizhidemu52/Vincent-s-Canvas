import {expect,fixturePng,newCanvas,test} from "./fixtures";

for(const recognized of [true,false])test("a personal fabric upload keeps its image, features and color preference after reload, recognized="+recognized,async({page,api},info)=>{
    const project=await newCanvas(page);
    const samples=()=>[...api.assets.values()].filter(a=>a.metadata?.source==="material-library");
    let changes=0,scans=0;
    const inferred={name:"纵向罗纹",description:"纵向细凸棱，表面哑光"},corrected="窄凸棱纵向排列，沟槽较深";
    await page.route("**/api/materials",route=>route.fulfill({json:{presets:[],mine:samples().map(({id,metadata:m})=>({id,name:m.name??m.curatorAnalysis?.name??m.uploadName,description:m.description??m.curatorAnalysis?.description??"",useColor:m.useColor}))}}));
    await page.route("**/api/materials/mine/*/analyze",async route=>{
        const id=new URL(route.request().url()).pathname.split("/").at(-2)!,asset=api.assets.get(id)!;
        expect(route.request().headers()["x-canvas-owner-id"]).toBe(asset.ownerUserId);expect(api.assetBytes.has(id)).toBe(true);scans++;
        if(recognized)asset.metadata.curatorAnalysis=inferred;
        await route.fulfill({json:recognized?{status:"ready",...inferred}:{status:"unavailable"}});
    });
    await page.route("**/api/materials/mine/*",async route=>{
        const id=new URL(route.request().url()).pathname.split("/").at(-1)!,asset=api.assets.get(id)!;
        expect(route.request().headers()["x-canvas-owner-id"]).toBe(asset.ownerUserId);
        Object.assign(asset.metadata,route.request().postDataJSON());changes++;await route.fulfill({json:{id}});
    });
    await page.getByRole("button",{name:"试款台",exact:true}).click();
    const open=page.getByRole("button",{name:"从材质库换材质"}),dialog=page.getByRole("dialog",{name:"材质库",exact:true});
    await open.click();const bytes=fixturePng(95);
    await dialog.locator('input[type="file"]').setInputFiles({name:"面料小样.png",mimeType:"image/png",buffer:bytes});
    const checkbox=dialog.getByRole("checkbox",{name:"连颜色一起用"});
    const name=recognized?inferred.name:"面料小样",description=dialog.getByRole("textbox",{name:"材质描述"});
    await expect(dialog.getByRole("textbox",{name:"材质名称"})).toHaveValue(name);
    await expect(description).toHaveValue(recognized?inferred.description:"");expect(scans).toBe(1);
    if(!recognized)await expect(dialog.getByRole("status").filter({hasText:"图片已保留"})).toBeVisible();
    await dialog.screenshot({path:info.outputPath("after-upload.png")});
    await description.fill(corrected);await dialog.getByRole("button",{name:"保存修改"}).click();
    await expect(checkbox).toBeVisible();await expect(checkbox).not.toBeChecked();await checkbox.check();await expect(checkbox).toBeChecked();
    await dialog.getByRole("button",{name:"加为新的"}).click();
    const id=samples()[0].id;
    await expect.poll(()=>api.document(project)?.tryoutKit?.materials[0]).toMatchObject({assetId:id,name});
    expect(api.assetBytes.get(id)).toEqual(bytes);expect(changes).toBe(2);expect(samples()).toHaveLength(1);
    await page.reload();await expect(page.getByRole("button",{name:"拖动换材质："+name})).toBeVisible();
    await open.click();await dialog.getByRole("button",{name,exact:true}).click();await expect(checkbox).toBeChecked();await expect(description).toHaveValue(corrected);expect(scans).toBe(1);
    await page.screenshot({path:info.outputPath("personal-fabric-library.png")});expect(api.submissions).toHaveLength(0);
});
