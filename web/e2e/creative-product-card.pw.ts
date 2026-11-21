import {test,expect,IMAGE} from "./fixtures";

for(const enabled of [true,false])test("creative source product tags do not start generation, recognition enabled="+enabled,async({page,api},info)=>{
    api.productCardsEnabled=enabled;
    let posts=0;
    const item={category:"罗纹围脖",material:"粗针",audience:"unisex",wearPosition:"neck",parts:["筒身"],colors:[],primary:true,pattern:""};
    const card={version:2,items:[item],view:"flat",background:"白"};
    await page.route("**/api/assets/*/product-card",route=>{if(route.request().method()==="POST")posts++;return route.fulfill({json:{status:"ready",card}});});
    await page.goto("/creative/garment-colorway");
    await page.getByLabel("上传服装参考图",{exact:true}).setInputFiles({name:"fixture-neckwarmer.png",mimeType:"image/png",buffer:IMAGE});
    await expect(page.getByRole("button",{name:"识别图中产品",exact:true})).toBeEnabled();
    const chip=page.getByRole("button",{name:"修改产品标签"});
    if(enabled){
        await expect(chip).toHaveText(/罗纹围脖/);
        await chip.click();await expect(page.getByRole("textbox",{name:"品类",exact:true})).toHaveValue("罗纹围脖");
        await page.getByRole("button",{name:"取消",exact:true}).last().click();
        await page.screenshot({path:info.outputPath("creative-product-tags.png")});
        expect(posts).toBe(1);
    }else{await expect(chip).toHaveCount(0);expect(posts).toBe(0);}
    expect(api.submissions).toHaveLength(0);expect(api.batchSubmissions).toHaveLength(0);
});
