import { requirePixelImage,rgbHex,type PixelImage } from "@/pages/creative/image-processing";

export type ProductRegions={width:number;height:number;labels:Uint8Array;regions:Array<{id:number;color:string;share:number}>};
type Bin={rgb:number[];count:number};
const pixelKey=(data:Uint8ClampedArray,i:number)=>(data[i]>>4)*256+(data[i+1]>>4)*16+(data[i+2]>>4);
const dist=(a:ArrayLike<number>,offset:number,b:number[]) => (a[offset]-b[0])**2+(a[offset+1]-b[1])**2+(a[offset+2]-b[2])**2;

export function computeRegions(image:PixelImage):ProductRegions {
    requirePixelImage(image);
    const {width,height,data}=image, pixels=width*height;
    if(Math.max(width,height)>512) throw new RangeError("请先把分区预览缩到 512 像素以内");
    const labels=new Uint8Array(pixels), edge=new Map<number,Bin>(), border:number[]=[];
    for(let p=0;p<pixels;p++){
        const x=p%width,y=Math.floor(p/width);
        if(x!==0 && x!==width-1 && y!==0 && y!==height-1)continue;
        border.push(p);
        const i=p*4;
        if(data[i+3]<128)continue;
        const key=pixelKey(data,i),bin=edge.get(key);
        if(bin)bin.count++;else edge.set(key,{count:1,rgb:[data[i],data[i+1],data[i+2]]});
    }
    const bg=[...edge.values()].sort((a,b)=>b.count-a.count)[0];
    const queue=new Uint32Array(pixels);
    let head=0,tail=0;
    if(bg && bg.rgb.every(v=>v>=180) && Math.max(...bg.rgb)-Math.min(...bg.rgb)<30 &&
        border.filter(p=>data[p*4+3]>=128 && dist(data,p*4,bg.rgb)<=42**2).length>=border.length*0.68){
        const visit=(p:number)=>{
            if(!labels[p] && data[p*4+3]>=128 && dist(data,p*4,bg.rgb)<=42**2){labels[p]=255;queue[tail++]=p;}
        };
        border.forEach(visit);
        while(head<tail){
            const p=queue[head++],x=p%width;
            if(x)visit(p-1);
            if(x+1<width)visit(p+1);
            if(p>=width)visit(p-width);
            if(p+width<pixels)visit(p+width);
        }
        if(tail>pixels*.985)labels.fill(0);
    }
    const bins=new Map<number,Bin>();
    let total=0;
    for(let p=0;p<pixels;p++){
        const i=p*4;
        if(labels[p] || data[i+3]<128){labels[p]=0;continue;}
        labels[p]=255;total++;
        const key=pixelKey(data,i),bin=bins.get(key);
        if(bin)bin.count++;else bins.set(key,{rgb:[data[i],data[i+1],data[i+2]],count:1});
    }
    const centers:number[][]=[];
    for(const bin of [...bins.values()].sort((a,b)=>b.count-a.count)){
        if(centers.every(c=>dist(bin.rgb,0,c)>42**2))centers.push(bin.rgb);
        if(centers.length===6)break;
    }
    const nearest=new Map<number,number>();
    for(const [key,bin] of bins){
        let best=0;
        for(let c=1;c<centers.length;c++)if(dist(bin.rgb,0,centers[c])<dist(bin.rgb,0,centers[best]))best=c;
        nearest.set(key,best);
    }
    const sums=centers.map(()=>[0,0,0,0]);
    for(let p=0;p<pixels;p++)if(labels[p]){
        const i=p*4,c=nearest.get(pixelKey(data,i))!;
        labels[p]=c+1;
        for(let n=0;n<3;n++)sums[c][n]+=data[i+n];
        sums[c][3]++;
    }
    return {width,height,labels,regions:sums.map(([r,g,b,n],i)=>({id:i+1,color:rgbHex([r/n,g/n,b/n]),share:n/total}))};
}
export function regionAtPoint(r:ProductRegions,x:number,y:number) {
    return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<r.width&&y<r.height?r.labels[Math.floor(y)*r.width+Math.floor(x)]:0;
}
