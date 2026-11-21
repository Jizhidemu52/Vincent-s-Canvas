import {expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {releaseLedger} from "../tryout-release-ledger";

test("concurrent claims consume only one intent, interrupted groups are query-only, and dependent slots require original results",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"tryout-ten-"));
    const candidate={commit:"f".repeat(40),deploymentId:"isolated-1",origin:"http://127.0.0.1:18991",sampleHashes:["1","2","3","4","5"].map(n=>n.repeat(64))};
    const sig="e".repeat(64),err=(p:Promise<unknown>)=>p.then(()=>null,e=>e);
    try{
        expect(await err(releaseLedger(directory,{...candidate,origin:"http://prod.example.org:8080"}))).toBeInstanceOf(Error);
        const ledger=await releaseLedger(directory,candidate);
        expect(await err(ledger.claim("portrait-head",sig))).toBeInstanceOf(Error);
        const requests=await Promise.all(Array.from({length:12},()=>ledger.claim("portrait-full",sig)));
        expect(requests.filter(c=>c.action==="submit-once")).toHaveLength(1);
        expect(new Set(requests.map(c=>c.requestId)).size).toBe(1);
        const output={slot:1,taskId:"local-one",upstreamId:"up-one",sha256:sig,bytes:342};
        await ledger.verify("portrait-full",output);await ledger.verify("portrait-full",output);
        expect((await ledger.claim("portrait-head",sig)).action).toBe("submit-once");
        expect(await err(ledger.verify("portrait-head",{...output,slot:2}))).toBeInstanceOf(Error);
        expect((await ledger.claim("batch-color",sig)).slots).toEqual([8,9]);
        expect((await (await releaseLedger(directory,candidate)).claim("batch-color",sig)).action).toBe("query-only");
        expect(await err(ledger.claim("batch-color","a".repeat(64)))).toBeInstanceOf(Error);
        expect(await err(releaseLedger(directory,{...candidate,commit:"1".repeat(40)}))).toBeInstanceOf(Error);
    }finally{await rm(directory,{recursive:true,force:true});}
});
