import {fabricCrossings,type FabricVertex} from "../../shared/tryout-fabric-area";

type Frame = {width:number;height:number};
const luminance=(pixels:Buffer,p:number)=>(pixels[p]!*54+pixels[p+1]!*183+pixels[p+2]!*19)/256;
function interpolate(data:ArrayLike<number>,w:number,h:number,x:number,y:number) {
    x=Math.max(0,Math.min(w-1,x));y=Math.max(0,Math.min(h-1,y));
    const i=Math.floor(x),j=Math.floor(y),dx=x-i,dy=y-j,r=Math.min(i+1,w-1),b=Math.min(j+1,h-1);
    return (data[j*w+i]!*(1-dx)+data[j*w+r]!*dx)*(1-dy)+(data[b*w+i]!*(1-dx)+data[b*w+r]!*dx)*dy;
}
function toneField(pixels:Buffer,{width,height}:Frame,step:number) {
    const w=Math.ceil(width/step),h=Math.ceil(height/step),sum=new Float32Array(w*h),counts=new Uint32Array(w*h);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const k=Math.floor(y/step)*w+Math.floor(x/step),p=(y*width+x)*4;
        if(!pixels[p+3])continue;
        sum[k]=sum[k]!+luminance(pixels,p);counts[k]=counts[k]!+1;
    }
    for(let i=0;i<sum.length;i++)sum[i]=sum[i]!/Math.max(1,counts[i]!);
    return (x:number,y:number)=>interpolate(sum,w,h,(x+.5)/step-.5,(y+.5)/step-.5);
}
export function compositeFabricArea(original:Buffer,source:Frame,generated:Buffer,output:Frame,vertices:FabricVertex[],useColor:boolean) {
    const result=Buffer.from(original),{width:w,height:h}=source,{width:gw,height:gh}=output;
    const sourceTone=toneField(original,source,Math.max(2,Math.round(Math.min(w,h)/32)));
    const outputTone=toneField(generated,output,Math.max(2,Math.round(Math.min(gw,gh)/32)));
    const detail=new Uint8Array(gw*gh);
    for(let i=0;i<detail.length;i++)detail[i]=Math.round(luminance(generated,4*i));
    let changed=0,texturePresent=false;
    for(let y=0;y<h;y++) {
        const xs=fabricCrossings(vertices,(y+0.5)*1000/h);
        const gy=Math.floor((y+0.5)*gh/h);
        for(let k=0;k+1<xs.length;k+=2) {
            const start=Math.max(0,Math.ceil(xs[k]!*w/1000-0.5)),end=Math.min(w,Math.ceil(xs[k+1]!*w/1000-0.5));
            for(let x=start;x<end;x++) {
                const gx=Math.floor((x+0.5)*gw/w),p=4*(w*y+x),g=4*(gy*gw+gx);
                if(!original[p+3]||!generated[g+3])continue;
                const u=(x+.5)*gw/w-.5,v=(y+.5)*gh/h-.5;
                const texture=interpolate(detail,gw,gh,u,v)-outputTone(u,v);
                if(Math.abs(texture)>=2)texturePresent=true;
                const delta=Math.round(sourceTone(x,y)-luminance(original,p)+texture);
                for(let c=0;c<3;c++)result[p+c]=useColor?generated[g+c]!:Math.max(0,Math.min(255,original[p+c]!+delta));
                if(result[p]!==original[p]||result[p+1]!==original[p+1]||result[p+2]!==original[p+2])changed++;
            }
        }
    }
    return {result,changed:useColor||texturePresent?changed:0};
}
