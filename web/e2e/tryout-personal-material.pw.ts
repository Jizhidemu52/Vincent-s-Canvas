import {expect,fixturePng,newCanvas,test} from "./fixtures";

test("a personal fabric upload keeps its owned asset and color preference after a canvas reload",async({page,api},info)=>{
    const project=await newCanvas(page);
    const samples=()=>[...api.assets.values()].filter(a=>a.metadata?.source==="material-library");
    let changes=0;
    await page.route("**/api/materials",route=>route.fulfill({json:{presets:[],mine:samples().map(a=>({id:a.id,name:a.metadata.name,useColor:a.metadata.useColor}))}}));
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
    await expect(checkbox).toBeVisible();await expect(checkbox).not.toBeChecked();await checkbox.check();await expect(checkbox).toBeChecked();
    await dialog.getByRole("button",{name:"加为新的"}).click();
    const id=samples()[0].id;
    await expect.poll(()=>api.document(project)?.tryoutKit?.materials[0]).toMatchObject({assetId:id,name:"面料小样"});
    expect(api.assetBytes.get(id)).toEqual(bytes);expect(changes).toBe(1);expect(samples()).toHaveLength(1);
    await page.reload();await expect(page.getByRole("button",{name:"拖动换材质：面料小样"})).toBeVisible();
    await open.click();await dialog.getByRole("button",{name:"面料小样",exact:true}).click();await expect(checkbox).toBeChecked();
    await page.screenshot({path:info.outputPath("personal-fabric-library.png")});expect(api.submissions).toHaveLength(0);
});
