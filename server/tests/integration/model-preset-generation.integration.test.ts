import {expect,test} from "bun:test";
import {randomUUID} from "node:crypto";
import express,{type ErrorRequestHandler} from "express";
import {createIsolatedPostgres} from "../helpers/isolated-postgres";
import {createAdminModelPresetsRouter} from "../../src/routes/model-presets";
import {portraitSourceOwner,stageGeneratedPortrait} from "../../src/model-preset-generation";
import {prepareTaskEnqueue} from "../../src/tasks";
import {withTransaction} from "../../src/db-transaction";
import type {ObjectStorage} from "../../src/object-storage";
import type {Cache} from "../../src/db";

(process.env.PGLITE_RUNTIME_PATH?test:test.skip)("only confirmed portrait jobs use HD and the same full portrait; stale results cannot publish or replace new drafts",async()=>{
    const sql=await createIsolatedPostgres(),db=sql.db;
    const [admin,other,designer,provider,model]=Array.from({length:5},()=>randomUUID());
    const app=express();app.use(express.json(),(req,_res,next)=>{const id=req.get("x-test");Object.assign(req,{auth:{id,role:id===designer?"designer":"super_admin",departmentId:null}});next();});
    app.use("/library",createAdminModelPresetsRouter(db,{} as ObjectStorage,{cache:{eval:async()=>1} as unknown as Cache,credits:async()=>true,maxInflightTasks:12,maxPausedTasks:3}));
    app.use(((e,_req,res,_n)=>res.status(e.status??400).json({error:e.message})) as ErrorRequestHandler);
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const base="http://127.0.0.1:"+(server.address() as {port:number}).port+"/library/";
    const call=async(path:string,body?:unknown,actor=admin,method=body?"POST":"GET")=>{const r=await fetch(base+path,{method,headers:{"Content-Type":"application/json","x-canvas-owner-id":actor,"x-test":actor},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json().catch(()=>({}))};};
    const slot=(identity:string,framing:string,fullAssetId:string|null=null,expectedAssetId:string|null=null)=>({identity,framing,fullAssetId,expectedAssetId});
    const order=(...slots:ReturnType<typeof slot>[])=>({requestId:randomUUID(),confirmedCount:slots.length,slots});
    const task=async(id:string)=>(await db.query("SELECT * FROM tasks WHERE id=$1",[id])).rows[0];
    const save=async(owner:string,taskId:string|null)=>{const id=randomUUID();await db.query("INSERT INTO assets(id,owner_user_id,task_id,object_key,filename,mime_type,kind,status,metadata) VALUES($1::uuid,$2,$3,$1::uuid::text,'model.png','image/png','image','ready',$4)",[id,owner,taskId,JSON.stringify({source:"model-preset-library"})]);return id;};
    try{
        for(const uid of [admin,other,designer])await db.query("INSERT INTO users(id,username,display_name,role,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Account',$3,250,250,250)",[uid,uid,uid===designer?"designer":"super_admin"]);
        await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Model supplier','apimart','https://no-network.invalid','fixture')",[provider]);
        await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'HD','gpt-image-2.6-sunburst',ARRAY['edit','generate'],2,0.1)",[model,provider]);
        await db.query("UPDATE tryout_model_bindings SET model_config_id=$1 WHERE tier='hd'",[model]);
        const full=slot("white-woman","full"),first=order(full),unknown=slot("white-woman","head",randomUUID());
        expect((await call("generation",first,designer)).status).toBe(403);
        expect((await call("generation",{...first,confirmedCount:2})).status).toBe(400);
        expect((await call("generation",order(full,full))).status).toBe(400);
        expect((await call("generation",order(full,unknown))).status).toBe(400);
        expect((await call("generation",order(slot("white-boy","full"),unknown))).status).toBe(409);
        expect((await db.query("SELECT id FROM tasks")).rows).toHaveLength(0);
        await expect(prepareTaskEnqueue(db,{requestId:"preset-gen:forged",userId:designer,departmentId:null,projectId:"x",operationType:"image_generation",prompt:"x",priority:"normal",sourceUrls:[]})).rejects.toThrow("管理端");
        const initial=await call("generation",first);expect(initial).toMatchObject({status:200,jobs:[{status:"waiting"}]});
        const job=await task(initial.jobs[0].id);expect(job).toMatchObject({operation_type:"image_generation",model_config_id:model,source_urls:[],parameters:{quality:"high",resolution:"2k"}});
        expect((await call("generation",first)).jobs[0].id).toBe(job.id);
        expect((await call("generation",{...first,slots:[slot("white-boy","full")]})).status).toBe(409);
        expect((await call("generation",order(full),other)).status).toBe(409);
        const image=await save(admin,job.id);
        await withTransaction(db,async c=>{await stageGeneratedPortrait(c,job,["/api/assets/"+image+"/content"]);await c.query("UPDATE tasks SET status='success' WHERE id=$1",[job.id]);});
        expect((await call("")).presets[0]).toMatchObject({status:"draft",draftAssetId:image});
        const id=(await call("")).presets[0].id;expect((await call(id+"/publish",{expectedAssetId:image})).status).toBe(204);
        const crops=order(slot("white-woman","half",image),slot("white-woman","head",image)),batch=await call("generation",crops,other);
        expect(batch.status).toBe(200);expect(batch.jobs).toHaveLength(2);
        const half=await task(batch.jobs[0].id),head=await task(batch.jobs[1].id);
        expect(half.source_urls).toEqual(["/api/assets/"+image+"/content"]);expect(head.prompt).toContain("头肩特写");expect(half.prompt).toContain("从头顶到腰部");
        expect(await portraitSourceOwner(db,half)).toBe(admin);
        const manual=await save(other,null);expect((await call("white-woman/half/draft",{assetId:manual},other,"PUT")).status).toBe(200);
        for(const j of [half,head]){const result=await save(other,j.id);await withTransaction(db,c=>stageGeneratedPortrait(c,j,["/api/assets/"+result+"/content"]));}
        expect((await task(half.id)).parameters.portraitDisposition).toBe("superseded");expect((await task(head.id)).parameters.portraitDisposition).toBe("draft");
        const slots=(await call("")).presets;expect(slots.find((s:any)=>s.framing==="half")).toMatchObject({draftAssetId:manual});expect(slots.filter((s:any)=>s.status==="published")).toHaveLength(1);
        expect((await db.query("SELECT id FROM credit_reservations")).rows).toHaveLength(3);
    }finally{await new Promise<void>(r=>server.close(()=>r()));await sql.close();}
},60000);
