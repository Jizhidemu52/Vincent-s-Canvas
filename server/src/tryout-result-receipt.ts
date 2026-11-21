import {decryptSecret,encryptSecret} from "./security";
import {isPublicHttpUrl} from "./apimart-upload";
import type {Database} from "./db";
import {TaskExecutionLost} from "./model-concurrency";
import {downloadPinnedOriginal} from "./seedream55-storage";
import {providerImageMimeType} from "./provider-image-result";

type Task={id:string;user_id:string;model_config_id:string|null;upstream_task_id:string|null;request_id:string;operation_type:string;tool_key:string|null;parameters:Record<string,unknown>};
export type TryoutResultReceipt={kind:"tryout-image";version:1;sealed:string};
export const isTryoutImageTask=(t:Task)=>t.request_id.startsWith("tryout:"+t.user_id+":")&&t.tool_key==="canvas-edit"&&t.operation_type==="inpaint"&&["quick","hd"].includes(String(t.parameters.tryoutTier));
const binding=(t:Task)=>[t.id,t.user_id,t.model_config_id,t.upstream_task_id,t.request_id];
const safeUrl=(url:unknown):url is string=>typeof url==="string"&&url.length<=8192&&isPublicHttpUrl(url);
export function sealTryoutResult(t:Task,urls:string[],key:string,now=Date.now()):TryoutResultReceipt{
    if(!isTryoutImageTask(t)||!t.model_config_id||!t.upstream_task_id||urls.length!==1||!safeUrl(urls[0]))throw new TaskExecutionLost("试款结果数量、来源或任务身份不符，未重新提交");
    return {kind:"tryout-image",version:1,sealed:encryptSecret(JSON.stringify({binding:binding(t),url:urls[0],expires:now+86_400_000}),key)};
}
export function openTryoutResult(t:Task,doc:unknown,key:string,now=Date.now()):string{
    try{
        if(isTryoutImageTask(t)&&doc&&typeof doc==="object"&&"kind" in doc&&doc.kind==="tryout-image"&&"version" in doc&&doc.version===1&&"sealed" in doc&&typeof doc.sealed==="string"&&doc.sealed.length<=18000){
            const value=JSON.parse(decryptSecret(doc.sealed,key));
            if(JSON.stringify(value.binding)===JSON.stringify(binding(t))&&safeUrl(value.url)&&Number.isSafeInteger(value.expires)&&value.expires>now)return value.url;
        }
    }catch{}
    throw new TaskExecutionLost("试款结果回执失效或不属于原单，请核查原任务，未重新生成");
}
export async function recordTryoutResult(db:Pick<Database,"query">,t:Task&{execution_token:string},urls:string[],key:string){
    const doc=sealTryoutResult(t,urls,key);
    const saved=await db.query(`UPDATE tasks SET upstream_result_document=$1,updated_at=now()
        WHERE id=$2 AND user_id=$3 AND model_config_id=$4 AND upstream_task_id=$5 AND execution_token=$6 AND status='processing'
        AND lease_expires_at>now() AND upstream_result_document IS NULL RETURNING id`,[JSON.stringify(doc),t.id,t.user_id,t.model_config_id,t.upstream_task_id,t.execution_token]);
    if(!saved.rows.length)throw new TaskExecutionLost("试款结果保存权已改变，请核查原单");
    return doc;
}
export async function downloadTryoutResult(t:Task,doc:unknown,key:string,download=downloadPinnedOriginal){
    const url=openTryoutResult(t,doc,key);
    try{
        const bytes=await download(url),mimeType=providerImageMimeType(bytes,"");
        if(!["image/jpeg","image/png","image/webp"].includes(mimeType))throw new Error();
        return [{bytes,mimeType}];
    }catch{throw Object.assign(new Error("试款图已生成，未能下载原结果；只恢复本单，不会重新生成"),{code:"RESULT_DOWNLOAD_FAILED"});}
}
