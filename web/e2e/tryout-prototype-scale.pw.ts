import {expect,fixturePng,newCanvas,test} from "./fixtures";
import {pathToFileURL} from "node:url";
import {join} from "node:path";
import {modelIdentities} from "../../shared/model-match";

for(const [width,height] of [[1440,1000],[900,873],[390,844]])test("tryout workbench matches prototype scale at "+width,async({page,api,browser},info)=>{
    const photos=process.env.TRYOUT_REVIEW_FIXTURES,presets=modelIdentities.map((p,i)=>({...p,framing:"full",assetId:"portrait-"+i,id:"slot-"+i}));
    await page.route("**/api/tryout/models",r=>r.fulfill({json:{presets,mine:[],preference:{}}}));
    await page.route("**/api/tryout/models/presets/*/thumb",r=>{
        const p=presets.find(p=>r.request().url().includes("/"+p.id+"/"))!;
        return photos?r.fulfill({path:join(photos,p.identity+"-full.png"),contentType:"image/png"}):r.fulfill({body:fixturePng(90),contentType:"image/png"});
    });
    await page.setViewportSize({width,height});await newCanvas(page);await page.keyboard.press("t");
    const panel=page.getByTestId("canvas-design-toolbox");
    await expect(panel.locator(".tb-pat")).toHaveCount(4);await expect(panel.locator(".tb-model")).toHaveCount(5);
    await expect.poll(()=>panel.locator(".tb-model img").evaluateAll(els=>els.every(e=>(e as HTMLImageElement).naturalWidth>0))).toBe(true);
    const rect=(r:{x:number;y:number;width:number;height:number}|null)=>Object.values(r!).map(n=>Math.round(n));
    const box=await panel.boundingBox(),w=width<=900?260:296;
    expect(rect(box)).toEqual([width-16-w,64,w,height-84]);
    for(const [sel,h] of [[".tb-sw",42],[".tb-pat",56],[".tb-wide",38]] as const)expect((await panel.locator(sel).first().boundingBox())!.height).toBe(h);
    const snap=await panel.screenshot({path:info.outputPath("workbench-"+width+".png")});expect(snap.byteLength).toBeGreaterThan(1000);
    if(process.env.TRYOUT_REVIEW_PROTOTYPE){
        const ref=await browser.newPage({viewport:{width,height}});
        try{await ref.goto(pathToFileURL(process.env.TRYOUT_REVIEW_PROTOTYPE).href);
            await ref.locator("#box").screenshot({path:info.outputPath("prototype-"+width+".png")});
            const metrics=[];
            for(const [sel,old] of [[".tryout-bench","#box"],[".tb-head","#box header"],[".tb-scroll h4","#box h4"],[".tb-hint","#box .hint"],[".tb-palhead","#box .palhead"],[".tb-sw","#swatches .sw"],[".tb-pat","#pats .pat"],[".tb-model","#models .mcard"],[".tb-wide","#wearAll"],[".tb-slider input","#box input[type=range]"]]){
                const current=rect(await page.locator(sel).first().boundingBox()),target=rect(await ref.locator(old).first().boundingBox());metrics.push({sel,current,target});
                for(let axis=0;axis<4;axis++)expect.soft(Math.abs(current[axis]-target[axis]),sel+" xywh "+axis+" measured "+current[axis]+" vs "+target[axis]).toBeLessThanOrEqual(1);
            }
            await info.attach("prototype-metrics",{body:JSON.stringify(metrics,null,2),contentType:"application/json"});
        }finally{await ref.close();}
    }
    await panel.getByRole("button",{name:"从材质库换材质"}).click();
    const dialog=page.getByRole("dialog",{name:"材质库",exact:true});
    for(const n of ["粗针","罗纹","绞花","马海毛","摇粒绒","灯芯绒"])await expect(dialog.getByRole("button",{name:n,exact:true})).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});
