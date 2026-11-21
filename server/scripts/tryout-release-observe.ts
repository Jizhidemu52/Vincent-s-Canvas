import {createHash,randomUUID} from "node:crypto";
import {link,mkdir,open,readFile,unlink} from "node:fs/promises";
import {join} from "node:path";
import {fileTypeFromBuffer} from "file-type";
import {paidCases} from "../../tools/tryout-release-plan";
import type {ReleaseGroup,releaseLedger} from "../../tools/tryout-release-ledger";
import {paidReleaseRoute} from "./tryout-release-request";

const hash=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
const maxBytes=64*1024*1024;
async function readImage(response:Response){
    if(!response.ok||!response.body||Number(response.headers.get("Content-Length"))>maxBytes)throw Error("原单图片暂时无法核验");
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
    try{while(true){const r=await reader.read();if(r.done)break;length+=r.value.byteLength;if(length>maxBytes){await reader.cancel();throw Error("原图超过隔离验收上限");}chunks.push(r.value);}}finally{reader.releaseLock();}
    const bytes=Buffer.concat(chunks),type=await fileTypeFromBuffer(bytes);
    if(!type||!["png","jpg","webp"].includes(type.ext)||type.mime!==response.headers.get("Content-Type")?.split(";")[0]?.trim())throw Error("原图字节与响应类型不一致");
    return {bytes,ext:type.ext,sha256:hash(bytes)};
}
async function preserve(path:string,bytes:Buffer,sha256:string){
    const tmp=path+"."+randomUUID()+".tmp",f=await open(tmp,"wx",0o600);
    try{
        try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
        try{await link(tmp,path);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST"||hash(await readFile(path))!==sha256)throw Error("验收图片已存在且不一致，不能覆盖");}
    }finally{await unlink(tmp);}
}
export async function observeReleaseGroup(ledger:Awaited<ReturnType<typeof releaseLedger>>,group:ReleaseGroup,input:unknown,session:{cookie:string;owner:string},directory:string){
    if(!/^[0-9a-f-]{36}$/i.test(session.owner)||!session.cookie||/[\r\n]/.test(session.cookie))throw Error("无效的隔离会话");
    const ids=ledger.operationIds(group),body=JSON.stringify(input),record=JSON.parse(body);
    paidReleaseRoute(group,ids,record);await ledger.readIntent(group,hash(body));
    const get=(path:string)=>fetch(ledger.origin+path,{method:"GET",redirect:"error",headers:{cookie:session.cookie,"X-Canvas-Owner-Id":session.owner},signal:AbortSignal.timeout(30000)});
    const out=[];
    for(const [i,c] of paidCases.filter(c=>c.group===group).entries()){
        const id=ids[i]!;
        const requestId=group.startsWith("portrait-")?`preset-gen:${session.owner}:${id}:00`:group==="creative-original"?id:`tryout:${session.owner}:${group==="hd"?"hd:"+record.sourceTaskId:id}`;
        const res=await get("/api/tasks/by-request/"+encodeURIComponent(requestId));
        if(res.status===404){out.push({slot:c.slot,status:"not-found-query-only"});continue;}
        if(!res.ok)throw Error("原单查询失败："+res.status);
        const t=(await res.json()).task;
        if(!t||t.userId!==session.owner||t.requestId!==requestId||!t.id)throw Error("原单与隔离账本不一致");
        if(t.status!=="success"){out.push({slot:c.slot,status:t.status,taskId:t.id,pausedKind:t.pausedKind??null,hasUpstreamId:Boolean(t.upstreamTaskId)});continue;}
        if(!t.upstreamTaskId||!Array.isArray(t.resultUrls)||t.resultUrls.length!==1||!/^\/api\/assets\/[a-f\d-]{36}\/content$/i.test(t.resultUrls[0]))throw Error("成功记录缺少唯一的原图或上游编号");
        const asset=await readImage(await get(t.resultUrls[0]));
        await mkdir(directory,{recursive:true});const file=join(directory,String(c.slot).padStart(2,"0")+"-"+asset.sha256+"."+asset.ext);
        await preserve(file,asset.bytes,asset.sha256);
        const proof={slot:c.slot,taskId:t.id,upstreamId:t.upstreamTaskId,sha256:asset.sha256,bytes:asset.bytes.length};
        await ledger.verify(group,proof);
        out.push({...proof,status:"original-downloaded",file,credits:t.credits,rmbCost:t.rmbCost,startedAt:t.startedAt,completedAt:t.completedAt});
    }
    return out;
}
