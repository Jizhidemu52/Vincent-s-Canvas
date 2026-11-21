import type {Database,Cache} from "./db";
import {createTryoutReferenceBytes} from "./asset-thumbnails";
import {TASK_EVENTS_CHANNEL} from "./task-events";

const prefix="tryout:temporary-preview:",index=prefix+"recent",ttl=86400;
const store=`
local t=redis.call('TIME') local micros=t[1]*1000000+t[2]
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',micros-ARGV[2]*1000000)
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2])
redis.call('ZADD',KEYS[2],micros,KEYS[1])
redis.call('EXPIRE',KEYS[2],ARGV[2])
local removed=redis.call('ZRANGE',KEYS[2],0,-129)
for _,key in ipairs(removed) do redis.call('DEL',key) redis.call('ZREM',KEYS[2],key) end
return 1`;
const previewKey=(owner:string,id:string)=>prefix+owner+":"+id;
const authorized=`id=$1 AND user_id=$2 AND request_id LIKE 'tryout:'||user_id::text||':%' AND tool_key='canvas-edit' AND operation_type='inpaint'
    AND upstream_result_document->>'kind'='tryout-image' AND status IN ('processing','paused')`;
export function createTryoutPreviewWriter(db:Pick<Database,"query">,cache:Cache,render=createTryoutReferenceBytes,wait=()=>Bun.sleep(180)){
    let active=0;
    return async (task:{id:string;user_id:string},source:Uint8Array,alreadySaved:()=>boolean)=>{
        if(active>=2||source.byteLength>32*1024*1024)return;
        active++;
        try{
            await wait();
            if(alreadySaved())return;
            const bytes=await render(source,512);
            if(alreadySaved()||!bytes.length||bytes.length>128*1024)return;
            await cache.eval(store,{keys:[previewKey(task.user_id,task.id),index],arguments:[bytes.toString("base64"),String(ttl)]});
            await db.query("SELECT pg_notify($3,json_build_object('id',id,'userId',user_id)::text) FROM tasks WHERE "+authorized,[task.id,task.user_id,TASK_EVENTS_CHANNEL]);
        }finally{active--;}
    };
}
export async function readTryoutPreview(db:Pick<Database,"query">,cache:Cache,owner:string,id:string){
    const value=await cache.get(previewKey(owner,id));
    if(!value)return null;
    const row=(await db.query("SELECT status,paused_kind FROM tasks WHERE "+authorized,[id,owner])).rows[0];
    return row?{bytes:Buffer.from(value,"base64"),saving:row.status==="processing"?"saving":row.paused_kind==="result_repair"?"retryable":"review"}:null;
}
