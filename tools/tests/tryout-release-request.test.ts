import {expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {releaseLedger} from "../tryout-release-ledger";
import {dispatchReleaseGroup,paidReleaseRoute} from "../../server/scripts/tryout-release-request";
import {portraitOrder} from "../../server/src/model-preset-generation";

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
