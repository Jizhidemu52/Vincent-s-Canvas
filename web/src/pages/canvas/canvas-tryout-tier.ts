import {flushSync} from "react-dom";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import type {CanvasImageActionRuntimeContext} from "./canvas-image-actions-runtime";
import {useUserStore} from "@/stores/use-user-store";
import {flushCanvasPersistence,useCanvasStore} from "@/stores/canvas/use-canvas-store";
import {getQueuedTask} from "@/services/api/generation-tasks";

export function changeTryoutTier(c:CanvasImageActionRuntimeContext){
    return async({id}:CanvasNodeData)=>{
        const owner=useUserStore.getState().user?.id;
        const active=()=>!!owner&&c.isCurrent()&&useUserStore.getState().user?.id===owner;
        if(!await c.runtime.waitForWriteAccess()||!active())return;
        const node=()=>c.nodesRef.current.find(n=>n.id===id),m=node()?.metadata,t=m?.tryout;
        if(!owner||!t||t.kind==="original"||m.locked||m.status!=="success")return;
        if(m.imageTask){if(m.imageTask.tryoutSwap)void c.runtime.recoverPending(id);return;}
        const quick=t.tier==="hd"?t.quickTaskId:m.sourceTaskId;
        if(!quick)return;
        const tier=t.tier==="hd"?"quick" as const:"hd" as const;
        let requestId="tryout:"+owner+":hd:"+quick;
        if(tier==="quick"){
            const original=await getQueuedTask(quick).catch(()=>null);
            if(!await c.runtime.waitForWriteAccess()||!active()||node()?.metadata?.imageTask||node()?.metadata?.sourceTaskId!==m.sourceTaskId||node()?.metadata?.tryout?.tier!==t.tier)return;
            if(original?.id!==quick||original.status!=="success"||!original.requestId?.startsWith("tryout:"+owner+":")){void c.message.warning("暂时无法读取快速档，高清图已保留");return;}
            requestId=original.requestId;
        }
        const binding={ownerId:owner,projectId:c.projectId,requestId,resultIndex:0,tryoutSwap:{tier,quickTaskId:quick},...(tier==="quick"?{taskId:quick}:{})};
        const pending=()=>active()&&node()?.metadata?.imageTask?.requestId===binding.requestId;
        const patch=(change:Partial<CanvasNodeMetadata>)=>flushSync(()=>c.setField("nodes",prev=>prev.map(n=>n.id===id?{...n,metadata:{...n.metadata,...change}}:n)));
        const save=async()=>{c.projectSaveQueueRef.current?.flush();useCanvasStore.getState().updateProject(c.projectId,{nodes:c.nodesRef.current});await flushCanvasPersistence();};
        c.flushPendingHistory();patch({imageTask:binding,errorDetails:undefined});
        let uncertain=false;
        try{
            await save();
            if(!await c.runtime.waitForWriteAccess()||!pending())return;
            if(tier==="hd"){
                uncertain=true;
                const res=await fetch("/api/tryout/quick",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:JSON.stringify({kind:"refine",canvasId:c.projectId,nodeId:id,sourceTaskId:quick})});
                if(!res.ok){uncertain=res.status>=500||res.status===408;const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||e.message||"高清任务未受理");}
                const result=await res.json();
                if(!result.taskId)throw new Error("未取得高清任务编号");
                if(!await c.runtime.waitForWriteAccess()||!pending())return;
                patch({imageTask:{...binding,taskId:result.taskId}});await save();
            }
            if(pending())void c.runtime.recoverPending(id);
        }catch(error){
            if(!await c.runtime.waitForWriteAccess()||!pending())return;
            const reason=uncertain?"高清提交待核查，保留快速档；只查询原单":error instanceof Error?error.message:"未能切换档位";
            patch({errorDetails:reason,...(uncertain?{}:{imageTask:undefined})});
            void c.message.warning(reason);await save();
            if(uncertain&&pending())void c.runtime.recoverPending(id);
        }
    };
}
