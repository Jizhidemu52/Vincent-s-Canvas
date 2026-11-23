import { createHash } from "node:crypto";
import { Router } from "express";
import { outfitTryout,refineTryout,tryoutSubmission,tryoutBatch,TRYOUT_BATCH_MAX,type TryoutSubmission } from "../../../shared/tryout-submission";
import {outfitRecipe} from "../tryout-outfit";
import {readTryoutPreview} from "../tryout-result-preview";
import {firstDisplay,noteFirstDisplay} from "../tryout-speed";
import {z} from "zod";
import { colorPrompt,materialEdit,wearPrompt,tryoutImageOptions } from "../../../shared/tryout-prompts";
import { assertCanvasOwner,CanvasDocumentError } from "../canvas-document";
import { withTransaction } from "../db-transaction";
import type { Database,Cache } from "../db";
import { assertModuleEnabled,ModuleDisabledError } from "../module-flags";
import {ToolConfigurationError} from "../tool-configuration";
import {resolveTryoutBinding} from "../tryout-model-bindings";
import { BillingError,prepareTaskEnqueue,enqueueTaskInTransaction,publishEnqueuedTask,lockTaskAdmission } from "../tasks";
import type { AuthenticatedRequest } from "../types";
import {prewarmInput,type createTryoutPrewarm} from "../tryout-prewarm";

import {tryoutProductItems} from "../product-card-service";
import {closestProductPart} from "../../../shared/product-card-region";
import type {ProductCardItem} from "../../../shared/product-card";
import {fabricPhotoAccess} from "../tryout-private-assets";
import {resolvePortrait,lockPreset} from "../model-library";
type Policy={credits:()=>Promise<boolean>;maxInflightTasks:number;maxPausedTasks:number;productCards?:boolean;displayBeforeSave?:boolean};
async function recipe(input:TryoutSubmission,db:Pick<Database,"query">,ownerId:string,items:Map<string,ProductCardItem|null>,locked=false):Promise<{prompt:string;ids:string[];model?:{name:string;presetId?:string;assetId?:string};presetId?:string;child?:"boys"|"girls"}> {
    const item=input.kind==="wear"?null:items.get(input.sourceAssetId)??null;
    const part=input.kind==="wear"?null:input.part??closestProductPart(item,input.fallbackHex);
    if(input.kind==="color")return {prompt:colorPrompt(item,part,input.color,input.fallbackHex),ids:[input.sourceAssetId]};
    if(input.kind==="material"){
        if("presetId" in input.material){
            const preset=(await db.query<{name:string;description:string;photo:string|null}>("SELECT name,description,thumb_asset_id AS photo FROM material_presets WHERE id=$1 AND status='published'"+(locked?" FOR SHARE":""),[input.material.presetId])).rows[0];
            if(!preset)throw new BillingError("TRYOUT_MATERIAL_UNAVAILABLE","该预设材质已下架或不存在，未提交任务");
            if(!preset.photo)return materialEdit(input.sourceAssetId,item,part,{type:"text",name:preset.name,description:preset.description},input.fallbackHex);
            return {...materialEdit(input.sourceAssetId,item,part,{type:"photo",assetId:preset.photo,description:preset.description},input.fallbackHex),presetId:input.material.presetId};
        }
        const material=(await db.query("SELECT metadata,COALESCE(metadata->>'description',metadata#>>'{curatorAnalysis,description}') AS description FROM assets WHERE id=$1 AND owner_user_id=$2 AND metadata->>'source'='material-library' AND COALESCE(metadata->>'tryoutArchived','false')<>'true' AND kind='image' AND status='ready' AND deleted_at IS NULL"+(locked?" FOR SHARE":""),[input.material.assetId,ownerId])).rows[0];
        if(!material)throw new BillingError("TRYOUT_MATERIAL_UNAVAILABLE","该个人材质已移除或不属于当前账号");
        const description=material.description?.slice(0,600);
        return materialEdit(input.sourceAssetId,item,part,{type:"photo",assetId:input.material.assetId,description,useColor:material.metadata.useColor===true},input.fallbackHex);
    }
    const products=input.productAssetIds.map(id=>items.get(id)??null);
    if(products.some(p=>p?.wearPosition==="none"))throw new BillingError("TRYOUT_NOT_WEARABLE","这件产品不适合上身，可使用场景展示或修正产品卡");
    const portrait=await resolvePortrait(db,ownerId,input.model,products[0]??null);
    return {prompt:wearPrompt(products),ids:[portrait.assetId,...input.productAssetIds],model:{name:portrait.name,...(portrait.presetId?{presetId:portrait.presetId}:{assetId:portrait.assetId})},...(portrait.presetId?{presetId:portrait.presetId}:{}),...(products[0]?.audience==="kids"&&(portrait.audience==="boys"||portrait.audience==="girls")?{child:portrait.audience}:{})};
}
export function createTryoutRouter(db:Database,cache:Cache,policy:Policy,prewarm?:ReturnType<typeof createTryoutPrewarm>) {
    const router=Router();
    router.post("/results/:id/display",async(req,res,next)=>{try{
        const owner=(req as unknown as AuthenticatedRequest).auth.id;
        assertCanvasOwner(req.headers["x-canvas-owner-id"],owner);
        await noteFirstDisplay(db,owner,z.string().uuid().parse(req.params.id),firstDisplay.parse(req.body));
        res.status(204).end();
    }catch(e){next(e);}});
    router.get("/results/:id/preview",async(req,res,next)=>{try{
        const owner=(req as unknown as AuthenticatedRequest).auth.id;
        assertCanvasOwner(req.headers["x-canvas-owner-id"],owner);
        res.set({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});
        if(!policy.displayBeforeSave){res.sendStatus(204);return;}
        await assertModuleEnabled(db,"canvas-tryout");
        const id=z.string().uuid().parse(req.params.id),preview=await readTryoutPreview(db,cache,owner,id);
        if(!preview){res.sendStatus(204);return;}
        res.set("X-Tryout-Save-State",preview.saving).type("image/webp").send(preview.bytes);
    }catch(e){next(e);}});
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
    const admit=async(actor:AuthenticatedRequest["auth"],input:TryoutSubmission|ReturnType<typeof refineTryout.parse>|ReturnType<typeof outfitTryout.parse>)=>{
            const requestId="tryout:"+actor.id+":"+(input.kind==="refine"?"hd:"+input.sourceTaskId:input.requestId);
            const signature=createHash("sha256").update(JSON.stringify(input)).digest("hex");
            const read=async(query:Pick<Database,"query">)=>{
                const row=(await query.query<{id:string;prompt:string;signature:string;model:{name:string;presetId?:string;assetId?:string}|null}>(`SELECT id,prompt,parameters->'tryoutModel' AS model,parameters->>'tryoutSignature' AS signature FROM tasks WHERE user_id=$1 AND request_id=$2`,[actor.id,requestId])).rows[0];
                if(row && row.signature!==signature)throw new BillingError("TRYOUT_REQUEST_CHANGED","该操作编号已用于不同的试款，不会重复提交");
                return row;
            };
            const prior=await read(db);
            if(prior)return {created:false,receipt:{taskId:prior.id,prompt:prior.prompt,...(prior.model?{model:prior.model}:{})}};
            const items=await tryoutProductItems(db,actor.id,input.kind==="refine"||input.kind==="outfit"?[]:input.kind==="wear"?input.productAssetIds:[input.sourceAssetId],policy.productCards!==false);
            const original=async(query:Pick<Database,"query">,locked=false)=>{
                if(input.kind==="outfit")return outfitRecipe(query,actor.id,input,policy.productCards!==false,locked);
                if(input.kind!=="refine")return {...await recipe(input,query,actor.id,items,locked),kind:input.kind,tier:input.tier};
                const row=(await query.query(`SELECT prompt,source_urls,parameters->>'tryoutKind' AS kind,parameters->'tryoutModel' AS model,parameters->>'tryoutPresetId' AS preset FROM tasks
                    WHERE id=$1 AND user_id=$2 AND project_id=$3 AND parameters->>'tryoutNodeId'=$4 AND status='success'
                    AND parameters->>'tryoutTier'='quick' AND request_id LIKE $5`+(locked?" FOR SHARE":""),[input.sourceTaskId,actor.id,input.canvasId,input.nodeId,"tryout:"+actor.id+":%"])).rows[0];
                if(!row||!["color","material","wear"].includes(row.kind)||!Array.isArray(row.source_urls)||!row.source_urls.length)throw new BillingError("TRYOUT_ORIGIN_UNAVAILABLE","只能为这张画布上已成功的快速档结果出高清");
                const ids:string[]=row.source_urls.map((url:string)=>{const id=/^\/api\/assets\/([0-9a-f-]{36})\/content$/i.exec(url)?.[1];if(!id)throw new BillingError("TRYOUT_REFERENCES","快速档原始参考图不可用");return id;});
                return {prompt:row.prompt as string,ids,kind:row.kind as TryoutSubmission["kind"],tier:"hd" as const,model:row.model??undefined,presetId:typeof row.preset==="string"?row.preset:undefined,child:undefined};
            };
            const spec=await original(db),{prompt,ids}=spec,unique=[...new Set(ids)].sort();
            if(unique.length!==ids.length)throw new BillingError("TRYOUT_REFERENCES","请使用不同的产品、模特或材质图");
            const selected=await resolveTryoutBinding(db,spec.tier),{execution}=selected;
            const prepared=await prepareTaskEnqueue(db,{requestId,userId:actor.id,departmentId:actor.departmentId,projectId:input.canvasId,
                operationType:"inpaint",toolKey:"canvas-edit",toolConfiguration:execution,modelConfigId:execution.modelConfigId,prompt,optimized:false,priority:"priority",
                sourceUrls:ids.map(id=>"/api/assets/"+id+"/content"),parameters:{tool:"canvas-edit",...tryoutImageOptions(spec.kind,spec.tier),tryoutKind:spec.kind,tryoutTier:spec.tier,tryoutNodeId:input.nodeId,tryoutSignature:signature,...(spec.model?{tryoutModel:spec.model}:{}),...(spec.presetId?{tryoutPresetId:spec.presetId}:{}),...(input.kind==="refine"?{tryoutQuickTaskId:input.sourceTaskId}:{})},
                creditsEnabled:await policy.credits(),maxInflightTasks:policy.maxInflightTasks,maxPausedTasks:policy.maxPausedTasks});
            const result=await withTransaction(db,async client=>{
                await lockTaskAdmission(client,actor.id);
                if(spec.tier==="quick"&&!await read(client)){
                    const inFlight=await client.query<{n:number}>("SELECT count(*)::int AS n FROM tasks WHERE user_id=$1 AND status IN ('waiting','processing') AND request_id LIKE $2 AND parameters->>'tryoutTier'='quick'",[actor.id,"tryout:"+actor.id+":%"]);
                    if(inFlight.rows[0]!.n>=TRYOUT_BATCH_MAX)throw new BillingError("TRYOUT_QUICK_LIMIT","已有 12 款正在试款，等一款完成或取消排队后再试");
                }
                await client.query("SELECT module_key FROM module_flags WHERE module_key=ANY($1::text[]) ORDER BY module_key FOR SHARE",[["canvas","canvas-tryout","canvas-edit"]]);
                await assertModuleEnabled(client,"canvas-tryout");
                await assertModuleEnabled(client,"canvas-edit");
                if(prepared.execution && prepared.execution.modelConfigId!==execution.modelConfigId)throw new BillingError("TRYOUT_MODEL_CHANGED","模型绑定已变更，未提交任务");
                const latest=await resolveTryoutBinding(client,spec.tier,true);
                if(latest.binding.revision!==selected.binding.revision||latest.execution.modelConfigId!==execution.modelConfigId||latest.execution.configurationVersion!==execution.configurationVersion)throw new BillingError("TRYOUT_MODEL_CHANGED","试款模型或价格已变更，本次未扣费");
                if(input.kind==="material"&&JSON.stringify(await original(client,true))!==JSON.stringify(spec))throw new BillingError("TRYOUT_MATERIAL_CHANGED","材质描述已变更，请重新选择后再提交");
                if((input.kind==="refine"||input.kind==="outfit")&&JSON.stringify(await original(client,true))!==JSON.stringify(spec))throw new BillingError("TRYOUT_ORIGIN_CHANGED","原始参考记录已变化，未提交新任务");
                const canvas=await client.query("SELECT 1 FROM canvas_documents WHERE owner_user_id=$1 AND external_id=$2 AND NOT deleted FOR SHARE",[actor.id,input.canvasId]);
                if(!canvas.rows.length)throw new BillingError("TRYOUT_CANVAS_UNAVAILABLE","请先保存到自己的画布");
                if(spec.presetId && spec.kind==="wear")await lockPreset(client,spec.presetId,ids[0]!);
                if(spec.presetId && spec.kind==="material" && !(await client.query("SELECT a.id FROM assets a JOIN material_presets p ON p.thumb_asset_id=a.id AND p.id=$2 AND p.status='published' WHERE a.id=$1 AND "+fabricPhotoAccess+" FOR SHARE OF p,a",[ids[1],spec.presetId])).rows.length)throw new BillingError("TRYOUT_MATERIAL_UNAVAILABLE","该预设面料图已更换或下架，未提交任务");
                const personal=spec.presetId?unique.filter(id=>id!==ids[spec.kind==="material"?1:0]):unique;
                const assets=await client.query("SELECT id FROM assets WHERE id=ANY($1::uuid[]) AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL AND COALESCE(metadata->>'tryoutArchived','false')<>'true' ORDER BY id FOR SHARE",[personal,actor.id]);
                if(assets.rows.length!==personal.length)throw new BillingError("TRYOUT_ASSET_UNAVAILABLE","参考图尚未保存或不属于当前账号");
                const task=await enqueueTaskInTransaction(client,prepared);
                if(spec.child)await client.query("INSERT INTO user_model_defaults(user_id,last_child) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET last_child=EXCLUDED.last_child,updated_at=now()",[actor.id,spec.child]);
                await read(client);
                return task;
            });
            await publishEnqueuedTask(cache,result);
            return {created:true,receipt:{taskId:result.task.id,prompt,...(spec.model?{model:spec.model}:{})}};
    };
    for(const batch of [false,true])router.post(batch?"/quick/batch":"/quick",async(req,res,next)=>{
        try{
            const actor=(req as AuthenticatedRequest).auth;
            assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
            await assertModuleEnabled(db,"canvas-tryout");
            if(!batch){
                const schema=req.body?.kind==="refine"?refineTryout:req.body?.kind==="outfit"?outfitTryout:tryoutSubmission;
                const result=await admit(actor,schema.parse(req.body));
                res.status(result.created?201:200).json(result.receipt);return;
            }
            const {items}=tryoutBatch.parse(req.body),tasks=[];
            for(const item of items){
                try{tasks.push({requestId:item.requestId,...(await admit(actor,item)).receipt});}
                catch(error){
                    if(!(error instanceof BillingError||error instanceof CanvasDocumentError||error instanceof ToolConfigurationError||error instanceof ModuleDisabledError))throw new CanvasDocumentError("TRYOUT_BATCH_UNCERTAIN","未能确认整组受理情况，请按原任务核对进度，不要重复提交",503);
                    tasks.push({requestId:item.requestId,error:{code:error.code,message:error.message}});
                }
            }
            res.json({tasks});
        }catch(error){next(error);}
    });
    return router;
}
