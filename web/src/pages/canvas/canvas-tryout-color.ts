import { flushSync } from "react-dom";
import {tryoutNotice} from "@/components/canvas/toolbox/tryout-notice";
import { createClientUuid } from "@/lib/client-uuid";
import {trackQuickDisplay} from "@/lib/tryout/display-timing";
import { canvasImageSource,hasCanvasImageSource } from "@/lib/canvas/canvas-image-source";
import { variantSlot,wearSlot } from "@/lib/tryout/placement";
import { ensureCloudMedia } from "@/services/canvas-cloud-media";
import { serverMediaId } from "@/services/canvas-media-links";
import { flushCanvasPersistence,useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType,type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasImageActionRuntimeContext } from "./canvas-image-actions-runtime";
import type { DropColor } from "@/components/canvas/toolbox/tryout-swatch";
import { colorPrompt,wearPrompt } from "../../../../shared/tryout-prompts";
import type {TryoutMeta} from "../../../../shared/tryout";
import type { TryoutSubmissionInput } from "../../../../shared/tryout-submission";

export function colorDrop(context:CanvasImageActionRuntimeContext):DropColor{
    return async(sourceId,swatch,droppedAt,transport)=>{
        const {nodesRef,runtime,projectId,message,setField,isCurrent}=context;
        const source=nodesRef.current.find(n=>n.id===sourceId),owner=useUserStore.getState().user?.id;
        if(!owner||!isCurrent()||source?.type!==CanvasNodeType.Image||!hasCanvasImageSource(source.metadata)||source.metadata.status==="loading"||source.metadata.status==="error"||source.metadata.locked||source.metadata.proposalBoard||source.metadata.tryout?.kind==="wear")return;
        const metadata=source.metadata,url=canvasImageSource(metadata);
        const color="hex" in swatch?{name:swatch.name,hex:swatch.hex,...(swatch.library?{library:swatch.library}:{}),...(swatch.code?{code:swatch.code}:{})}:null;
        const wear="model" in swatch?swatch:null;
        const origin=wear?.outfit,prior=origin?nodesRef.current.find(n=>n.id===origin.nodeId):undefined,priorMeta=prior?.metadata,previous=priorMeta?.tryout;
        if(origin&&(previous?.kind!=="wear"||priorMeta?.status!=="success"||priorMeta.sourceTaskId!==origin.taskId||priorMeta.imageTask||priorMeta.locked))return;
        const rootNodeId=previous?.rootNodeId||metadata.tryout?.rootNodeId||source.id,products=[...(previous?.products??[]),source.id];
        if(origin&&(products.length>4||new Set(products).size!==products.length)){void message.warning("一套最多四件不同产品，本次未提交");return;}
        const material="hex" in swatch||"model" in swatch?null:{name:swatch.name,presetId:swatch.presetId,assetId:swatch.assetId};
        if(!wear&&!color&&!material?.assetId&&!material?.presetId)return;
        const prompt=wear?wearPrompt(products.map(()=>null)):color?colorPrompt(null,null,color):"试材质："+swatch.name,id=createClientUuid(),requestId=createClientUuid();
        const trace:TryoutMeta={version:1,rootNodeId,sourceNodeId:previous?.sourceNodeId??source.id,tier:"quick",prompt,timing:{droppedAt},...(wear?{kind:"wear",model:previous?.model??{name:wear.name,...("auto" in wear.model?{}:wear.model)},products} as const:color?{kind:"color",color} as const:{kind:"material",material:material!} as const)};
        const binding={projectId,ownerId:owner,requestId:"tryout:"+owner+":"+requestId,resultIndex:0};
        const output=()=>nodesRef.current.find(n=>n.id===id);
        const valid=()=>isCurrent()&&output()?.metadata?.imageTask?.requestId===binding.requestId;
        const patch=(data:Partial<CanvasNodeMetadata>)=>flushSync(()=>setField("nodes",prev=>prev.map(n=>n.id===id&&n.metadata?.imageTask?.requestId===binding.requestId?{...n,metadata:{...n.metadata,...data}}:n)));
        const persist=async()=>{
            context.projectSaveQueueRef.current?.flush();
            useCanvasStore.getState().updateProject(projectId,{nodes:nodesRef.current});
            await flushCanvasPersistence();
        };
        context.flushPendingHistory();
        flushSync(()=>setField("nodes",prev=>[...prev,{id,type:CanvasNodeType.Image,title:source.title+" · "+swatch.name,width:(prior??source).width,height:(prior??source).height,
            position:prior?variantSlot(prior,prev):wear?wearSlot(source,prev):variantSlot(prev.find(n=>n.id===rootNodeId)??source,prev,source),metadata:{status:"loading",prompt,tryout:trace,imageTask:binding}}]));
        let uncertain=false,finishedNotice=false;
        const notice=transport?undefined:tryoutNotice(context.notification,owner,isCurrent,1);
        try{
            await persist();
            if(!valid())return;
            if(url&&!serverMediaId(url)&&!url.startsWith("data:image/")&&!url.startsWith("blob:"))throw new Error("请先将原图存入当前画布");
            const sourceAssetId=metadata.serverAssetId||serverMediaId(url)||serverMediaId(await ensureCloudMedia(owner,{url,storageKey:metadata.storageKey,mimeType:metadata.mimeType,name:metadata.originalFileName},{projectId,source:"canvas"}));
            if(!sourceAssetId)throw new Error("原图尚未保存到服务器");
            if(!await runtime.waitForWriteAccess()||!valid())return;
            const original=nodesRef.current.find(n=>n.id===sourceId)?.metadata;
            if(!original||canvasImageSource(original)!==url||original.storageKey!==metadata.storageKey)throw new Error("原图已变更，未提交试款");
            const common={tier:"quick",canvasId:projectId,nodeId:id,requestId} as const;
            if(origin){const m=nodesRef.current.find(n=>n.id===origin.nodeId)?.metadata;if(m?.sourceTaskId!==origin.taskId||m?.imageTask||m.locked||m.status!=="success")throw new Error("原上身图已变化，未提交搭配");}
            const input:TryoutSubmissionInput=origin?{kind:"outfit",canvasId:projectId,nodeId:id,requestId,originTaskId:origin.taskId,originNodeId:origin.nodeId,sourceAssetId}:wear?{...common,kind:"wear",model:wear.model,productAssetIds:[sourceAssetId]}:color?{...common,sourceAssetId,kind:"color",color}:{...common,sourceAssetId,kind:"material",material:material!.presetId?{presetId:material!.presetId}:{assetId:material!.assetId!}};
            if(notice&&!notice.canSend())throw new Error("已取消，本次未提交");
            uncertain=true;
            const res=transport?await transport(input,owner,()=>{
                const latest=nodesRef.current.find(n=>n.id===sourceId)?.metadata;
                return valid()&&!!latest&&!latest.locked&&canvasImageSource(latest)===url&&latest.storageKey===metadata.storageKey;
            }):await fetch("/api/tryout/quick",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:JSON.stringify(input)});
            if(!res.ok){
                uncertain=res.status<400||res.status>=500||res.status===408;
                const payload=await res.json().catch(()=>({}));
                throw new Error(typeof payload.error?.message==="string"?payload.error.message:typeof payload.message==="string"?payload.message:"试款提交未获确认（"+res.status+"）");
            }
            const result=await res.json();
            const submittedAt=Date.now();
            if(typeof result.taskId!=="string"||!result.taskId)throw new Error("缺少任务编号");
            if(notice){finishedNotice=true;await notice.finish({accepted:[result.taskId],rejected:0,unknown:0});}
            if(!await runtime.waitForWriteAccess()||!valid())return;
            trackQuickDisplay(result.taskId,owner,droppedAt,submittedAt);
            patch({imageTask:{...binding,taskId:result.taskId},sourceTaskId:result.taskId,prompt:result.prompt||prompt,tryout:{...trace,...(wear&&typeof result.model?.name==="string"?{model:{name:result.model.name,...(typeof result.model.presetId==="string"?{presetId:result.model.presetId}:typeof result.model.assetId==="string"?{assetId:result.model.assetId}:{})}}:{}),prompt:result.prompt||prompt,timing:{droppedAt,submittedAt}}});
            await persist();
            if(valid())void runtime.recoverPending(id);
        }catch(error){
            if(!await runtime.waitForWriteAccess()||!valid())return;
            const reason=uncertain?"提交结果待核查，只查询原任务，不会重新提交":error instanceof Error?error.message:"未提交试款";
            patch({status:"error",errorDetails:reason,...(uncertain?{}:{imageTask:undefined})});
            if(!transport&&!uncertain)void message.warning(reason);
            if(notice&&!finishedNotice){finishedNotice=true;await notice.finish({accepted:[],rejected:uncertain?0:1,unknown:uncertain?1:0});}
            await persist();
            if(uncertain&&valid())void runtime.recoverPending(id);
        }finally{if(!finishedNotice)notice?.dismiss();}
    };
}
