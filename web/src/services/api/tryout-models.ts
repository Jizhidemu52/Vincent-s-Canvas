import {useUserStore} from "@/stores/use-user-store";
import {createClientUuid} from "@/lib/client-uuid";
import {uploadServerAsset} from "./server-assets";
import type {ModelAudience} from "../../../../shared/model-match";

export const framingLabels={full:"全身",half:"半身",head:"头肩"};
export const audienceLabels={women:"女装",men:"男装",girls:"女童",boys:"男童"};
export async function modelRequest<T>(url:string,owner:string,signal:AbortSignal,method="GET",body?:unknown):Promise<T>{
    if(useUserStore.getState().user?.id!==owner)throw new Error("账号已切换");
    const res=await fetch(url,{method,signal,credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:body===undefined?undefined:JSON.stringify(body)});
    if(!res.ok){const data=await res.json().catch(()=>({}));throw new Error(data.error?.message||data.message||"模特库暂不可用，请刷新核对");}
    return res.status===204?undefined as T:res.json();
}
export function uploadPortrait(file:File,owner:string,signal:AbortSignal,audience?:ModelAudience){
    return uploadServerAsset(file,{source:audience?"model-library":"model-preset-library",name:file.name.replace(/\.[^.]+$/,"").slice(0,80)||"模特",...(audience?{audience}:{})},{expectedOwnerId:owner,signal,clientReferenceId:"model:"+createClientUuid()});
}
