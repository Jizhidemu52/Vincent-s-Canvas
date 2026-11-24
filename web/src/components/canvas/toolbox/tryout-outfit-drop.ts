import type {App} from "antd";
import type {CanvasNodeData} from "@/types/canvas";
import {isTryoutProduct} from "@/lib/tryout/product-node";
import type {DropColor} from "./tryout-swatch";

export function outfitDrop(nodes:{current:CanvasNodeData[]},writable:{current:boolean},ui:Pick<ReturnType<typeof App.useApp>,"message">,drop:DropColor){
    return (id:string,x:number,y:number,preview=false)=>{
        if(!writable.current||!isTryoutProduct(nodes.current.find(n=>n.id===id)))return false;
        const hit=document.elementsFromPoint(x,y).map(e=>e.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId).find(n=>n&&n!==id);
        const m=nodes.current.find(n=>n.id===hit)?.metadata,t=m?.tryout;
        const marker=document.getElementById("tryout-outfit-hint");
        if(!hit||t?.kind!=="wear"||m?.status!=="success"||m.imageTask||m.locked||!m.sourceTaskId){marker?.remove();return false;}
        const origin={nodeId:hit,taskId:m.sourceTaskId};
        const blocked=t.products?.includes(id)||(t.products?.length??0)>=4;
        if(preview){
            const hint=marker??document.createElement("span");
            if(!marker){hint.id="tryout-outfit-hint";hint.className="wb-surface pointer-events-none fixed z-[9999] rounded border px-3 py-2 text-sm";hint.setAttribute("role","status");document.body.append(hint);}
            hint.style.left=Math.min(x+16,window.innerWidth-220)+"px";hint.style.top=Math.max(4,y-40)+"px";hint.textContent=blocked?"一套最多四件不同产品":"松手生成 1 张搭配图";
            return true;
        }
        marker?.remove();
        if(blocked){void ui.message.info("一套最多四件不同产品，本次未提交");return true;}
        void drop(id,{name:"搭配",model:{auto:true},outfit:origin},Date.now());
        return true;
    };
}
