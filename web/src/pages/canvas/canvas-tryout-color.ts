import { flushSync } from "react-dom";
import { createClientUuid } from "@/lib/client-uuid";
import { canvasImageSource,hasCanvasImageSource } from "@/lib/canvas/canvas-image-source";
import { variantSlot } from "@/lib/tryout/placement";
import { ensureCloudMedia } from "@/services/canvas-cloud-media";
import { serverMediaId } from "@/services/canvas-media-links";
import { flushCanvasPersistence,useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType,type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasImageActionRuntimeContext } from "./canvas-image-actions-runtime";
import type { DropColor } from "@/components/canvas/toolbox/tryout-swatch";
import { colorPrompt } from "../../../../shared/tryout-prompts";
import type { TryoutSubmissionInput } from "../../../../shared/tryout-submission";

export function colorDrop(context:CanvasImageActionRuntimeContext):DropColor{
    return async(sourceId,swatch,regionHex,droppedAt)=>{
        const {nodesRef,runtime,projectId,message,setField,isCurrent}=context;
        const source=nodesRef.current.find(n=>n.id===sourceId),owner=useUserStore.getState().user?.id;
        if(!owner||!isCurrent()||source?.type!==CanvasNodeType.Image||!hasCanvasImageSource(source.metadata)||source.metadata.status==="loading"||source.metadata.status==="error"||source.metadata.proposalBoard||source.metadata.tryout?.kind==="wear")return;
        const metadata=source.metadata,url=canvasImageSource(metadata),rootNodeId=metadata.tryout?.rootNodeId||source.id;
        const color="hex" in swatch?{name:swatch.name,hex:swatch.hex,...(swatch.library?{library:swatch.library}:{}),...(swatch.code?{code:swatch.code}:{})}:null;
        const material="hex" in swatch?null:{name:swatch.name,presetId:swatch.presetId,assetId:swatch.assetId};
        if(!color&&!material?.assetId&&!material?.presetId)return;
        const prompt=color?colorPrompt(null,null,color,regionHex):"试材质："+swatch.name,id=createClientUuid(),requestId=createClientUuid();
        const trace={version:1,rootNodeId,sourceNodeId:source.id,tier:"quick",prompt,timing:{droppedAt},...(color?{kind:"color",color} as const:{kind:"material",material:material!} as const)} as const;
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
        flushSync(()=>setField("nodes",prev=>[...prev,{id,type:CanvasNodeType.Image,title:source.title+" · "+swatch.name,width:source.width,height:source.height,
            position:variantSlot(prev.find(n=>n.id===rootNodeId)??source,prev,source),metadata:{status:"loading",prompt,tryout:trace,imageTask:binding}}]));
        let uncertain=false;
        try{
            await persist();
            if(!valid())return;
            if(url&&!serverMediaId(url)&&!url.startsWith("data:image/")&&!url.startsWith("blob:"))throw new Error("请先将原图存入当前画布");
            const sourceAssetId=metadata.serverAssetId||serverMediaId(url)||serverMediaId(await ensureCloudMedia(owner,{url,storageKey:metadata.storageKey,mimeType:metadata.mimeType,name:metadata.originalFileName},{projectId,source:"canvas"}));
            if(!sourceAssetId)throw new Error("原图尚未保存到服务器");
            if(!await runtime.waitForWriteAccess()||!valid())return;
            const original=nodesRef.current.find(n=>n.id===sourceId)?.metadata;
            if(!original||canvasImageSource(original)!==url||original.storageKey!==metadata.storageKey)throw new Error("原图已变更，未提交试款");
            const common={tier:"quick",canvasId:projectId,nodeId:id,requestId,sourceAssetId} as const;
            const input:TryoutSubmissionInput=color?{...common,kind:"color",color,fallbackHex:regionHex}:{...common,kind:"material",fallbackHex:regionHex,material:material!.presetId?{presetId:material!.presetId}:{assetId:material!.assetId!}};
            uncertain=true;
            const res=await fetch("/api/tryout/quick",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:JSON.stringify(input)});
            if(!res.ok){
                uncertain=res.status<400||res.status>=500||res.status===408;
                const payload=await res.json().catch(()=>({}));
                throw new Error(typeof payload.error?.message==="string"?payload.error.message:typeof payload.message==="string"?payload.message:"试款提交未获确认（"+res.status+"）");
            }
            const result=await res.json();
            if(typeof result.taskId!=="string"||!result.taskId)throw new Error("缺少任务编号");
            if(!await runtime.waitForWriteAccess()||!valid())return;
            patch({imageTask:{...binding,taskId:result.taskId},sourceTaskId:result.taskId,prompt:result.prompt||prompt,tryout:{...trace,prompt:result.prompt||prompt,timing:{droppedAt,submittedAt:Date.now()}}});
            await persist();
            if(valid())void runtime.recoverPending(id);
        }catch(error){
            if(!await runtime.waitForWriteAccess()||!valid())return;
            const reason=uncertain?"提交结果待核查，只查询原任务，不会重新提交":error instanceof Error?error.message:"未提交试款";
            patch({status:"error",errorDetails:reason,...(uncertain?{}:{imageTask:undefined})});
            void message.warning(reason);
            await persist();
            if(uncertain&&valid())void runtime.recoverPending(id);
        }
    };
}
