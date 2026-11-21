import {useUserStore} from "@/stores/use-user-store";

function ownerFetch(url:string,owner:string,signal:AbortSignal,method:string){
    if(useUserStore.getState().user?.id!==owner)throw new Error("账号已切换");
    return fetch(url,{method,signal,cache:"no-store",credentials:"same-origin",headers:{"X-Canvas-Owner-Id":owner}});
}
export async function temporaryTryoutPreview(task:string,owner:string,signal:AbortSignal,hasImage:boolean){
    const res=await ownerFetch("/api/tryout/results/"+encodeURIComponent(task)+"/preview",owner,signal,hasImage?"HEAD":"GET");
    if(!res.ok||res.status===204||res.headers.get("Content-Type")?.split(";")[0]!=="image/webp")return null;
    const state=res.headers.get("X-Tryout-Save-State");
    if(state!=="saving"&&state!=="retryable"&&state!=="review")return null;
    return {state,blob:hasImage?null:await res.blob()} as const;
}
export async function retryTryoutSave(task:string,owner:string,signal:AbortSignal){
    const res=await ownerFetch("/api/tasks/"+encodeURIComponent(task)+"/recover",owner,signal,"POST");
    if(!res.ok)throw new Error("未确认保存重试，请核对原任务；没有重新生成");
    const reply=await res.json();
    if(reply.task?.id!==task||typeof reply.recovered!=="boolean")throw new Error("恢复回执不匹配");
    return reply.recovered;
}
