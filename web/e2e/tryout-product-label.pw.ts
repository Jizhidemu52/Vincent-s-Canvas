import {readFileSync} from "node:fs";
import {expect,test} from "./fixtures";

for (const height of [1000, 760]) test(`改款结果仅在试款台打开时于图片和对比控件之间显示产品标签，窗口高度 ${height}`,async({page,api},info)=>{
    await page.setViewportSize({ width: 1440, height });
    const id="tryout-footer-compare",now=new Date().toISOString(),before="33333333-3333-4333-8333-333333333333",after="44444444-4444-4444-8444-444444444444";
    const url=(id:string)=>"/api/assets/"+id+"/content";
    api.productCardsEnabled=true;
    api.assetBytes.set(before,readFileSync("public/design-examples/knit-source.webp"));
    api.assetBytes.set(after,readFileSync("public/design-examples/knit.webp"));
    const nodes=[{id:"result",type:"image",title:"毛衣改款",position:{x:560,y:240},width:300,height:300,metadata:{serverAssetId:after,content:url(after),status:"success",compareSources:[{type:"image",content:url(before),label:"修改前毛衣"}]}}];
    api.documents.set(id,{id,revision:1,deleted:false,updatedAt:now,document:{id,title:"标签位置核对",createdAt:now,updatedAt:now,nodes,groups:[],connections:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null}});
    let recognitions=0;
    await page.route("**/api/assets/"+after+"/product-card",route=>{
        if(route.request().method()==="POST")recognitions++;
        return route.fulfill({json:{status:"ready",card:{version:2,view:"flat",background:"白",items:[{category:"套头毛衣",audience:"unisex",material:"细针织，表面略有绒感",parts:["衣身","袖口"],wearPosition:"upper",colors:[],primary:true,pattern:""}]}}});
    });
    await page.goto("/canvas/"+id);
    const node=page.locator('[data-node-id="result"]'),image=node.locator("img[data-canvas-image-resolution]").first(),label=node.getByRole("button",{name:"修改产品标签"}),compare=page.getByRole("button",{name:"选择对比原图"});
    await expect(image).toBeVisible();await node.click();await expect(compare).toBeVisible();
    await expect(label).toHaveCount(0);expect(recognitions).toBe(0);
    const capture=async(name:string)=>{
        const b=(await image.boundingBox())!;
        await page.screenshot({path:info.outputPath(name),clip:{x:Math.max(0,b.x-120),y:Math.max(0,b.y-76),width:b.width+240,height:b.height+260}});
    };
    await capture("bench-closed.png");
    await page.getByRole("button",{name:"试款台",exact:true}).click();await expect(label).toHaveText(/套头毛衣/);
    const ordered=async()=>{
        const [i,l,c]=await Promise.all([image.boundingBox(),label.boundingBox(),compare.boundingBox()]);
        return !!i&&!!l&&!!c&&l.y>=i.y+i.height-1&&c.y>=l.y+l.height-1;
    };
    await expect.poll(ordered).toBe(true);
    await capture("bench-open.png");
    await label.click();const save=page.getByRole("button",{name:"保存标签",exact:true});
    await expect.poll(async()=>{const [s,c]=await Promise.all([save.boundingBox(),compare.boundingBox()]);return !!s&&!!c&&c.y>=s.y+s.height-1;}).toBe(true);
    await page.getByRole("button",{name:"收起试款台",exact:true}).click();
    await expect(label).toHaveCount(0);await expect(save).toHaveCount(0);await expect(compare).toBeVisible();
    expect(api.submissions).toHaveLength(0);expect(api.batchSubmissions).toHaveLength(0);
});
