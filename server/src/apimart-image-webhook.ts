import {createHmac,timingSafeEqual} from "node:crypto";
import {Router,raw} from "express";
import type {Cache,Database} from "./db";
import {scheduleQueuedTask} from "./task-queue";
import {queueScore,type TaskPriority} from "./tasks";

const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const base="/api/hooks/apimart/image";
export const imageHookPath=base;
type Policy={APIMART_IMAGE_WEBHOOK_ORIGIN?:string;PROVIDER_ENCRYPTION_KEY?:string};
function taskSecret(policy:Policy,id:string){
    const key=Buffer.from(policy.PROVIDER_ENCRYPTION_KEY??"","base64");
    if(!policy.APIMART_IMAGE_WEBHOOK_ORIGIN||key.length!==32||!uuid.test(id))return;
    return createHmac("sha256",key).update("apimart-image-hook:v1:"+id.toLowerCase()).digest("hex");
}
export function imageHookSubmission(policy:Policy,id:string,providerUrl:string){
    if(!policy.APIMART_IMAGE_WEBHOOK_ORIGIN)return;
    let endpoint:URL;try{endpoint=new URL(providerUrl);}catch{return;}
    if(endpoint.origin!=="https://api.apimart.ai"||endpoint.username||endpoint.password)return;
    const secret=taskSecret(policy,id);
    if(secret)return {webhook:policy.APIMART_IMAGE_WEBHOOK_ORIGIN+base+"/"+id,webhook_secret:secret};
}
export function imageHookRouter(policy:Policy,wake:(id:string,remote:string)=>Promise<void>){
    const router=Router();
    router.post("/:id/callback",raw({type:"application/json",inflate:false,limit:"64kb"}),async(req,res)=>{
        const id=req.params.id,secret=taskSecret(policy,id),sig=req.get("X-Webhook-Signature")??"";
        if(!secret||!/^[a-f\d]{64}$/i.test(sig)||!Buffer.isBuffer(req.body)||!timingSafeEqual(Buffer.from(sig,"hex"),createHmac("sha256",secret).update(req.body).digest())){res.sendStatus(403);return;}
        let data;try{data=JSON.parse(req.body.toString("utf8"));}catch{res.sendStatus(400);return;}
        if(!data||typeof data.id!=="string"||data.id.length>250||!data.id.trim()||!["completed","failed"].includes(data.status)){res.sendStatus(400);return;}
        try{await wake(id,data.id);res.sendStatus(204);}catch{res.sendStatus(503);}
    });
    return router;
}
export async function wakeOriginalImage(db:Database,cache:Cache,id:string,remote:string){
    const row=(await db.query<{priority:TaskPriority;queued_at:Date}>(`UPDATE tasks SET apimart_callback_received_at=clock_timestamp(),available_at=LEAST(available_at,clock_timestamp())
        WHERE id=$1 AND upstream_task_id=$2 AND upstream_submission_started_at IS NOT NULL AND status='processing'
        AND execution_token IS NULL AND reference_download_recheck_at IS NULL AND apimart_callback_received_at IS NULL
        RETURNING priority,queued_at`,[id,remote])).rows[0];
    if(!row)return;
    try{await scheduleQueuedTask(cache,id,queueScore(row.priority,new Date(row.queued_at).getTime()));}
    catch(e){
        await db.query("UPDATE tasks SET apimart_callback_received_at=NULL WHERE id=$1 AND upstream_task_id=$2 AND status='processing' AND execution_token IS NULL",[id,remote]);
        throw e;
    }
}
