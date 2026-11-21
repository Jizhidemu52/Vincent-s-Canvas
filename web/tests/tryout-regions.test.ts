import { expect,test } from "bun:test";
import { computeRegions,regionAtPoint } from "@/lib/tryout/product-regions";

function make(w:number,h:number,rgb:(x:number,y:number)=>number[]) {
    const data=new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)data.set(rgb(x,y),(y*w+x)*4);
    return {width:w,height:h,data};
}
test("floods only connected pale background; preserves a white motif inside the product",()=>{
    const image=make(25,25,(x,y)=>x<4||y<4||x>20||y>20||x===10&&y===10?[248,248,248,255]:x<12?[10,40,88,255]:[113,4,44,255]);
    const original=image.data.slice(),r=computeRegions(image);
    expect(regionAtPoint(r,3,19)).toBe(0);
    expect(regionAtPoint(r,10,10)).toBeGreaterThan(0);
    expect(regionAtPoint(r,5,9)).not.toBe(regionAtPoint(r,18,9));
    expect(r.regions.reduce((s,region)=>s+region.share,0)).toBeCloseTo(1);
    expect(image.data).toEqual(original);
    for(const p of [[NaN,2],[-1,0],[0,25]])expect(regionAtPoint(r,p[0],p[1])).toBe(0);
});
test("caps at six regions; unknown backgrounds remain selectable; transparent and blank images are handled",()=>{
    const r=computeRegions(make(41,33,(x,y)=>[x*15%256,y*15%256,(x+y)*15%256,255]));
    expect(r.regions).toHaveLength(6);
    expect(r.labels.every(v=>v>0)).toBe(true);
    expect(computeRegions(make(10,10,()=>[255,255,255,0])).regions).toHaveLength(0);
    expect(computeRegions(make(10,10,()=>[255,255,255,255])).regions).toHaveLength(1);
    expect(()=>computeRegions(make(513,1,()=>[0,0,0,0]))).toThrow("512");
});
