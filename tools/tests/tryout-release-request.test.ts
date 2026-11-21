import {expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {releaseLedger} from "../tryout-release-ledger";
import {dispatchReleaseGroup,paidReleaseRoute} from "../../server/scripts/tryout-release-request";
import {portraitOrder} from "../../server/src/model-preset-generation";
import {observeReleaseGroup} from "../../server/scripts/tryout-release-observe";
import {checkReleaseTarget} from "../../server/scripts/tryout-release-cli";
import {createHash} from "node:crypto";

test("preflight refuses the wrong running revision, absent preview or nonlocal target before spending",async()=>{
    let sha="c".repeat(40),preview=true;
    const paths:string[]=[];
    const app=Bun.serve({hostname:"127.0.0.1",port:0,fetch(r){
        const p=new URL(r.url).pathname;paths.push(r.method+" "+p);
        if(p==="/revision.txt")return new Response(sha+"\n");
        return Response.json(p==="/api/health"?{status:"ok"}:{authenticationEnabled:true,tryoutDisplayBeforeSave:preview});
    }});
    try{
        const check=(url:string,s:string)=>checkReleaseTarget(url,s).then(()=>null,e=>e);
        expect(await check("https://example.invalid","a".repeat(40))).toBeInstanceOf(Error);expect(paths).toHaveLength(0);
        expect(await check(app.url.origin,"a".repeat(40))).toBeInstanceOf(Error);expect(paths).toEqual(["GET /revision.txt"]);
        preview=false;expect(await check(app.url.origin,sha)).toBeInstanceOf(Error);
        preview=true;expect(await check(app.url.origin,sha)).toBeNull();expect(paths.every(p=>p.startsWith("GET "))).toBe(true);
    }finally{app.stop(true);}
});

test("the ten-slot gateway submits one real HTTP request to the isolated app and never repeats missing or partial acknowledgements",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"tryout-gateway-"));
    const requests:string[]=[];
    const app=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){requests.push(req.method+" "+new URL(req.url).pathname);return Response.json({tasks:[{error:{code:"SECOND_UNCERTAIN"}}]},{status:503});}});
    try{
        const ledger=await releaseLedger(directory,{commit:"d".repeat(40),deploymentId:"fake-supplier",origin:app.url.origin,sampleHashes:["1","2","3","4","5"].map(n=>n.repeat(64))});
        const [a,b]=ledger.operationIds("batch-color"),session={cookie:"test=local-only",owner:crypto.randomUUID()};
        const common={sourceAssetId:crypto.randomUUID(),kind:"color",tier:"quick",canvasId:"test",color:{name:"蓝",hex:"#5555CC"}};
        const items=[{...common,requestId:a,nodeId:"a"},{...common,requestId:b,nodeId:"b"}];
        const reject=(p:Promise<unknown>)=>p.then(()=>null,e=>e);
        expect(await reject(dispatchReleaseGroup(ledger,"batch-color",{items:[...items,{...items[0],nodeId:"c",requestId:crypto.randomUUID()}]},session))).toBeInstanceOf(Error);
        expect(requests).toHaveLength(0);
        const first=await dispatchReleaseGroup(ledger,"batch-color",{items},session),second=await dispatchReleaseGroup(ledger,"batch-color",{items},session);
        expect(first).toMatchObject({action:"submit-once",status:503});expect(second).toMatchObject({action:"query-only",requestIds:[a,b]});
        expect(requests).toEqual(["POST /api/tryout/quick/batch"]);
        for(const framing of ["head","full"] as const){
            const group=framing==="head"?"portrait-head":"portrait-full",ids=ledger.operationIds(group);
            const order={requestId:ids[0],confirmedCount:1,slots:[{identity:"white-woman",framing,expectedAssetId:null,fullAssetId:framing==="full"?null:session.owner}]};
            expect(portraitOrder.safeParse(order).success).toBe(true);
            expect(paidReleaseRoute(group,ids,order)).toBe("/api/admin/model-presets/generation");
            expect(()=>paidReleaseRoute(group,ids,{...order,confirmedCount:2})).toThrow();
        }
    }finally{app.stop(true);await rm(directory,{recursive:true,force:true});}
});

test("partial batches fetch original bytes by owner and original ID only, never POST or double-count on later reads",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"tryout-observer-")),owner=crypto.randomUUID(),asset=crypto.randomUUID(),t=crypto.randomUUID(),requests:string[]=[];
    const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=","base64");
    let original="",external=false;
    const app=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
        const path=decodeURIComponent(new URL(req.url).pathname);
        requests.push(req.method);
        if(path==="/api/assets/"+asset+"/content")return new Response(png,{headers:{"Content-Type":"image/png"}});
        if(path.endsWith(original))return Response.json({task:{userId:owner,id:t,requestId:original,upstreamTaskId:"remote-eight",status:"success",resultUrls:[external?"https://example.invalid/not-original":"/api/assets/"+asset+"/content"]}});
        return new Response(null,{status:404});
    }});
    try{
        const ledger=await releaseLedger(directory,{commit:"6".repeat(40),deploymentId:"observer-test",origin:app.url.origin,sampleHashes:["1","2","3","4","5"].map(n=>n.repeat(64))});
        const ids=ledger.operationIds("batch-color"),input={items:ids.map((requestId,i)=>({requestId,nodeId:"n"+i,canvasId:"test",kind:"color",tier:"quick",sourceAssetId:asset,color:{name:"blue",hex:"#284899"}}))};
        original="tryout:"+owner+":"+ids[0];
        const observe=()=>observeReleaseGroup(ledger,"batch-color",input,{cookie:"test=fixture",owner},join(directory,"images"));
        expect(await observe().then(()=>null,e=>e)).toBeInstanceOf(Error);expect(requests).toHaveLength(0);
        await ledger.claim("batch-color",createHash("sha256").update(JSON.stringify(input)).digest("hex"));
        for(let i=0;i<2;i++)expect(await observe()).toMatchObject([{slot:8,status:"original-downloaded",bytes:png.length},{slot:9,status:"not-found-query-only"}]);
        external=true;expect(await observe().then(()=>null,e=>e)).toBeInstanceOf(Error);expect(new Set(requests)).toEqual(new Set(["GET"]));
    }finally{app.stop(true);await rm(directory,{recursive:true,force:true});}
});
