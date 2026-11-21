import { createHash } from "node:crypto";
import { Router } from "express";
import { MARK_GPT26_IMAGE_MODELS } from "../../../shared/mark-image-models";
import { tryoutSubmission,type TryoutSubmission } from "../../../shared/tryout-submission";
import { colorPrompt,materialPrompt,wearPrompt,tryoutImageOptions } from "../../../shared/tryout-prompts";
import { assertCanvasOwner } from "../canvas-document";
import { withTransaction } from "../db-transaction";
import type { Database,Cache } from "../db";
import { assertModuleEnabled } from "../module-flags";
import { resolveToolExecution } from "../tool-configuration";
import { BillingError,prepareTaskEnqueue,enqueueTaskInTransaction,publishEnqueuedTask } from "../tasks";
import type { AuthenticatedRequest } from "../types";

type Policy={credits:()=>Promise<boolean>;maxInflightTasks:number;maxPausedTasks:number};
async function assertTryoutImageModel(db:Pick<Database,"query">,id:string,lock=false){
    const model=(await db.query(`SELECT m.model_id,p.protocol,m.workflow_config_id FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1 AND m.enabled AND p.enabled`+(lock?" FOR SHARE OF m,p":""),[id])).rows[0];
    if(model?.protocol!=="apimart"||model.workflow_config_id||!MARK_GPT26_IMAGE_MODELS.some(m=>m.modelId===model.model_id))throw new BillingError("TRYOUT_MODEL_UNAVAILABLE","当前画布改图模型未验证支持试款参数，未提交任务");
}
async function recipe(input:TryoutSubmission,db:Pick<Database,"query">,ownerId:string,locked=false) {
    if(input.kind==="color")return {prompt:colorPrompt(null,input.part??null,input.color,input.fallbackHex),ids:[input.sourceAssetId]};
    if(input.kind==="material"){
        if("presetId" in input.material){
            const preset=(await db.query<{name:string;description:string}>("SELECT name,description FROM material_presets WHERE id=$1 AND status='published'"+(locked?" FOR SHARE":""),[input.material.presetId])).rows[0];
            if(!preset)throw new BillingError("TRYOUT_MATERIAL_UNAVAILABLE","该预设材质已下架或不存在，未提交任务");
            return {prompt:materialPrompt(null,input.part??null,{type:"preset",...preset}),ids:[input.sourceAssetId]};
        }
        const material=(await db.query("SELECT metadata FROM assets WHERE id=$1 AND owner_user_id=$2 AND metadata->>'source'='material-library' AND COALESCE(metadata->>'tryoutArchived','false')<>'true' AND kind='image' AND status='ready' AND deleted_at IS NULL"+(locked?" FOR SHARE":""),[input.material.assetId,ownerId])).rows[0];
        if(!material)throw new BillingError("TRYOUT_MATERIAL_UNAVAILABLE","该个人材质已移除或不属于当前账号");
        return {prompt:materialPrompt(null,input.part??null,{type:"uploaded",name:material.metadata.name,useColor:material.metadata.useColor===true}),ids:[input.sourceAssetId,input.material.assetId]};
    }
    return {prompt:wearPrompt(input.productAssetIds.map(()=>null)),ids:[input.model.assetId,...input.productAssetIds]};
}
export function createTryoutRouter(db:Database,cache:Cache,policy:Policy) {
    const router=Router();
    router.post("/quick",async(req,res,next)=>{
        try{
            const actor=(req as AuthenticatedRequest).auth;
            assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
            await assertModuleEnabled(db,"canvas-tryout");
            const input=tryoutSubmission.parse(req.body);
            const requestId="tryout:"+actor.id+":"+input.requestId;
            const signature=createHash("sha256").update(JSON.stringify(input)).digest("hex");
            const read=async(query:Pick<Database,"query">)=>{
                const row=(await query.query<{id:string;prompt:string;signature:string}>(`SELECT id,prompt,parameters->>'tryoutSignature' AS signature FROM tasks WHERE user_id=$1 AND request_id=$2`,[actor.id,requestId])).rows[0];
                if(row && row.signature!==signature)throw new BillingError("TRYOUT_REQUEST_CHANGED","该操作编号已用于不同的试款，不会重复提交");
                return row;
            };
            const prior=await read(db);
            if(prior){res.json({taskId:prior.id,prompt:prior.prompt});return;}
            const {prompt,ids}=await recipe(input,db,actor.id),unique=[...new Set(ids)].sort();
            if(unique.length!==ids.length)throw new BillingError("TRYOUT_REFERENCES","请使用不同的产品、模特或材质图");
            const execution=await resolveToolExecution(db,{operationType:"inpaint",toolKey:"canvas-edit"});
            await assertTryoutImageModel(db,execution.modelConfigId);
            const prepared=await prepareTaskEnqueue(db,{requestId,userId:actor.id,departmentId:actor.departmentId,projectId:input.canvasId,
                operationType:"inpaint",toolKey:"canvas-edit",modelConfigId:execution.modelConfigId,prompt,optimized:false,priority:"priority",
                sourceUrls:ids.map(id=>"/api/assets/"+id+"/content"),parameters:{tool:"canvas-edit",...tryoutImageOptions(input.kind,input.tier),tryoutKind:input.kind,tryoutTier:input.tier,tryoutNodeId:input.nodeId,tryoutSignature:signature},
                creditsEnabled:await policy.credits(),maxInflightTasks:policy.maxInflightTasks,maxPausedTasks:policy.maxPausedTasks});
            const result=await withTransaction(db,async client=>{
                await client.query("SELECT module_key FROM module_flags WHERE module_key=ANY($1::text[]) ORDER BY module_key FOR SHARE",[["canvas","canvas-tryout","canvas-edit"]]);
                await assertModuleEnabled(client,"canvas-tryout");
                await assertModuleEnabled(client,"canvas-edit");
                if(prepared.execution && prepared.execution.modelConfigId!==execution.modelConfigId)throw new BillingError("TRYOUT_MODEL_CHANGED","模型绑定已变更，未提交任务");
                await assertTryoutImageModel(client,execution.modelConfigId,true);
                if(input.kind==="material"&&(await recipe(input,client,actor.id,true)).prompt!==prompt)throw new BillingError("TRYOUT_MATERIAL_CHANGED","材质描述已变更，请重新选择后再提交");
                const canvas=await client.query("SELECT 1 FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2 AND NOT deleted FOR SHARE",[actor.id,input.canvasId]);
                if(!canvas.rows.length)throw new BillingError("TRYOUT_CANVAS_UNAVAILABLE","请先保存到自己的画布");
                const assets=await client.query("SELECT id FROM assets WHERE id=ANY($1::uuid[]) AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL ORDER BY id FOR SHARE",[unique,actor.id]);
                if(assets.rows.length!==unique.length)throw new BillingError("TRYOUT_ASSET_UNAVAILABLE","参考图尚未保存或不属于当前账号");
                const task=await enqueueTaskInTransaction(client,prepared);
                await read(client);
                return task;
            });
            await publishEnqueuedTask(cache,result);
            res.status(201).json({taskId:result.task.id,prompt});
        }catch(error){next(error);}
    });
    return router;
}
