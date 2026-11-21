import { readdir,readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test,expect,fixturePng } from "./fixtures";

test("real image worker produces bounded region lookup maps without a provider request",async({page,api},info)=>{
    const dir=process.env.TRYOUT_SAMPLE_DIR;
    const samples=dir?(await readdir(dir)).filter(name=>name.endsWith(".png")).sort():["fixture.png"];
    await page.goto("/canvas");
    const metrics=[];
    for(const name of samples){
        const data=(dir?await readFile(join(dir,name)):fixturePng()).toString("base64");
        const result=await page.evaluate(async({data})=>{
            const {processImageInWorker}=await import("/src/pages/creative/image-processing-client.ts");
            const blob=await (await fetch("data:image/png;base64,"+data)).blob();
            const image=await createImageBitmap(blob);
            const side=Math.min(1,512/Math.max(image.width,image.height));
            const canvas=document.createElement("canvas");
            canvas.width=Math.max(1,Math.round(image.width*side));canvas.height=Math.max(1,Math.round(image.height*side));
            const ctx=canvas.getContext("2d")!;
            ctx.drawImage(image,0,0,canvas.width,canvas.height);image.close();
            const input=ctx.getImageData(0,0,canvas.width,canvas.height),start=performance.now();
            const r=await processImageInWorker({kind:"product-regions",image:input});
            const elapsed=Math.round(performance.now()-start);
            return {msIncludingWorkerStartup:elapsed,width:r.width,height:r.height,pixels:r.labels.length,productPixels:r.labels.reduce((n:number,l:number)=>n+Number(l>0),0),regions:r.regions.length};
        },{data});
        expect(result.regions).toBeGreaterThan(0);
        expect(result.regions).toBeLessThanOrEqual(6);
        expect(result.pixels).toBe(result.width*result.height);
        expect(result.productPixels).toBeGreaterThan(0);
        metrics.push({name,...result});
    }
    await writeFile(info.outputPath("region-samples.json"),JSON.stringify(metrics,null,2));
    expect(api.submissions).toHaveLength(0);
});
