import {expect,test} from "bun:test";
import express from "express";
import {createHmac,randomUUID} from "node:crypto";
import type {AddressInfo} from "node:net";
import {imageHookPath,imageHookRouter,imageHookSubmission,wakeOriginalImage} from "../src/apimart-image-webhook";
import {stepApiMartImageTask} from "../src/apimart-image";
import {createIsolatedPostgres} from "./helpers/isolated-postgres";
import {createIsolatedQueueCache} from "./helpers/isolated-queue-cache";
import {popReadyTask} from "../src/task-queue";

const policy={APIMART_IMAGE_WEBHOOK_ORIGIN:"https://design.example.com",PROVIDER_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")};
test("documented signed callback wakes only the matching local task and ignores supplier URLs and forged or sibling signatures",async()=>{
    const id=randomUUID(),other=randomUUID(),hook=imageHookSubmission(policy,id,"https://api.apimart.ai/v1")!,calls:string[]=[];
    expect(imageHookSubmission(policy,id,"https://example.com")).toBeUndefined();
    expect(imageHookSubmission({},id,"https://api.apimart.ai/v1")).toBeUndefined();
    const app=express();app.use(imageHookPath,imageHookRouter(policy,async(id,remote)=>{calls.push(id+":"+remote);}));
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    const origin="http://127.0.0.1:"+(server.address() as AddressInfo).port;
    try{
        const body='{"id": "remote_1", "status": "completed","result":{"url":"https://invalid.example/ignore"}}';
        const sign=(s:string,b:string)=>createHmac("sha256",s).update(b).digest("hex");
        const post=(signature:string,raw:string,task=id)=>fetch(origin+imageHookPath+"/"+task+"/callback",{method:"POST",headers:{"Content-Type":"application/json","X-Webhook-Signature":signature},body:raw});
        const sig=sign(hook.webhook_secret,body);
        expect((await post("",body)).status).toBe(403);expect((await post(sig,body,other)).status).toBe(403);
        expect((await post(sig,body+" ")).status).toBe(403);expect(calls).toHaveLength(0);
        expect((await post(sig,body)).status).toBe(204);expect(calls).toEqual([id+":remote_1"]);
        let sent:any;
        await stepApiMartImageTask({apiKey:"fixture-key",baseUrl:"https://api.apimart.ai/v1",modelId:"gpt-image-2.6-flare",prompt:"test",parameters:{},imageHook:hook},{fetch:async(_u,i)=>{sent=JSON.parse(String(i?.body));return Response.json({data:[{task_id:"remote_1"}]});}});
        expect(sent).toMatchObject({...hook,language:"zh"});expect(hook.webhook).toBe(policy.APIMART_IMAGE_WEBHOOK_ORIGIN+imageHookPath+"/"+id);
    }finally{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
});

const integration=process.env.PGLITE_RUNTIME_PATH&&process.env.QUEUE_TEST_REDIS_URL?test:test.skip;
integration("callback advances a delayed original in SQL and Redis once without replacing the upstream, altering billing or accepting a result URL",async()=>{
    const pg=await createIsolatedPostgres(),redis=await createIsolatedQueueCache();
    const id=randomUUID(),owner=randomUUID();
    try{
        await pg.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'callback-user','callback user')",[owner]);
        await pg.db.query("INSERT INTO tasks(id,user_id,request_id,project_id,operation_type,status,upstream_task_id,upstream_submission_started_at,available_at) VALUES($1,$2,$3,'test','inpaint','processing','remote_1',now(),now()+interval '1 minute')",[id,owner,id]);
        await wakeOriginalImage(pg.db,redis.cache,id,"unknown");expect(await popReadyTask(redis.cache)).toBeNull();
        await Promise.all([wakeOriginalImage(pg.db,redis.cache,id,"remote_1"),wakeOriginalImage(pg.db,redis.cache,id,"remote_1")]);
        expect(await popReadyTask(redis.cache)).toBe(id);expect(await popReadyTask(redis.cache)).toBeNull();
        const row=(await pg.db.query("SELECT status,upstream_task_id,result_urls,apimart_callback_received_at FROM tasks WHERE id=$1",[id])).rows[0];
        expect(row).toMatchObject({status:"processing",upstream_task_id:"remote_1",result_urls:[]});expect(row.apimart_callback_received_at).toBeTruthy();
        expect((await pg.db.query("SELECT count(*)::int AS n FROM credit_reservations")).rows[0].n).toBe(0);
    }finally{await redis.close();await pg.close();}
},30000);
