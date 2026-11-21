import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { processImageInWorker } from "@/pages/creative/image-processing-client";
import type { ProductRegions } from "./product-regions";

type Entry={at:number;map:ProductRegions};
const storage=createWorkspaceStorage("tryout_regions"),inFlight=new Map<string,Promise<ProductRegions>>();
let maintenance=Promise.resolve(),writes=0;
async function digest(image:ImageData){
    const bytes=new Uint8Array(image.data.buffer,image.data.byteOffset,image.data.byteLength);
    const hash=globalThis.crypto?.subtle?new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)): (await import("@noble/hashes/sha256")).sha256(bytes);
    return "v1:"+image.width+"x"+image.height+":"+Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("");
}
async function prune(){
    const entries:{key:string;at:number}[]=[];
    await storage.iterate<Entry,void>((entry,key)=>{entries.push({key,at:entry.at});});
    for(const {key} of entries.sort((a,b)=>b.at-a.at).slice(72))await storage.removeItem(key);
}
export async function cachedRegions(image:ImageData){
    if(!storage.isCurrent())return processImageInWorker({kind:"product-regions",image});
    const key=await digest(image),pending=inFlight.get(key);
    if(pending)return pending;
    const next=(async()=>{
        const saved=await storage.getItem<Entry>(key).catch(()=>null),map=saved?.map;
        if(map?.width===image.width&&map.height===image.height&&map.labels instanceof Uint8Array&&map.labels.length===image.width*image.height&&Array.isArray(map.regions))return map;
        const result=await processImageInWorker({kind:"product-regions",image});
        if(storage.isCurrent()){
            void storage.setItem(key,{at:Date.now(),map:result}).then(()=>{
                if(++writes%8===1)maintenance=maintenance.then(prune).catch(()=>undefined);
            }).catch(()=>undefined);
        }
        return result;
    })().finally(()=>inFlight.delete(key));
    inFlight.set(key,next);return next;
}
