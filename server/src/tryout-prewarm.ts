import {createHash} from "node:crypto";
import {z} from "zod";
import type {Database} from "./db";
import type {ObjectStorage} from "./object-storage";
import type {AppConfig} from "./config";
import {readSourceAssetObject} from "./asset-object-error";
import {readBoundedImage} from "./seedream55-reference";
import {resolveToolExecution} from "./tool-configuration";
import {assertModuleEnabled} from "./module-flags";
import {MARK_GPT26_IMAGE_MODELS} from "../../shared/mark-image-models";
import {decryptSecret} from "./security";
import {CanvasDocumentError} from "./canvas-document";
import {tryoutReferenceService} from "./tryout-reference";

export const prewarmInput=z.object({assetId:z.string().uuid()}).strict();
type StartOutcome="accepted"|"active"|"busy"|"disabled";
export function prewarmQueue(onError:()=>void){
    const slots=new Map<string,string>(),pending:Array<{key:string;run:()=>Promise<void>}>=[];
    let running=0;
    const drain=()=>{
        while(running<2&&pending.length){
            const job=pending.shift()!;running++;
            void Promise.resolve().then(job.run).catch(onError).finally(()=>{running--;slots.delete(job.key);drain();});
        }
    };
    return (owner:string,asset:string,run:()=>Promise<void>):StartOutcome=>{
        const key=owner+":"+asset;
        if(slots.has(key))return "active";
        if(slots.size>=16||[...slots.values()].filter(id=>id===owner).length>=6)return "busy";
        slots.set(key,owner);pending.push({key,run});drain();return "accepted";
    };
}
export function createTryoutPrewarm(db:Database,storage:ObjectStorage,config:AppConfig,io:Parameters<typeof tryoutReferenceService>[2]={}){
    const offer=prewarmQueue(()=>console.warn(JSON.stringify({event:"tryout.prewarm_unavailable"})));
    const ref=tryoutReferenceService(db,config,io);
    const owned=async(owner:string,asset:string)=>{
        const result=await db.query<{object_key:string;mime_type:string;byte_size:number;content_sha256:string|null}>("SELECT object_key,mime_type,byte_size::int,content_sha256 FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL",[asset,owner]);
        const source=result.rows[0];
        if(!source)throw new CanvasDocumentError("TRYOUT_ASSET_UNAVAILABLE","参考图不存在或不属于当前员工",404);
        if(source.byte_size<1||source.byte_size>20*1024*1024)throw new CanvasDocumentError("TRYOUT_REFERENCE_SIZE","试款原图应为 20 MiB 以内的图片");
        return source;
    };
    return async(owner:string,asset:string):Promise<StartOutcome>=>{
        await owned(owner,asset);
        if(config.APIMART_UPLOAD_CACHE_ENABLED==="false")return "disabled";
        return offer(owner,asset,async()=>{
            await assertModuleEnabled(db,"canvas-tryout");
            await assertModuleEnabled(db,"canvas-edit");
            const source=await owned(owner,asset);
            const execution=await resolveToolExecution(db,{operationType:"inpaint",toolKey:"canvas-edit"});
            const p=(await db.query("SELECT m.model_id,p.id,p.base_url,p.encrypted_credentials FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1 AND m.enabled AND p.enabled AND p.protocol='apimart' AND m.workflow_config_id IS NULL",[execution.modelConfigId])).rows[0];
            if(!p?.encrypted_credentials||!config.PROVIDER_ENCRYPTION_KEY||!MARK_GPT26_IMAGE_MODELS.some(m=>m.modelId===p.model_id))return;
            const {apiKey}=JSON.parse(decryptSecret(p.encrypted_credentials,config.PROVIDER_ENCRYPTION_KEY));
            if(typeof apiKey!=="string"||!apiKey)return;
            const read=async()=>{
                const obj=await readSourceAssetObject(storage,source.object_key);
                return {bytes:await readBoundedImage(obj.Body!.transformToWebStream(),20*1024*1024,source.byte_size),mimeType:source.mime_type};
            };
            const original=source.content_sha256?undefined:await read();
            await ref({ownerId:owner,provider:{providerId:p.id,baseUrl:p.base_url,apiKey},tier:"quick",sha256:source.content_sha256??createHash("sha256").update(original!.bytes).digest("hex"),read:original?async()=>original:read});
        });
    };
}
