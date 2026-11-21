import {createHash,randomUUID} from "node:crypto";
import {link,mkdir,open,readFile,unlink} from "node:fs/promises";
import {join} from "node:path";
import {paidCases} from "./tryout-release-plan";

export type ReleaseGroup=typeof paidCases[number]["group"];
type Group=ReleaseGroup;
type Candidate={commit:string;origin:string;sampleHashes:string[];deploymentId:string};
type Output={slot:number;taskId:string;upstreamId:string;sha256:string;bytes:number};
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const sha256=/^[0-9a-f]{64}$/;
const isExists=(e:unknown)=>(e as NodeJS.ErrnoException)?.code==="EEXIST";

async function immutable<T>(file:string,value:T):Promise<{created:boolean;value:T}>{
    const temporary=file+"."+randomUUID()+".tmp";
    const handle=await open(temporary,"wx",0o600);
    try{
        try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
        try{await link(temporary,file);return {created:true,value};}catch(error){if(!isExists(error))throw error;}
        return {created:false,value:JSON.parse(await readFile(file,"utf8"))};
    }finally{await unlink(temporary);}
}

export async function releaseLedger(directory:string,candidate:Candidate){
    const url=new URL(candidate.origin);
    const expectedFiles=new Set(paidCases.flatMap(c=>[...c.inputs] as string[])).size;
    if(!["127.0.0.1","[::1]"].includes(url.hostname)||url.origin!==candidate.origin||!url.port||!["http:","https:"].includes(url.protocol))throw Error("只接受隔离回环服务地址");
    if(!/^[0-9a-f]{40}$/.test(candidate.commit)||!candidate.deploymentId.trim()||candidate.sampleHashes.length!==expectedFiles||candidate.sampleHashes.some(v=>!sha256.test(v))||new Set(candidate.sampleHashes).size!==expectedFiles)throw Error("候选身份或样品不完整");
    const descriptor={version:1,commit:candidate.commit,origin:url.origin,deploymentId:candidate.deploymentId,sampleHashes:candidate.sampleHashes,planHash:digest(JSON.stringify(paidCases))};
    await mkdir(directory,{recursive:true});
    const identity=(await immutable(join(directory,"candidate.json"),descriptor)).value;
    if(JSON.stringify(identity)!==JSON.stringify(descriptor))throw Error("同一验收账本禁止切换候选、样品或服务");
    const id=digest(JSON.stringify(identity)).slice(0,22);
    const casesFor=(group:Group)=>{
        const cases=paidCases.filter(c=>c.group===group);
        if(!cases.length)throw Error("不在十单清单内");return cases;
    };
    const claimFile=(group:Group)=>join(directory,"intent-"+group+".json");
    const doneFile=(slot:number)=>join(directory,"verified-"+slot+".json");
    function operationIds(group:Group){
        return casesFor(group).map(c=>{
            const h=digest(id+":"+c.slot);
            return h.slice(0,8)+"-"+h.slice(8,12)+"-8"+h.slice(13,16)+"-a"+h.slice(17,20)+"-"+h.slice(20,32);
        });
    }
    async function claim(group:Group,inputDigest:string){
        const cases=casesFor(group);
        if(!sha256.test(inputDigest))throw Error("必须锁定请求正文摘要");
        for(const c of cases)for(const prior of c.after)await readFile(doneFile(prior),"utf8");
        const ids=operationIds(group);
        const intent={requestId:ids[0]!,requestIds:ids,slots:cases.map(c=>c.slot),inputDigest};
        const {created,value}=await immutable(claimFile(group),intent);
        if(JSON.stringify(value)!==JSON.stringify(intent))throw Error("受理意图已存在，不得更改原请求");
        return {...value,action:created?"submit-once" as const:"query-only" as const};
    }
    async function verify(group:Group,output:Output){
        const cases=casesFor(group);
        await readFile(claimFile(group),"utf8");
        if(!cases.some(c=>c.slot===output.slot)||!output.taskId.trim()||!output.upstreamId.trim()||!sha256.test(output.sha256)||!Number.isSafeInteger(output.bytes)||output.bytes<1)throw Error("缺少可核验的原单或结果");
        for(const [field,v] of [["task",output.taskId],["upstream",output.upstreamId]] as const){
            const mapping=await immutable(join(directory,field+"-"+digest(v)+".json"),{slot:output.slot});
            if(mapping.value.slot!==output.slot)throw Error("两单不能复用同一回执");
        }
        const result=await immutable(doneFile(output.slot),output);
        if(JSON.stringify(result.value)!==JSON.stringify(output))throw Error("不得覆盖已验结果");
    }
    async function readIntent(group:Group,inputDigest:string){
        casesFor(group);
        const intent=JSON.parse(await readFile(claimFile(group),"utf8"));
        if(intent.inputDigest!==inputDigest||JSON.stringify(intent.requestIds)!==JSON.stringify(operationIds(group)))throw Error("只能核对已锁定的原请求");
    }
    return {claim,verify,operationIds,readIntent,origin:identity.origin};
}
