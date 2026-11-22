import {test,expect} from "bun:test";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import express,{type ErrorRequestHandler} from "express";
import {createIsolatedPostgres} from "../helpers/isolated-postgres";
import {loadConfig} from "../../src/config";
import {encryptSecret} from "../../src/security";
import type {ObjectStorage} from "../../src/object-storage";
import {createPresetAnalysisRouter} from "../../src/preset-image-analysis";
import {createAdminModelPresetsRouter} from "../../src/routes/model-presets";
import {modelCatalog,resolvePortrait,lockPreset} from "../../src/model-library";

(process.env.PGLITE_RUNTIME_PATH?test:test.skip)("private curator uploads are analyzed once and only published portraits can cross accounts",async()=>{
    const sql=await createIsolatedPostgres(),[owner,other,provider,model,fabric,portrait,personal]=Array.from({length:7},()=>randomUUID());
    const key=Buffer.alloc(32,6).toString("base64"),config=loadConfig({DATABASE_URL:"fixture",REDIS_URL:"fixture",PROVIDER_ENCRYPTION_KEY:key});
    const bytes=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=gray:s=900x800","-frames:v","1","-threads","1","-f","image2pipe","-c:v","png","pipe:1"],{windowsHide:true});
    const storage={get:async()=>({Body:{transformToWebStream:()=>new Blob([bytes]).stream()}})} as unknown as ObjectStorage;
    const answer={name:"样本",description:"可见表面描述"};let calls=0;
    const app=express();app.use(express.json(),(req,_res,next)=>{Object.assign(req,{auth:{id:req.get("x-id"),role:req.get("x-role")}});next();});
    app.use("/analysis",createPresetAnalysisRouter(sql.db,storage,config,async(_m,_c,i)=>{calls++;expect(i.tools).toEqual([]);expect(JSON.stringify(i.input)).toContain("data:image/webp;base64,");return {content:JSON.stringify(answer),toolCalls:[]};}));
    app.use("/models",createAdminModelPresetsRouter(sql.db,storage));app.use(((e,_q,r,_n)=>r.status(e.status??400).json({message:e.message})) as ErrorRequestHandler);
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    const req=(path:string,method="POST",body:object={},who=owner,role="super_admin")=>fetch("http://127.0.0.1:"+(server.address() as {port:number}).port+path,{method,headers:{"content-type":"application/json","x-canvas-owner-id":who,"x-id":who,"x-role":role},body:JSON.stringify(body)});
    try{
        for(const id of [owner,other])await sql.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'fixture')",[id,id]);
        await sql.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'sol','apimart','https://fixture.invalid',$2)",[provider,encryptSecret('{"apiKey":"fixture"}',key)]);
        await sql.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'sol','gpt-6.2-sol',ARRAY['chat','vision'])",[model,provider]);
        for(const [id,source] of [[fabric,"material-preset-library"],[portrait,"company-model-library"],[personal,"model-library"]])await sql.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,kind,status,byte_size,metadata) VALUES($1,$2,$3,'f.png','image/png','image','ready',$4,$5)",[id,owner,id,bytes.length,JSON.stringify({source})]);
        expect((await req("/analysis/portrait/"+personal)).status).toBe(404);
        expect((await req("/analysis/fabric/"+fabric,"POST",{},other)).status).toBe(404);
        expect((await req("/analysis/fabric/"+fabric,"POST",{},owner,"designer")).status).toBe(403);
        for(const path of ["/analysis/fabric/"+fabric,"/analysis/portrait/"+portrait])for(let i=0;i<2;i++)expect(await (await req(path)).json()).toEqual({status:"ready",...answer});
        expect(calls).toBe(2);
        expect((await modelCatalog(sql.db,other)).custom).toHaveLength(0);
        const save=(status:string)=>req("/models/company/"+portrait,"PUT",{...answer,status});
        expect((await save("published")).ok).toBe(true);
        expect((await resolvePortrait(sql.db,other,{presetId:portrait},null)).assetId).toBe(portrait);
        await lockPreset(sql.db,portrait,portrait);
        expect((await modelCatalog(sql.db,other)).custom[0]?.description).toBe(answer.description);
        expect((await save("hidden")).ok).toBe(true);
        await expect(resolvePortrait(sql.db,other,{presetId:portrait},null)).rejects.toThrow();
        await expect(lockPreset(sql.db,portrait,portrait)).rejects.toThrow();
    }finally{await new Promise<void>(r=>server.close(()=>r()));await sql.close();}
},45000);
