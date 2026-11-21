import type {MessageInstance} from "antd/es/message/interface";
import {nanoid} from "nanoid";
import {displayNotice} from "@/hooks/use-display-text";
import {uiText} from "@/lib/i18n";
import {mapCanvasAsyncPool} from "@/lib/canvas/canvas-async-pool";
import {canvasImportGridPosition} from "@/lib/canvas/canvas-interaction-ux";
import {isLargeCanvasImage,CANVAS_LARGE_IMAGE_NOTICE} from "@/lib/canvas/canvas-image-upload-limit";
import {CanvasNodeType,type CanvasNodeData,type Position} from "@/types/canvas";
import {prepareCanvasMediaNode} from "./canvas-import-media";
import {placeCanvasImportedNodes} from "./canvas-import-placement";

export async function importCanvasFiles({files,origin,append,current,nodes,message,placeholder,commit}:{
    files:File[];origin:Position;append:boolean;current:()=>boolean;nodes:()=>CanvasNodeData[];message:MessageInstance;
    placeholder:(v:{position:Position;name:string;completed:number;total:number}|null)=>void;commit:(nodes:CanvasNodeData[])=>void;
}){
    if(!current())return;
    const key="canvas-import-"+nanoid();
    let failed=0,completed=0;
    try{
        const prepared=await mapCanvasAsyncPool(files,3,async(file,i)=>{
            if(!current())return null;
            const position=canvasImportGridPosition(origin,i,files.length);
            placeholder({position,name:file.name,completed,total:files.length});
            message.open({key,type:"loading",duration:0,content:displayNotice(uiText("正在导入 {value1}/{value2} 个文件…",{value1:completed,value2:files.length}))});
            try{return await prepareCanvasMediaNode(file,position);}
            catch(error){failed++;if(current())message.error(displayNotice(file.name+"："+(error instanceof Error?error.message:uiText("素材导入失败"))));return null;}
            finally{completed++;}
        });
        if(!current()){message.destroy(key);return;}
        const imported=placeCanvasImportedNodes(nodes(),prepared.filter((n):n is CanvasNodeData=>!!n),append);
        if(imported.length)commit(imported);
        const large=imported.some(n=>n.type===CanvasNodeType.Image&&isLargeCanvasImage({bytes:n.metadata?.bytes,width:n.metadata?.naturalWidth,height:n.metadata?.naturalHeight}));
        const summary=uiText("导入完成：成功 {value1} 个{value2}",{value1:imported.length,value2:failed?uiText("，失败 {count} 个",{count:failed}):""});
        message.open({key,type:failed?"warning":"success",duration:large?7:4,content:displayNotice(large?summary+"。"+uiText(CANVAS_LARGE_IMAGE_NOTICE):summary)});
    }finally{placeholder(null);}
}
