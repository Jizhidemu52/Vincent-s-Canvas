import {createHash,randomUUID} from "node:crypto";
import {setTimeout as wait} from "node:timers/promises";
import type {Database} from "./db";
import {publishedFabric} from "./tryout-private-assets";
import {allowedPreset} from "./model-library";
import type {AppConfig} from "./config";
import {createTryoutReferenceBytes} from "./asset-thumbnails";
import {uploadApiMartImage,isPublicHttpsUrl,validateApiMartGenerationImage} from "./apimart-upload";

type Image={bytes:Uint8Array;mimeType:string};
type Settings=Pick<AppConfig,"TRYOUT_REFERENCE_MAX_EDGE"|"APIMART_UPLOAD_CACHE_ENABLED"|"APIMART_UPLOAD_RETENTION_DAYS">;
type Provider={providerId:string;baseUrl:string;apiKey:string};
type Input={ownerId:string;companyPortrait?:true;tier:"quick"|"hd";provider:Provider;sha256:string;read:()=>Promise<Image>;taskId?:string};
const hash=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
const columns="provider_id,owner_user_id,credential_scope,content_sha256,reference_spec";
const keyMatch="(provider_id,owner_user_id,credential_scope,content_sha256,reference_spec)=($1,$2,$3,$4,$5)";
function cachePartition(provider:Provider,tier:"quick"|"hd",edge:number){
    return {scope:hash(JSON.stringify([provider.baseUrl.replace(/\/+$/,""),provider.apiKey])),spec:tier==="hd"?"original-v1":"webp-still-v1:"+edge};
}
export async function lookupReadyTryoutInputs(db:Pick<Database,"query">,settings:Settings,input:Omit<Input,"sha256"|"read"|"companyPortrait">&{taskId:string;sourceUrls:string[];presetId?:string;fabric?:boolean}){
    if(settings.APIMART_UPLOAD_CACHE_ENABLED!=="true"||!input.sourceUrls.length)return;
    const ids=input.sourceUrls.map(url=>/^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i.exec(url)?.[1]);
    if(ids.some(id=>!id))throw new Error("试款参考图必须来自当前员工素材");
    const {scope,spec}=cachePartition(input.provider,input.tier,settings.TRYOUT_REFERENCE_MAX_EDGE);
    const slot=input.fabric?2:1;
    const access=input.presetId?`(CASE WHEN a.id=($1::uuid[])[${slot}] THEN ${input.fabric?publishedFabric("$6"):allowedPreset("$6")} ELSE a.owner_user_id=$2 END)`:"a.owner_user_id=$2";
    const matched=await db.query<{id:string;url:string;generation_id:string}>(`SELECT a.id,c.url,c.generation_id FROM assets a JOIN provider_upload_cache c ON c.owner_user_id=a.owner_user_id AND c.content_sha256=a.content_sha256
        WHERE a.id=ANY($1::uuid[]) AND ${access} AND a.status='ready' AND a.kind='image' AND a.deleted_at IS NULL AND c.provider_id=$3 AND c.credential_scope=$4 AND c.reference_spec=${input.presetId?`CASE WHEN a.id=($1::uuid[])[${slot}] THEN $5 || ':published' ELSE $5 END`:"$5"} AND c.url IS NOT NULL AND c.expires_at>now()+interval '2 minutes'`,[ids,input.ownerId,input.provider.providerId,scope,spec,...(input.presetId?[input.presetId]:[])]);
    const byId=new Map(matched.rows.map(row=>[row.id,row]));
    const ordered=ids.map(id=>byId.get(id!));
    if(!ordered.every(row=>row&&isPublicHttpsUrl(row.url)))return;
    await db.query("INSERT INTO provider_upload_task_inputs(task_id,generation_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING",[input.taskId,ordered.map(row=>row!.generation_id)]);
    return ordered.map(row=>row!.url);
}
export function tryoutReferenceService(db:Pick<Database,"query">,settings:Settings,io:{upload?:typeof uploadApiMartImage;resize?:typeof createTryoutReferenceBytes;sleep?:(ms:number)=>Promise<unknown>}={}){
    const send=io.upload??uploadApiMartImage,resize=io.resize??createTryoutReferenceBytes;
    const upload=async(input:Input)=>{
        const original=await input.read();
        if(hash(original.bytes)!==input.sha256)throw new Error("试款原图已变更，请重新选择图片");
        const image=input.tier==="hd"?original:{bytes:await resize(original.bytes,settings.TRYOUT_REFERENCE_MAX_EDGE),mimeType:"image/webp"};
        validateApiMartGenerationImage(image);
        let expiresAt:number|undefined;
        const url=await send({...image,...input.provider,purpose:"image",retentionDays:settings.APIMART_UPLOAD_RETENTION_DAYS,onReceipt:receipt=>{
            expiresAt=receipt.expiresAt;
            if(receipt.quotaRemaining!==undefined&&receipt.quotaRemaining<=5)console.warn(JSON.stringify({event:"tryout.upload_quota_low",providerId:input.provider.providerId,remaining:receipt.quotaRemaining}));
            if(receipt.charged)console.warn(JSON.stringify({event:"tryout.reference_upload_charged",providerId:input.provider.providerId}));
        }});
        if(!isPublicHttpsUrl(url))throw new Error("供应商未返回有效的 HTTPS 参考图地址");
        const now=Date.now();
        if(expiresAt!==undefined&&expiresAt<now+180_000)throw new Error("供应商返回的参考图地址即将过期，尚未提交生成");
        const cacheUntil=expiresAt===undefined?now+15*60_000:Math.min(now+(input.companyPortrait?48:60)*3600_000,expiresAt-Math.min(12*3600_000,(expiresAt-now)/6));
        return {url,cacheUntil:new Date(cacheUntil)};
    };
    const bind=async(taskId:string|undefined,generation:string)=>{
        if(taskId)await db.query("INSERT INTO provider_upload_task_inputs(task_id,generation_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[taskId,generation]);
    };
    return async(input:Input)=>{
        if(!/^[a-f0-9]{64}$/.test(input.sha256)||!input.provider.apiKey.trim())throw new Error("试款参考图或供应商身份不可用");
        if(settings.APIMART_UPLOAD_CACHE_ENABLED==="false")return (await upload(input)).url;
        const {scope,spec}=cachePartition(input.provider,input.tier,settings.TRYOUT_REFERENCE_MAX_EDGE);
        const key=[input.provider.providerId,input.ownerId,scope,input.sha256,input.companyPortrait?spec+":published":spec];
        const token=randomUUID(),deadline=Date.now()+250_000;
        for(let attempt=0;;attempt++){
            const ready=(await db.query<{url:string;generation_id:string}>("SELECT url,generation_id FROM provider_upload_cache WHERE "+keyMatch+" AND url IS NOT NULL AND expires_at>now()+interval '2 minutes'",key)).rows[0];
            if(ready&&isPublicHttpsUrl(ready.url)){await bind(input.taskId,ready.generation_id);return ready.url;}
            const claim=await db.query(`INSERT INTO provider_upload_cache(${columns},lease_token,generation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$6,now()+interval '5 minutes')
                ON CONFLICT (${columns}) DO UPDATE SET url=NULL,lease_token=$6,generation_id=$6,expires_at=EXCLUDED.expires_at
                WHERE provider_upload_cache.expires_at<=now()+CASE WHEN provider_upload_cache.url IS NULL THEN interval '0 seconds' ELSE interval '2 minutes' END RETURNING generation_id`,[...key,token]);
            if(claim.rows.length){
                try{
                    const {url,cacheUntil}=await upload(input);
                    const cached=await db.query("UPDATE provider_upload_cache SET url=$7,lease_token=NULL,expires_at=$8 WHERE "+keyMatch+" AND lease_token=$6 RETURNING generation_id",[...key,token,url,cacheUntil]);
                    if(!cached.rows.length)throw new Error("试款参考图缓存写入权已变化，请重新核对");
                    await bind(input.taskId,token);return url;
                }catch(error){await db.query("DELETE FROM provider_upload_cache WHERE "+keyMatch+" AND lease_token=$6",[...key,token]).catch(()=>undefined);throw error;}
            }
            if(Date.now()>=deadline)throw new Error("试款参考图仍在上传，尚未提交生成");
            await (io.sleep??wait)(Math.min(2000,250*2**Math.min(attempt,3)));
        }
    };
}
export async function invalidateTryoutReferences(db:Pick<Database,"query">,taskId:string){
    await db.query("DELETE FROM provider_upload_cache WHERE generation_id IN (SELECT generation_id FROM provider_upload_task_inputs WHERE task_id=$1)",[taskId]);
}
export async function pruneTryoutReferences(db:Pick<Database,"query">){
    await db.query("DELETE FROM provider_upload_cache WHERE generation_id IN (SELECT generation_id FROM provider_upload_cache WHERE expires_at<now()-interval '1 hour' ORDER BY expires_at LIMIT 200)");
    await db.query("DELETE FROM provider_upload_task_inputs WHERE (task_id,generation_id) IN (SELECT i.task_id,i.generation_id FROM provider_upload_task_inputs i WHERE NOT EXISTS(SELECT 1 FROM provider_upload_cache c WHERE c.generation_id=i.generation_id) LIMIT 200)");
}
