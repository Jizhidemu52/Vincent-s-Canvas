import { createHash } from "node:crypto";
import { Router } from "express";
import { MARK_GPT26_IMAGE_MODELS } from "../../../shared/mark-image-models";
import { refineTryout,tryoutSubmission,type TryoutSubmission } from "../../../shared/tryout-submission";
import { colorPrompt,materialPrompt,wearPrompt,tryoutImageOptions } from "../../../shared/tryout-prompts";
import { assertCanvasOwner } from "../canvas-document";
import { withTransaction } from "../db-transaction";
import type { Database,Cache } from "../db";
import { assertModuleEnabled } from "../module-flags";
import { resolveToolExecution } from "../tool-configuration";
import { BillingError,prepareTaskEnqueue,enqueueTaskInTransaction,publishEnqueuedTask } from "../tasks";
import type { AuthenticatedRequest } from "../types";
import {prewarmInput,type createTryoutPrewarm} from "../tryout-prewarm";

import {tryoutProductItems} from "../product-card-service";
import {closestProductPart} from "../../../shared/product-card-region";
import type {ProductCardItem} from "../../../shared/product-card";
import {resolvePortrait,lockPreset} from "../model-library";
type Policy={credits:()=>Promise<boolean>;maxInflightTasks:number;maxPausedTasks:number;productCards?:boolean};
async function assertTryoutImageModel(db:Pick<Database,"query">,id:string,lock=false){
    const model=(await db.query(`SELECT m.model_id,p.protocol,m.workflow_config_id FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1 AND m.enabled AND p.enabled`+(lock?" FOR SHARE OF m,p":""),[id])).rows[0];
    if(model?.protocol!=="apimart"||model.workflow_config_id||!MARK_GPT26_IMAGE_MODELS.some(m=>m.modelId===model.model_id))throw new BillingError("TRYOUT_MODEL_UNAVAILABLE","当前画布改图模型未验证支持试款参数，未提交任务");
}
async function recipe(input:TryoutSubmission,db:Pick<Database,"query">,ownerId:string,items:Map<string,ProductCardItem|null>,locked=false):Promise<{prompt:string;ids:string[];presetId?:string;child?:"boys"|"girls"}> {
    const item=input.kind==="wear"?null:items.get(input.sourceAssetId)??null;
    const part=input.kind==="wear"?null:input.part??closestProductPart(item,input.fallbackHex);
    if(input.kind==="color")return {prompt:colorPrompt(item,part,input.color,input.fallbackHex),ids:[input.sourceAssetId]};
    if(input.kind==="material"){
        if("presetId" in input.material){
            const preset=(await db.query<{name:string;description:string}>("SELECT name,description FROM material_presets WHERE id=$1 AND status='published'"+(locked?" FOR SHARE":""),[input.material.presetId])).rows[0];
            if(!preset)throw new BillingError("TRYOUT_MATERIAL_UNAVAILABLE","该预设材质已下架或不存在，未提交任务");
            return {prompt:materialPrompt(item,part,{type:"preset",...preset},input.fallbackHex),ids:[input.sourceAssetId]};
        }
        const material=(await db.query("SELECT metadata FROM assets WHERE id=$1 AND owner_user_id=$2 AND metadata->>'source'='material-library' AND COALESCE(metadata->>'tryoutArchived','false')<>'true' AND kind='image' AND status='ready' AND deleted_at IS NULL"+(locked?" FOR SHARE":""),[input.material.assetId,ownerId])).rows[0];
        if(!material)throw new BillingError("TRYOUT_MATERIAL_UNAVAILABLE","该个人材质已移除或不属于当前账号");
        return {prompt:materialPrompt(item,part,{type:"uploaded",name:material.metadata.name,useColor:material.metadata.useColor===true},input.fallbackHex),ids:[input.sourceAssetId,input.material.assetId]};
    }
    const products=input.productAssetIds.map(id=>items.get(id)??null);
    if(products.some(p=>p?.wearPosition==="none"))throw new BillingError("TRYOUT_NOT_WEARABLE","这件产品不适合上身，可使用场景展示或修正产品卡");
    const portrait=await resolvePortrait(db,ownerId,input.model,products[0]??null);
    return {prompt:wearPrompt(products),ids:[portrait.assetId,...input.productAssetIds],...(portrait.presetId?{presetId:portrait.presetId}:{}),...(products[0]?.audience==="kids"&&(portrait.audience==="boys"||portrait.audience==="girls")?{child:portrait.audience}:{})};
}
export function createTryoutRouter(db:Database,cache:Cache,policy:Policy,prewarm?:ReturnType<typeof createTryoutPrewarm>) {
    const router=Router();
    router.post("/prewarm",async(req,res,next)=>{
        try{
            const actor=(req as AuthenticatedRequest).auth;
            assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
            await assertModuleEnabled(db,"canvas-tryout");await assertModuleEnabled(db,"canvas-edit");
            const {assetId,presetId}=prewarmInput.parse(req.body);
            if(!prewarm){res.status(503).json({message:"预热服务未配置"});return;}
            const status=await prewarm(actor.id,assetId,presetId);
            if(status==="busy")res.setHeader("Retry-After","5");
            res.status(status==="busy"?429:202).json({status});
        }catch(error){next(error);}
    });
    router.post("/quick",async(req,res,next)=>{
        try{
            const actor=(req as AuthenticatedRequest).auth;
            assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
            await assertModuleEnabled(db,"canvas-tryout");
            const input=req.body?.kind==="refine"?refineTryout.parse(req.body):tryoutSubmission.parse(req.body);
            const requestId="tryout:"+actor.id+":"+(input.kind==="refine"?"hd:"+input.sourceTaskId:input.requestId);
            const signature=createHash("sha256").update(JSON.stringify(input)).digest("hex");
            const read=async(query:Pick<Database,"query">)=>{
                const row=(await query.query<{id:string;prompt:string;signature:string}>(`SELECT id,prompt,parameters->>'tryoutSignature' AS signature FROM tasks WHERE user_id=$1 AND request_id=$2`,[actor.id,requestId])).rows[0];
                if(row && row.signature!==signature)throw new BillingError("TRYOUT_REQUEST_CHANGED","该操作编号已用于不同的试款，不会重复提交");
                return row;
            };
            const prior=await read(db);
            if(prior){res.json({taskId:prior.id,prompt:prior.prompt});return;}
            const items=await tryoutProductItems(db,actor.id,input.kind==="refine"?[]:input.kind==="wear"?input.productAssetIds:[input.sourceAssetId],policy.productCards!==false);
            const original=async(query:Pick<Database,"query">,locked=false)=>{
                if(input.kind!=="refine")return {...await recipe(input,query,actor.id,items,locked),kind:input.kind,tier:input.tier};
                const row=(await query.query(`SELECT prompt,source_urls,parameters->>'tryoutKind' AS kind,parameters->>'tryoutPresetId' AS preset FROM tasks
                    WHERE id=$1 AND user_id=$2 AND project_id=$3 AND parameters->>'tryoutNodeId'=$4 AND status='success'
                    AND parameters->>'tryoutTier'='quick' AND request_id LIKE $5`+(locked?" FOR SHARE":""),[input.sourceTaskId,actor.id,input.canvasId,input.nodeId,"tryout:"+actor.id+":%"])).rows[0];
                if(!row||!["color","material","wear"].includes(row.kind)||!Array.isArray(row.source_urls)||!row.source_urls.length)throw new BillingError("TRYOUT_ORIGIN_UNAVAILABLE","只能为这张画布上已成功的快速档结果出高清");
                const ids:string[]=row.source_urls.map((url:string)=>{const id=/^\/api\/assets\/([0-9a-f-]{36})\/content$/i.exec(url)?.[1];if(!id)throw new BillingError("TRYOUT_REFERENCES","快速档原始参考图不可用");return id;});
                return {prompt:row.prompt as string,ids,kind:row.kind as TryoutSubmission["kind"],tier:"hd" as const,presetId:typeof row.preset==="string"?row.preset:undefined,child:undefined};
            };
            const spec=await original(db),{prompt,ids}=spec,unique=[...new Set(ids)].sort();
            if(unique.length!==ids.length)throw new BillingError("TRYOUT_REFERENCES","请使用不同的产品、模特或材质图");
            const execution=await resolveToolExecution(db,{operationType:"inpaint",toolKey:"canvas-edit"});
            await assertTryoutImageModel(db,execution.modelConfigId);
            const prepared=await prepareTaskEnqueue(db,{requestId,userId:actor.id,departmentId:actor.departmentId,projectId:input.canvasId,
                operationType:"inpaint",toolKey:"canvas-edit",modelConfigId:execution.modelConfigId,prompt,optimized:false,priority:"priority",
                sourceUrls:ids.map(id=>"/api/assets/"+id+"/content"),parameters:{tool:"canvas-edit",...tryoutImageOptions(spec.kind,spec.tier),tryoutKind:spec.kind,tryoutTier:spec.tier,tryoutNodeId:input.nodeId,tryoutSignature:signature,...(spec.presetId?{tryoutPresetId:spec.presetId}:{}),...(input.kind==="refine"?{tryoutQuickTaskId:input.sourceTaskId}:{})},
                creditsEnabled:await policy.credits(),maxInflightTasks:policy.maxInflightTasks,maxPausedTasks:policy.maxPausedTasks});
            const result=await withTransaction(db,async client=>{
                await client.query("SELECT module_key FROM module_flags WHERE module_key=ANY($1::text[]) ORDER BY module_key FOR SHARE",[["canvas","canvas-tryout","canvas-edit"]]);
                await assertModuleEnabled(client,"canvas-tryout");
                await assertModuleEnabled(client,"canvas-edit");
                if(prepared.execution && prepared.execution.modelConfigId!==execution.modelConfigId)throw new BillingError("TRYOUT_MODEL_CHANGED","模型绑定已变更，未提交任务");
                await assertTryoutImageModel(client,execution.modelConfigId,true);
                if(input.kind==="material"&&(await recipe(input,client,actor.id,items,true)).prompt!==prompt)throw new BillingError("TRYOUT_MATERIAL_CHANGED","材质描述已变更，请重新选择后再提交");
                if(input.kind==="refine"&&JSON.stringify(await original(client,true))!==JSON.stringify(spec))throw new BillingError("TRYOUT_ORIGIN_CHANGED","快速档原始记录已变化，未提交高清任务");
                const canvas=await client.query("SELECT 1 FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2 AND NOT deleted FOR SHARE",[actor.id,input.canvasId]);
                if(!canvas.rows.length)throw new BillingError("TRYOUT_CANVAS_UNAVAILABLE","请先保存到自己的画布");
                if(spec.presetId)await lockPreset(client,spec.presetId,ids[0]!);
                const personal=spec.presetId?unique.filter(id=>id!==ids[0]):unique;
                const assets=await client.query("SELECT id FROM assets WHERE id=ANY($1::uuid[]) AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL AND COALESCE(metadata->>'tryoutArchived','false')<>'true' ORDER BY id FOR SHARE",[personal,actor.id]);
                if(assets.rows.length!==personal.length)throw new BillingError("TRYOUT_ASSET_UNAVAILABLE","参考图尚未保存或不属于当前账号");
                const task=await enqueueTaskInTransaction(client,prepared);
                if(spec.child)await client.query("INSERT INTO user_model_defaults(user_id,last_child) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET last_child=EXCLUDED.last_child,updated_at=now()",[actor.id,spec.child]);
                await read(client);
                return task;
            });
            await publishEnqueuedTask(cache,result);
            res.status(201).json({taskId:result.task.id,prompt});
        }catch(error){next(error);}
    });
    return router;
}
