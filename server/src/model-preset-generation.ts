import {createHash} from "node:crypto";
import {z} from "zod";
import {modelFramings,modelIdentities} from "../../shared/model-match";
import {portraitPrompt,slotKey,type PortraitSlot} from "../../shared/model-portrait-recipe";
import type {Database,Cache} from "./db";
import {withTransaction} from "./db-transaction";
import {CanvasDocumentError} from "./canvas-document";
import {resolveTryoutBinding} from "./tryout-model-bindings";
import {resolveToolExecution} from "./tool-configuration";
import {enqueueTaskInTransaction,lockTaskAdmission,prepareTaskEnqueue,publishEnqueuedTask,PRESET_GENERATION} from "./tasks";
import {writeAudit} from "./audit";
import type {SessionUser} from "./types";

type Query=Pick<Database,"query">;
export type PortraitPolicy={cache:Cache;credits:()=>Promise<boolean>;maxInflightTasks:number;maxPausedTasks:number};
const id=z.string().uuid(),slotSchema=z.strictObject({identity:z.enum(["white-woman","white-man","white-girl","white-boy"]),framing:z.enum(modelFramings),expectedAssetId:id.nullable(),fullAssetId:id.nullable()});
export const portraitOrder=z.strictObject({requestId:id,confirmedCount:z.number().int().min(1).max(12),slots:z.array(slotSchema).min(1).max(12)}).refine(({confirmedCount,slots})=>
    confirmedCount===slots.length&&new Set(slots.map(slotKey)).size===slots.length&&slots.every(s=>s.framing==="full"?s.fullAssetId===null:!!s.fullAssetId&&!slots.some(other=>other.identity===s.identity&&other.framing==="full")));
const conflict=(message:string)=>new CanvasDocumentError("MODEL_GENERATION_CHANGED",message,409);
const prefix="preset-gen:";
async function lockGroup(db:Query,identity:string){await db.query("SELECT pg_advisory_xact_lock(hashtext('tryout-model:'||$1))",[identity]);}
async function target(db:Query,s:PortraitSlot){
    const row=(await db.query("SELECT status,asset_id,draft_asset_id FROM model_presets WHERE identity=$1 AND framing=$2 FOR UPDATE",[s.identity,s.framing])).rows[0];
    return {asset:(row?.draft_asset_id??row?.asset_id??null) as string|null,stamp:row?[row.status,row.asset_id,row.draft_asset_id].join(":"):"empty"};
}
type Running={id:string;request_id:string;user_id:string;source_urls:string[];parameters:Record<string,unknown>};
export async function portraitSourceOwner(db:Query,t:Running){
    const s=slotSchema.parse(t.parameters.portraitSlot);
    if(!t.request_id.startsWith(prefix+t.user_id+":")||t.source_urls.length!==(s.fullAssetId?1:0)||s.fullAssetId&&t.source_urls[0]!=="/api/assets/"+s.fullAssetId+"/content")throw conflict("模特参考回执不匹配，未提交");
    const admin=await db.query("SELECT 1 FROM users WHERE id=$1 AND role='super_admin' AND status='active'",[t.user_id]);
    if(!admin.rows.length)throw conflict("模特库管理员权限已改变，未提交");
    if(!s.fullAssetId)return t.user_id;
    const row=(await db.query(`SELECT a.owner_user_id FROM model_presets p JOIN assets a ON a.id=coalesce(p.draft_asset_id,p.asset_id)
        WHERE p.identity=$1 AND p.framing='full' AND (p.draft_asset_id IS NOT NULL OR p.status='published') AND a.id=$2 AND a.metadata->>'source'='model-preset-library'
        AND a.kind='image' AND a.status='ready' AND a.deleted_at IS NULL`,[s.identity,s.fullAssetId])).rows[0];
    if(!row)throw conflict("同一位模特的全身图已改变，请刷新核对");
    return row.owner_user_id as string;
}
export async function assertPortraitSubmission(db:Query,t:Running){
    await portraitSourceOwner(db,t);
    const s=slotSchema.parse(t.parameters.portraitSlot);
    await lockGroup(db,s.identity);
    if((await target(db,s)).stamp!==t.parameters.portraitTarget)throw conflict("模特格子已改变，未提交付费任务");
}
export async function submitPortraits(db:Database,policy:PortraitPolicy,actor:SessionUser,input:z.infer<typeof portraitOrder>){
    const start=prefix+actor.id+":"+input.requestId+":",signature=createHash("sha256").update(JSON.stringify(input.slots)).digest("hex");
    const read=async(q:Query)=>{
        const list=(await q.query("SELECT id,status,parameters->>'portraitOrder' AS signature FROM tasks WHERE user_id=$1 AND request_id LIKE $2 ORDER BY request_id",[actor.id,start+"%"])).rows;
        if(list.length&&(list.length!==input.slots.length||list.some(r=>r.signature!==signature)))throw conflict("该批次编号已有不同的内容，未重新生成");
        return list.map(r=>({id:r.id as string,status:r.status as string}));
    };
    const prior=await read(db);if(prior.length)return prior;
    const selection=await resolveTryoutBinding(db,"hd"),modelConfigId=selection.execution.modelConfigId;
    const credit=await policy.credits();
    const prep=await Promise.all(input.slots.map(async(s,i)=>{
        const full=s.framing==="full",toolKey=full?"canvas-image":"canvas-edit",operationType=full?"image_generation":"inpaint";
        const execution=await resolveToolExecution(db,{toolKey,operationType,modelConfigId},{allowModelOverride:true});
        return prepareTaskEnqueue(db,{[PRESET_GENERATION]:true,requestId:start+String(i).padStart(2,"0"),userId:actor.id,departmentId:actor.departmentId,projectId:"admin-model-library",operationType,toolKey,modelConfigId,toolConfiguration:execution,
            prompt:portraitPrompt(s),optimized:false,priority:"normal",sourceUrls:s.fullAssetId?["/api/assets/"+s.fullAssetId+"/content"]:[],
            parameters:{tool:toolKey,complexity:"medium",quality:"high",resolution:"2k",portraitSlot:s,portraitOrder:signature},
            creditsEnabled:credit,maxInflightTasks:policy.maxInflightTasks,maxPausedTasks:policy.maxPausedTasks});
    }));
    const admitted=await withTransaction(db,async client=>{
        await lockTaskAdmission(client,actor.id);
        const prior=await read(client);if(prior.length)return {prior,jobs:[]};
        for(const group of [...new Set(input.slots.map(s=>s.identity))].sort())await lockGroup(client,group);
        const latest=await resolveTryoutBinding(client,"hd",true);
        if(latest.binding.revision!==selection.binding.revision||latest.execution.modelConfigId!==modelConfigId)throw conflict("高清绑定已改变，请重新核对");
        const jobs=[];
        for(const [i,s] of input.slots.entries()){
            const p=prep[i]!,actual=await target(client,s);
            if(actual.asset!==s.expectedAssetId)throw conflict("模特格子已改变，请刷新核对");
            await portraitSourceOwner(client,{id:p.taskId,user_id:actor.id,request_id:p.input.requestId,source_urls:p.input.sourceUrls,parameters:p.input.parameters!});
            const inflight=await client.query("SELECT 1 FROM tasks WHERE request_id LIKE 'preset-gen:%' AND parameters->'portraitSlot'->>'identity'=$1 AND parameters->'portraitSlot'->>'framing'=$2 AND status IN ('waiting','processing','paused') LIMIT 1",[s.identity,s.framing]);
            if(inflight.rows.length)throw conflict("该格已有未结束的生成任务，请先核对原任务");
            const current=await resolveToolExecution(client,{toolKey:p.input.toolKey!,operationType:p.input.operationType,modelConfigId},{allowModelOverride:true});
            if(current.configurationVersion!==p.input.toolConfiguration!.configurationVersion)throw conflict("计价已改变，请刷新核对");
            const job=await enqueueTaskInTransaction(client,p);
            await client.query("UPDATE tasks SET parameters=parameters||jsonb_build_object('portraitTarget',$2::text) WHERE id=$1",[job.task.id,actual.stamp]);
            await writeAudit(client,{actor,action:"model-preset.generate",targetType:"task",targetId:job.task.id,result:"success",detail:{slot:slotKey(s),count:input.confirmedCount}});
            jobs.push(job);
        }
        return {prior:[],jobs};
    });
    if(admitted.prior.length)return admitted.prior;
    await Promise.all(admitted.jobs.map(j=>publishEnqueuedTask(policy.cache,j)));
    return admitted.jobs.map(j=>({id:j.task.id,status:j.task.status}));
}
export async function stageGeneratedPortrait(db:Query,t:Running,urls:string[]){
    const s=slotSchema.parse(t.parameters.portraitSlot),asset=urls.length===1?/^\/api\/assets\/([0-9a-f-]{36})\/content$/i.exec(urls[0]!)?.[1]:null;
    if(!asset||!t.request_id.startsWith(prefix+t.user_id+":"))throw conflict("模特生成结果回执不匹配");
    if(!(await db.query("SELECT 1 FROM assets WHERE id=$1 AND task_id=$2 AND owner_user_id=$3 AND kind='image' AND status='ready' AND metadata->>'source'='model-preset-library' AND deleted_at IS NULL",[asset,t.id,t.user_id])).rows.length)throw conflict("模特原图尚未保存");
    await lockGroup(db,s.identity);
    let current=true;
    try{await portraitSourceOwner(db,t);}catch(e){if(!(e instanceof CanvasDocumentError))throw e;current=false;}
    if((await target(db,s)).stamp!==t.parameters.portraitTarget)current=false;
    if(current){
        const m=modelIdentities.find(m=>m.identity===s.identity)!;
        const prior=(await db.query("SELECT name,sort_order / 3 AS rank FROM model_presets WHERE identity=$1 LIMIT 1",[s.identity])).rows[0];
        await db.query("INSERT INTO model_presets(identity,framing,name,audience,asset_id,draft_asset_id,sort_order) VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT(identity,framing) DO UPDATE SET draft_asset_id=excluded.draft_asset_id",[s.identity,s.framing,prior?.name??m.name,m.audience,asset,(prior?.rank??modelIdentities.indexOf(m))*3+modelFramings.indexOf(s.framing)]);
    }
    await db.query("UPDATE tasks SET parameters=parameters||jsonb_build_object('portraitDisposition',$2::text) WHERE id=$1",[t.id,current?"draft":"superseded"]);
}
