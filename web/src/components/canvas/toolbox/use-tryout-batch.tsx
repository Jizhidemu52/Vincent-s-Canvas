import {App} from "antd";
import {useRef} from "react";
import {useUserStore} from "@/stores/use-user-store";
import {useCanvasGraphStore} from "@/stores/canvas/canvas-graph-store";
import {tryoutNotice} from "./tryout-notice";
import {isTryoutProduct} from "@/lib/tryout/product-node";
import {batchTryout,type BatchJob} from "@/lib/tryout/batch";
import type {DropColor,DropRegion,TryoutChip} from "./tryout-swatch";

export function useTryoutBatch(drop:DropColor,writable:{current:boolean}){
    const {notification}=App.useApp(),preparing=useRef(false);
    const selection=useCanvasGraphStore(s=>s.selectedNodeIds),nodes=useCanvasGraphStore(s=>s.nodes);
    const products=nodes.filter(n=>selection.has(n.id)&&isTryoutProduct(n)).map(n=>n.id);
    const run=async(jobs:BatchJob[])=>{
        const owner=useUserStore.getState().user?.id,route=location.pathname;
        if(!owner||!writable.current||!jobs.length||preparing.current)return;
        preparing.current=true;
        const current=()=>useUserStore.getState().user?.id===owner&&location.pathname===route&&writable.current;
        const notice=tryoutNotice(notification,owner,current,jobs.length);
        try{await notice.finish(await batchTryout(jobs,drop,owner,notice.canSend));}
        catch{notice.dismiss();}
        finally{preparing.current=false;}
    };
    const apply:DropColor=async(id,chip,region,at)=>{
        if(typeof region==="string"&&products.length>1&&products.includes(id))await run(products.map(nodeId=>({nodeId,chip,region:nodeId===id?region:""})));
        else await drop(id,chip,region,at);
    };
    const group=(id:string,chips:TryoutChip[],region:DropRegion)=>{
        const targets=typeof region==="string"&&products.includes(id)?products:[id];
        return run(targets.flatMap(nodeId=>chips.map(chip=>({nodeId,chip,region:nodeId===id?region:""}))));
    };
    return {products,apply,group};
}
