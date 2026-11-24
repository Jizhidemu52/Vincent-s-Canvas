import { useEffect, useRef, type ReactNode } from "react";
import type { KitColor } from "./tryout-palette";
import type {TryoutKit} from "../../../../../shared/tryout-kit";
import {prewarmTryoutSource} from "@/lib/tryout/prewarm";
import {useUserStore} from "@/stores/use-user-store";

export type KitMaterial=TryoutKit["materials"][number];
export type TryoutChip=KitColor|KitMaterial;
export type WearChip={name:string;model:import("../../../../../shared/model-match").ModelSelection;outfit?:{nodeId:string;taskId:string}};
export type DropColor=(nodeId:string,chip:TryoutChip|WearChip,droppedAt:number,transport?:import("@/lib/tryout/batch").TryoutTransport)=>Promise<void>;

export function prewarmVisibleTryoutSources() {
    const owner=useUserStore.getState().user?.id;
    const selector="img[data-tryout-source]";
    let closed=false;
    const warm=(img:HTMLImageElement)=>{
        if(img.isConnected&&img.naturalWidth&&img.dataset.tryoutSource)
            void prewarmTryoutSource(img.dataset.tryoutSource,owner,()=>!closed&&img.isConnected);
    };
    const loaded=(event:Event)=>{
        if(event.target instanceof HTMLImageElement&&event.target.matches(selector)) warm(event.target);
    };
    document.addEventListener("load",loaded,true);
    document.querySelectorAll<HTMLImageElement>(selector).forEach(warm);
    return ()=>{closed=true;document.removeEventListener("load",loaded,true);};
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
    return {id:node.dataset.nodeId,left,top,w,h};
}
type Drag={pointer:number;x:number;y:number;active:boolean;frame:number;overlay:HTMLElement};
export function TryoutSwatch({color,onDrop,notice,writable,selectedId,groupLabel,children,onChoose,chosen}:{chosen?:boolean;onChoose?:()=>void;children?:ReactNode;color:TryoutChip;onDrop:DropColor;notice:(s:string)=>void;writable:{current:boolean};selectedId?:string;groupLabel?:string}){
    const material=!("hex" in color),hex="hex" in color?color.hex:"#908374";
    const drag=useRef<Drag|null>(null),mounted=useRef(false),suppressClick=useRef(false),submitting=useRef(false);
    const clear=()=>{const d=drag.current;if(d){cancelAnimationFrame(d.frame);d.overlay.remove();drag.current=null;}};
    useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;clear();};},[]);
    return <button type="button" aria-label={groupLabel??((material?"拖动换材质：":"拖动换色：")+color.name)} title={groupLabel??color.name} aria-pressed={chosen} className={groupLabel?"tb-grip":material?"tb-pat":"tb-sw"} style={{background:groupLabel||material?undefined:hex}}
        onClick={async e=>{
            if(e.detail&&suppressClick.current){suppressClick.current=false;return;}
            if(!writable.current||submitting.current)return;
            if(onChoose){onChoose();return;}
            if(!selectedId){notice(groupLabel?"请把整组拖到产品上，或先选择产品":"拖到产品上松手，生成 1 款");return;}
            submitting.current=true;try{notice("");await onDrop(selectedId,color,Date.now());}finally{submitting.current=false;}
        }}
        onPointerDown={e=>{
            if(!e.isPrimary||e.button!==0||!writable.current||drag.current)return;
            suppressClick.current=false;
            e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);
            const overlay=document.createElement("div");
            overlay.className="tb-drop-target";
            overlay.hidden=true;
            document.body.append(overlay);
            drag.current={pointer:e.pointerId,x:e.clientX,y:e.clientY,active:false,frame:0,overlay};
        }}
        onPointerMove={e=>{
            const d=drag.current;if(!d||d.pointer!==e.pointerId)return;
            const x=e.clientX,y=e.clientY;
            if(!d.active&&Math.hypot(x-d.x,y-d.y)<5)return;
            d.active=true;
            cancelAnimationFrame(d.frame);
            d.frame=requestAnimationFrame(()=>{
                const hit=target(x,y);
                d.overlay.hidden=!hit;
                if(hit) Object.assign(d.overlay.style,{left:hit.left+"px",top:hit.top+"px",width:hit.w+"px",height:hit.h+"px"});
            });
        }}
        onPointerUp={async e=>{
            const d=drag.current;
            if(!d||d.pointer!==e.pointerId)return;
            const hit=d.active?target(e.clientX,e.clientY):null,at=Date.now();
            suppressClick.current=d.active;
            clear();
            if(!hit||!writable.current||submitting.current)return;
            submitting.current=true;
            try{notice("");await onDrop(hit.id,color,at);}
            catch{if(mounted.current)notice("未能读取本次操作的结果，请查看画布任务");}
            finally{submitting.current=false;}
        }} onLostPointerCapture={clear} onPointerCancel={()=>{suppressClick.current=true;clear();}}>{groupLabel?"整组拖动":children??(material?color.name:null)}</button>;
}
