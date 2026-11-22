import { useEffect, useRef,type ReactNode } from "react";
import { cachedRegions } from "@/lib/tryout/region-cache";
import { regionAtPoint, type ProductRegions } from "@/lib/tryout/product-regions";
import type { KitColor } from "./tryout-palette";
import type {TryoutKit} from "../../../../../shared/tryout-kit";
import {prewarmTryoutSource} from "@/lib/tryout/prewarm";
import {useUserStore} from "@/stores/use-user-store";

export type KitMaterial=TryoutKit["materials"][number];
export type TryoutChip=KitColor|KitMaterial;
export type WearChip={name:string;model:import("../../../../../shared/model-match").ModelSelection;outfit?:{nodeId:string;taskId:string}};
export type DropColor=(nodeId:string,chip:TryoutChip|WearChip,regionHex:string,droppedAt:number,transport?:import("@/lib/tryout/batch").TryoutTransport)=>Promise<void>;
const maps=new WeakMap<HTMLImageElement,{url:string;map:Promise<ProductRegions>}>();
function regionMap(img:HTMLImageElement) {
    const existing=maps.get(img);
    if(existing?.url===img.currentSrc)return existing.map;
    const scale=Math.min(1,512/Math.max(img.naturalWidth,img.naturalHeight));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx=canvas.getContext("2d")!;
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    const map=cachedRegions(ctx.getImageData(0,0,canvas.width,canvas.height));
    maps.set(img,{url:img.currentSrc,map});void map.catch(()=>maps.delete(img));
    return map;
}
export function prewarmVisibleRegions(){
    const owner=useUserStore.getState().user?.id;
    const selector="img[data-canvas-image-resolution]",queue=new Set<HTMLImageElement>();
    let active=false,closed=false,timer=0;
    const drain=async()=>{
        if(active||closed)return;
        active=true;
        try{
            for(const img of queue){
                queue.delete(img);
                if(closed)break;
                if(img.isConnected&&img.naturalWidth){
                    if(img.dataset.tryoutSource)void prewarmTryoutSource(img.dataset.tryoutSource,owner,()=>!closed&&img.isConnected);
                    try{await regionMap(img);}catch{}
                }
            }
        }finally{active=false;}
    };
    const add=(img:HTMLImageElement)=>{queue.add(img);clearTimeout(timer);timer=window.setTimeout(()=>void drain(),32);};
    const loaded=(e:Event)=>{if(e.target instanceof HTMLImageElement&&e.target.matches(selector))add(e.target);};
    document.addEventListener("load",loaded,true);
    document.querySelectorAll<HTMLImageElement>(selector).forEach(img=>{if(img.naturalWidth)add(img);});
    return ()=>{closed=true;queue.clear();clearTimeout(timer);document.removeEventListener("load",loaded,true);};
}
function target(x:number,y:number){
    const node=document.elementFromPoint(x,y)?.closest<HTMLElement>("[data-node-id]");
    const img=node?.querySelector<HTMLImageElement>("img[data-canvas-image-resolution]");
    if(!img?.naturalWidth||!img.naturalHeight||!node?.dataset.nodeId)return;
    const rect=img.getBoundingClientRect(), contain=getComputedStyle(img).objectFit==="contain";
    const scale=Math.min(rect.width/img.naturalWidth,rect.height/img.naturalHeight);
    const w=contain?img.naturalWidth*scale:rect.width,h=contain?img.naturalHeight*scale:rect.height;
    const left=rect.left+(rect.width-w)/2,top=rect.top+(rect.height-h)/2;
    const u=(x-left)/w,v=(y-top)/h;
    if(!(u>=0&&u<1&&v>=0&&v<1))return;
    return {id:node.dataset.nodeId,img,u,v,left,top,w,h};
}
type Drag={pointer:number;x:number;y:number;active:boolean;frame:number;seq:number;overlay:HTMLCanvasElement;paintKey?:string};
export function TryoutSwatch({color,onDrop,notice,writable,selectedId,groupLabel,children}:{children?:ReactNode;color:TryoutChip;onDrop:DropColor;notice:(s:string)=>void;writable:{current:boolean};selectedId?:string;groupLabel?:string}){
    const material=!("hex" in color),hex="hex" in color?color.hex:"#908374";
    const drag=useRef<Drag|null>(null),mounted=useRef(false),suppressClick=useRef(false),submitting=useRef(false);
    const clear=()=>{const d=drag.current;if(d){cancelAnimationFrame(d.frame);d.overlay.remove();drag.current=null;}};
    useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;clear();};},[]);
    return <button type="button" aria-label={groupLabel??((material?"拖动换材质：":"拖动换色：")+color.name)} title={groupLabel??color.name} className={groupLabel?"tb-grip":material?"tb-pat":"tb-sw"} style={{background:groupLabel||material?undefined:hex}}
        onClick={async e=>{
            if(e.detail&&suppressClick.current){suppressClick.current=false;return;}
            if(!writable.current||submitting.current)return;
            if(!selectedId){notice(groupLabel?"请把整组拖到产品上，或先选择产品":"拖到产品上松手，生成 1 款");return;}
            submitting.current=true;try{notice("");await onDrop(selectedId,color,"",Date.now());}finally{submitting.current=false;}
        }}
        onPointerDown={e=>{
            if(!e.isPrimary||e.button!==0||!writable.current||drag.current)return;
            suppressClick.current=false;
            e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);
            const overlay=document.createElement("canvas");
            Object.assign(overlay.style,{position:"fixed",pointerEvents:"none",zIndex:"9999",display:"none"});
            document.body.append(overlay);drag.current={pointer:e.pointerId,x:e.clientX,y:e.clientY,active:false,seq:0,frame:0,overlay};
        }}
        onPointerMove={e=>{
            const d=drag.current;if(!d||d.pointer!==e.pointerId)return;
            const x=e.clientX,y=e.clientY;
            if(!d.active&&Math.hypot(x-d.x,y-d.y)<5)return;
            d.active=true;const seq=++d.seq;cancelAnimationFrame(d.frame);
            d.frame=requestAnimationFrame(async()=>{
                const hit=target(x,y);
                if(!hit){d.overlay.style.display="none";return;}
                try{
                    const map=await regionMap(hit.img);
                    if(d!==drag.current||seq!==d.seq)return;
                    const id=regionAtPoint(map,hit.u*map.width,hit.v*map.height);
                    if(!id){d.overlay.style.display="none";return;}
                    const key=hit.id+":"+hit.img.currentSrc+":"+id;
                    if(d.paintKey!==key){
                        d.overlay.width=map.width;d.overlay.height=map.height;
                        const ctx=d.overlay.getContext("2d")!,data=ctx.createImageData(map.width,map.height);
                        const rgb=parseInt(hex.slice(1),16);
                        for(let i=0;i<map.labels.length;i++)if(map.labels[i]===id){data.data.set([rgb>>16,(rgb>>8)&255,rgb&255,112],i*4);}
                        ctx.putImageData(data,0,0);d.paintKey=key;
                    }
                    Object.assign(d.overlay.style,{display:"block",left:hit.left+"px",top:hit.top+"px",width:hit.w+"px",height:hit.h+"px"});
                }catch{if(d===drag.current)d.overlay.style.display="none";}
            });
        }}
        onPointerUp={async e=>{
            const d=drag.current;if(!d||d.pointer!==e.pointerId)return;
            const hit=d.active?target(e.clientX,e.clientY):null,at=Date.now(),url=hit?.img.currentSrc;
            suppressClick.current=d.active;clear();if(!hit)return;
            try{const map=await regionMap(hit.img);
                if(!mounted.current||!writable.current||!hit.img.isConnected||hit.img.currentSrc!==url)return;
                const id=regionAtPoint(map,hit.u*map.width,hit.v*map.height),region=map.regions.find(r=>r.id===id);
                if(!region){notice("这里是背景，未提交试款");return;}
                notice("");await onDrop(hit.id,color,region.color,at);
            }catch{if(mounted.current)notice("未能读取本次操作的结果，请查看画布任务");}
        }} onLostPointerCapture={clear} onPointerCancel={()=>{suppressClick.current=true;clear();}}>{groupLabel?"整组拖动":children??(material?color.name:null)}</button>;
}
