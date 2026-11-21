import type {App} from "antd";
import type {CanvasNodeData} from "@/types/canvas";
import {isTryoutProduct} from "@/lib/tryout/product-node";
import type {DropColor} from "./tryout-swatch";

export function outfitDrop(nodes:{current:CanvasNodeData[]},writable:{current:boolean},ui:Pick<ReturnType<typeof App.useApp>,"message"|"modal">,drop:DropColor){
    return (id:string,x:number,y:number)=>{
        if(!writable.current||!isTryoutProduct(nodes.current.find(n=>n.id===id)))return false;
        const hit=document.elementsFromPoint(x,y).map(e=>e.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId).find(n=>n&&n!==id);
        const m=nodes.current.find(n=>n.id===hit)?.metadata,t=m?.tryout;
        if(!hit||t?.kind!=="wear"||m?.status!=="success"||m.imageTask||m.locked||!m.sourceTaskId)return false;
        const origin={nodeId:hit,taskId:m.sourceTaskId};
        if(t.products?.includes(id)||(t.products?.length??0)>=4){void ui.message.info("一套最多四件不同产品，本次未提交");return true;}
        ui.modal.confirm({title:"把这件产品加入搭配？",content:"沿用原模特和原产品图，生成 1 张新的上身图。原图位置不变。",okText:"生成 1 张搭配图",cancelText:"不生成",onOk:()=>drop(id,{name:"搭配",model:{auto:true},outfit:origin},"",Date.now())});
        return true;
    };
}
