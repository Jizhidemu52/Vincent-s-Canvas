import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { uploadServerAsset } from "@/services/api/server-assets";
import type { ReferenceImage } from "@/types/image";

type PublicModel = { id: string; name: string; modelId: string; capabilities: string[]; creditCost: number; rmbCost: number };
type Task = { id: string; requestId: string; status: string; resultUrls: string[]; failureReason: string | null };
async function request<T>(path:string,init?:RequestInit):Promise<T>{const response=await fetch(path,{...init,credentials:"include",headers:{"content-type":"application/json",...init?.headers}});if(!response.ok){const body=await response.json().catch(()=>({})) as {message?:string};throw new Error(body.message||"任务提交失败");}return response.status===204?undefined as T:response.json() as Promise<T>;}

export async function requestQueuedImages(input:{modelId:string;prompt:string;count:number;operationType:"image_generation"|"inpaint";references?:ReferenceImage[];signal?:AbortSignal}){
    const models=await request<{models:PublicModel[]}>("/api/models");
    const model=models.models.find((item)=>item.id===input.modelId||item.modelId===input.modelId||item.name===input.modelId);
    if(!model)throw new Error(`管理员尚未启用模型：${input.modelId}`);
    const sourceUrls:string[]=[];
    for(const reference of input.references||[]){const dataUrl=await imageToDataUrl(reference);const file=dataUrlToFile({...reference,dataUrl});const assetId=await uploadServerAsset(file,{title:reference.name,source:"task-reference"});sourceUrls.push(`/api/assets/${assetId}/content`);}
    const rootRequestId=crypto.randomUUID();
    let ids:string[]=[];
    const projectId=window.location.pathname.match(/^\/canvas\/([^/]+)/)?.[1]||"image-workbench";
    if(input.count===1){const result=await request<{task:{id:string}}>("/api/tasks",{method:"POST",body:JSON.stringify({requestId:rootRequestId,projectId,operationType:input.operationType,modelConfigId:model.id,prompt:input.prompt,sourceUrls,priority:"normal"})});ids=[result.task.id];}
    else{const result=await request<{tasks:Array<{id:string}>;failures:Array<{reason:string}>}>("/api/tasks/batch",{method:"POST",body:JSON.stringify({requestId:rootRequestId,projectId,operationType:input.operationType,modelConfigId:model.id,prompt:input.prompt,priority:"normal",items:Array.from({length:input.count},()=>({sourceUrls}))})});if(result.failures.length&&!result.tasks.length)throw new Error(result.failures[0]!.reason);ids=result.tasks.map((task)=>task.id);}
    let tasks:Task[];
    try{tasks=await waitForTasks(ids,input.signal);}catch(error){if(input.signal?.aborted)await Promise.allSettled(ids.map((id)=>request<void>(`/api/tasks/${id}/cancel`,{method:"POST"})));throw error;}
    const failed=tasks.find((task)=>task.status==="failed"||task.status==="cancelled");if(failed)throw new Error(failed.failureReason||"生成任务失败");
    return tasks.flatMap((task)=>task.resultUrls.map((dataUrl)=>({id:nanoid(),dataUrl})));
}

async function waitForTasks(ids:string[],signal?:AbortSignal){const wanted=new Set(ids);for(;;){if(signal?.aborted)throw new DOMException("请求已取消","AbortError");const result=await request<{tasks:Task[]}>("/api/tasks");const tasks=result.tasks.filter((task)=>wanted.has(task.id));if(tasks.length===ids.length&&tasks.every((task)=>["success","failed","cancelled"].includes(task.status)))return tasks;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1000);signal?.addEventListener("abort",()=>{clearTimeout(timer);reject(new DOMException("请求已取消","AbortError"));},{once:true});});}}
