import {test,expect} from "bun:test";
import {randomUUID,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import express,{type ErrorRequestHandler} from "express";
import {loadConfig} from "../../src/config";
import {encryptSecret} from "../../src/security";
import type {ObjectStorage} from "../../src/object-storage";
import {createProductCards,tryoutProductItems} from "../../src/product-card-service";
import {createProductCardRouter} from "../../src/routes/product-cards";
import {createIsolatedPostgres} from "../helpers/isolated-postgres";
import {closestProductPart} from "../../../shared/product-card-region";
import type {ProductCard} from "../../../shared/product-card";

const card:ProductCard={version:2,view:"flat",background:"白",items:[{category:"毛线帽",material:"罗纹",parts:["帽体","翻边"],colors:[{name:"蓝",hex:"#223366",part:"帽体"},{name:"白",hex:"#f6f5f0",part:"翻边"}],wearPosition:"head",audience:"unknown",primary:true,pattern:""}]};
test("use a named part only for a close and unambiguous perceptual match",()=>{
    const i=card.items[0]!;
    expect(closestProductPart(i,"#233467")).toBe("帽体");
    expect(closestProductPart(i,"#EE2200")).toBeNull();
    expect(closestProductPart({...i,colors:[...i.colors,{part:"翻边",name:"蓝",hex:"#233367"}]},"#223366")).toBeNull();
});
(process.env.PGLITE_RUNTIME_PATH?test:test.skip)("slow recognition is shared by verified bytes across two employees but edits never cross assets or employees",async()=>{
    const sql=await createIsolatedPostgres(),[a,b,p,m,img,twin,unhashed]=Array.from({length:7},()=>randomUUID());
    const original=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","testsrc2=s=1440x960","-frames:v","1","-threads","1","-f","image2pipe","-c:v","png","pipe:1"],{windowsHide:true});
    const hash=createHash("sha256").update(original).digest("hex"),key=Buffer.alloc(32,5).toString("base64");
    let calls=0,totalReads=0,release!:()=>void;
    const gate=new Promise<void>(r=>release=r),config=loadConfig({NODE_ENV:"test",DATABASE_URL:"isolated",REDIS_URL:"isolated",PROVIDER_ENCRYPTION_KEY:key,PRODUCT_CARD_MODEL_CONFIG_ID:m});
    const storage={get:async()=>{totalReads++;return {Body:{transformToWebStream:()=>new Blob([original]).stream()}};}} as unknown as ObjectStorage;
    let dimensions:unknown,parameters:unknown;
    const cards=createProductCards(sql.db,storage,config,async(_model,_cred,input)=>{
        calls++;const message=input.input[1]!;
        if(!("content" in message)||!Array.isArray(message.content)||message.content[0]?.type!=="input_image")throw new Error("expected inline visual input");
        const url=message.content[0].image_url;if(typeof url!=="string"||!url.startsWith("data:image/webp;base64,"))throw new Error("expected WebP");
        const bytes=Buffer.from(url.split(",")[1]!,"base64");
        dimensions=JSON.parse(execFileSync("ffprobe",["-v","error","-show_entries","stream=width,height","-of","json","pipe:0"],{input:bytes,windowsHide:true}).toString()).streams[0];
        parameters={cap:input.productCardTokenCap,tools:input.tools,stream:input.claude?.stream};
        await gate;return {content:JSON.stringify(card),toolCalls:[]};
    });
    const app=express();app.use(express.json(),(req,_res,next)=>{Object.assign(req,{auth:{id:req.get("x-fixture-user")}});next();});app.use("/api/assets",createProductCardRouter(cards));
    app.use(((e,_q,r,_n)=>r.status(e.status??400).json({code:e.code})) as ErrorRequestHandler);
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
    const http=async(who:string,id:string,method:string="GET",body?:unknown,header=who)=>{
        const res=await fetch("http://127.0.0.1:"+(server.address() as {port:number}).port+"/api/assets/"+id+"/product-card",{method,headers:{"content-type":"application/json","x-fixture-user":who,"x-canvas-owner-id":header},...(body?{body:JSON.stringify(body)}:{})});
        return {...await res.json(),code:res.status};
    };
    try{
        for(const id of [a,b])await sql.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'fixture')",[id,id]);
        await sql.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'vision','openai-chat','https://isolated.invalid',$2)",[p,encryptSecret('{"apiKey":"test"}',key)]);
        await sql.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'vision','fixture',ARRAY['chat','vision'])",[m,p]);
        for(const [id,owner,h] of [[img,a,hash],[twin,b,hash],[unhashed,a,null]])await sql.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,kind,status,byte_size,content_sha256) VALUES($1,$2,$3,'fixture.png','image/png','image','ready',$4,$5)",[id,owner,id,original.length,h]);
        expect((await http(b,img)).code).toBe(404);expect((await http(a,img,"POST",{},b)).code).toBe(403);
        expect((await http(a,img,"POST",{prompt:"untrusted"})).code).toBe(400);
        const starts=await Promise.all([http(a,img,"POST"),http(b,twin,"POST")]);expect(starts.map(r=>r.status)).toEqual(["pending","pending"]);
        for(let i=0;i<160&&!calls;i++)await Bun.sleep(25);
        expect(calls).toBe(1);expect(dimensions).toEqual({width:768,height:512});expect(parameters).toEqual({cap:300,tools:[],stream:false});
        expect(await tryoutProductItems(sql.db,a,[img],true)).toEqual(new Map());
        const edited={...card,items:[{...card.items[0]!,category:"翻边冷帽",audience:"unisex"}]};
        expect((await http(b,img,"PUT",edited)).code).toBe(404);expect((await http(a,img,"PUT",{...edited,items:[]})).code).toBe(400);
        expect((await http(a,img,"PUT",edited)).card).toEqual(edited);
        release();for(let i=0;i<80&&(await http(b,twin)).status!=="ready";i++)await Bun.sleep(20);
        expect((await http(b,twin)).card).toEqual(card);expect((await http(a,img)).card).toEqual(edited);
        expect((await tryoutProductItems(sql.db,a,[img,twin],true)).get(img)?.category).toBe("翻边冷帽");
        expect((await tryoutProductItems(sql.db,a,[img,twin],true)).has(twin)).toBe(false);
        expect((await tryoutProductItems(sql.db,a,[img],false)).size).toBe(0);
        expect((await http(a,unhashed,"POST")).code).toBe(202);
        for(let i=0;i<100&&(await http(a,unhashed)).status!=="ready";i++)await Bun.sleep(20);
        expect((await http(a,unhashed)).card).toEqual(card);expect(calls).toBe(1);expect(totalReads).toBe(2);
        expect((await sql.db.query("SELECT status FROM usage_chat_requests WHERE board_key='product-card'")).rows).toEqual([{status:"success"}]);
        expect((await sql.db.query("SELECT id FROM tasks")).rows).toHaveLength(0);
        await sql.db.query("UPDATE assets SET content_sha256=$2 WHERE id=$1",[unhashed,"1".repeat(64)]);
        expect((await http(a,unhashed,"POST")).status).toBe("pending");
        for(let i=0;i<100&&(await sql.db.query("SELECT status FROM asset_fact_cards WHERE content_sha256=$1",["1".repeat(64)])).rows[0]?.status!=="unavailable";i++)await Bun.sleep(20);
        expect((await http(a,unhashed,"POST")).status).toBe("unavailable");expect(calls).toBe(1);expect(totalReads).toBe(3);
        await sql.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1",[img]);expect((await http(a,img)).code).toBe(404);
    }finally{release();await new Promise<void>(r=>server.close(()=>r()));await sql.close();}
},30000);
