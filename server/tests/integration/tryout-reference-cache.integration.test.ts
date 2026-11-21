import {test,expect} from "bun:test";
import {randomUUID,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createIsolatedPostgres} from "../helpers/isolated-postgres";
import {tryoutReferenceService,invalidateTryoutReferences,pruneTryoutReferences,lookupReadyTryoutInputs} from "../../src/tryout-reference";
import {uploadApiMartImage} from "../../src/apimart-upload";
import {prewarmQueue} from "../../src/tryout-prewarm";

test("an exhausted reference allowance never retries the upload or logs a vendor diagnostic",async()=>{
    let calls=0,sleeps=0;
    await expect(uploadApiMartImage({baseUrl:"https://fixture.invalid",apiKey:"fixture-key",mimeType:"image/png",bytes:Buffer.from([1]),purpose:"image",retentionDays:3},{
        fetch:async()=>{calls++;return Response.json({error:{type:"rate_limit_exceeded",message:"private-url"},overage:{enabled:false}},{status:429});},
        sleep:async()=>{sleeps++;},
    })).rejects.toThrow("免费上传额度已用完");
    expect(calls).toBe(1);expect(sleeps).toBe(0);
});

test("prewarm bounds parallel media work, coalesces an active asset, and does not strand the queue on failure",async()=>{
    let active=0,peak=0,errors=0,ended=0,release!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve),offer=prewarmQueue(()=>{errors++;});
    const job=async()=>{peak=Math.max(peak,++active);await gate;active--;ended++;if(ended===1)throw new Error("isolated");};
    expect(offer("one","a",job)).toBe("accepted");expect(offer("one","a",job)).toBe("active");
    for(let i=0;i<5;i++)expect(offer("one",String(i),job)).toBe("accepted");
    expect(offer("one","blocked",job)).toBe("busy");expect(offer("two","a",job)).toBe("accepted");
    release();await Bun.sleep(10);expect(peak).toBe(2);expect(ended).toBe(7);expect(errors).toBe(1);
});

(process.env.PGLITE_RUNTIME_PATH?test:test.skip)("real resized bytes, untouched HD bytes, isolated SQL leases, cache expiry and exact task invalidation",async()=>{
    const sql=await createIsolatedPostgres();
    const owner=randomUUID(),other=randomUUID(),providerId=randomUUID(),taskId=randomUUID();
    const original=execFileSync(process.env.FFMPEG_PATH||"ffmpeg",["-v","error","-f","lavfi","-i","testsrc2=s=2400x1600","-frames:v","1","-threads","1","-f","image2pipe","-c:v","png","pipe:1"],{maxBuffer:12*1024*1024,windowsHide:true});
    const sha256=createHash("sha256").update(original).digest("hex");
    let reads=0;
    const uploads:{bytes:Buffer;mime:string}[]=[];
    const mock:typeof uploadApiMartImage=async input=>uploadApiMartImage(input,{fetch:async(url,init)=>{
        expect(url).toBe("https://fixture.invalid/v1/uploads/images?retention_days=3");
        const form=init!.body as FormData,file=form.get("file") as File;
        uploads.push({bytes:Buffer.from(await file.arrayBuffer()),mime:file.type});await Bun.sleep(15);
        return Response.json({url:"https://fixture.invalid/images/"+uploads.length,expires_at:Math.floor(Date.now()/1000)+3*86400});
    }});
    const settings={TRYOUT_REFERENCE_MAX_EDGE:1536,APIMART_UPLOAD_CACHE_ENABLED:"true",APIMART_UPLOAD_RETENTION_DAYS:3} as const;
    const input={ownerId:owner,provider:{providerId,apiKey:"fixture-only",baseUrl:"https://fixture.invalid/v1"},sha256,tier:"quick",read:async()=>{reads++;return {bytes:original,mimeType:"image/png"};}} as const;
    try{
        for(const id of [owner,other])await sql.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'fixture')",[id,id]);
        await sql.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'fixture','apimart','https://fixture.invalid/v1')",[providerId]);
        await sql.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,credits,rmb_cost) VALUES($1,$2,$3,'winter','inpaint','waiting',0,0)",[taskId,randomUUID(),owner]);
        const a=tryoutReferenceService(sql.db,settings,{upload:mock}),b=tryoutReferenceService(sql.db,settings,{upload:mock});
        const urls=await Promise.all([a(input),b({...input,taskId}),a({...input,taskId})]);
        expect(new Set(urls).size).toBe(1);expect(uploads.length).toBe(1);expect(reads).toBe(1);expect(uploads[0].mime).toBe("image/webp");
        const asset=randomUUID(),sourceUrls=["/api/assets/"+asset+"/content"];
        await sql.db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status,content_sha256) VALUES($1,$2,$3,'image.png','image/png',$4,'image','ready',$5)",[asset,owner,asset,original.length,sha256]);
        expect(await lookupReadyTryoutInputs(sql.db,settings,{...input,taskId,sourceUrls})).toEqual([urls[0]]);
        expect(await lookupReadyTryoutInputs(sql.db,settings,{...input,ownerId:other,taskId,sourceUrls})).toBeUndefined();
        expect(await lookupReadyTryoutInputs(sql.db,settings,{...input,tier:"hd",taskId,sourceUrls})).toBeUndefined();
        const expiry=(await sql.db.query("SELECT extract(epoch FROM expires_at-now())/3600 AS hours FROM provider_upload_cache")).rows[0].hours;
        expect(Number(expiry)).toBeGreaterThan(59);expect(Number(expiry)).toBeLessThanOrEqual(60);
        await sql.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1",[asset]);
        expect(await lookupReadyTryoutInputs(sql.db,settings,{...input,taskId,sourceUrls})).toBeUndefined();
        const dimensions=JSON.parse(execFileSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=width,height","-of","json","pipe:0"],{input:uploads[0].bytes,windowsHide:true}).toString());
        expect(dimensions.streams[0]).toMatchObject({width:1536,height:1024});
        await b({...input,tier:"hd"});expect(uploads[1].bytes.equals(original)).toBe(true);expect(uploads[1].mime).toBe("image/png");
        await a({...input,ownerId:other});await a({...input,provider:{...input.provider,apiKey:"rotated-fixture"}});
        expect(uploads.length).toBe(4);
        await sql.db.query("UPDATE provider_upload_cache SET expires_at=now()-interval '1 minute' WHERE url=$1",[urls[0]]);
        const newest=await b(input);expect(newest).not.toBe(urls[0]);expect(uploads.length).toBe(5);
        await invalidateTryoutReferences(sql.db,taskId);expect(await a(input)).toBe(newest);expect(uploads.length).toBe(5);
        await a({...input,taskId});await invalidateTryoutReferences(sql.db,taskId);expect(await b(input)).not.toBe(newest);
        expect(uploads.length).toBe(6);
        await sql.db.query("UPDATE provider_upload_cache SET expires_at=now()-interval '2 hours'");
        await pruneTryoutReferences(sql.db);
        expect((await sql.db.query("SELECT 1 FROM provider_upload_cache")).rows.length).toBe(0);
        expect((await sql.db.query("SELECT 1 FROM provider_upload_task_inputs")).rows.length).toBe(0);
        expect((await sql.db.query("SELECT 1 FROM credit_reservations")).rows.length).toBe(0);
        console.log(JSON.stringify({quick:{width:1536,height:1024,bytes:uploads[0].bytes.length},original:{width:2400,height:1600,bytes:original.length},simultaneousRequests:3,firstUploads:1}));
    }finally{await sql.close();}
},40_000);
