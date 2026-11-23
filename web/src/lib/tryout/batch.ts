import {TRYOUT_BATCH_MAX} from "../../../../shared/tryout-limits";
import type {TryoutSubmissionInput} from "../../../../shared/tryout-submission";
import type {DropColor,DropRegion,TryoutChip,WearChip} from "@/components/canvas/toolbox/tryout-swatch";

export type TryoutTransport=(input:TryoutSubmissionInput,owner:string,current:()=>boolean)=>Promise<Response>;
export type BatchJob={nodeId:string;chip:TryoutChip|WearChip;region?:DropRegion};
export type BatchOutcome={planned:number;sent:number;accepted:string[];rejected:number;unknown:number;truncated:boolean};
const local=(status:number,message:string)=>Response.json({message},{status});
type Slot={input:TryoutSubmissionInput;owner:string;current:()=>boolean;finish:(r:Response)=>void};
export async function batchTryout(jobs:BatchJob[],drop:DropColor,owner:string,canSend:()=>boolean,send:typeof fetch=fetch):Promise<BatchOutcome>{
    const picked=jobs.slice(0,TRYOUT_BATCH_MAX),outcome:BatchOutcome={planned:picked.length,sent:0,accepted:[],rejected:0,unknown:0,truncated:picked.length!==jobs.length};
    const slots=new Map<number,Slot>(),completed:Promise<unknown>[]=[],at=Date.now();
    await Promise.all(picked.map((job,i)=>new Promise<void>(ready=>{
        const capture:TryoutTransport=(input,user,current)=>new Promise<Response>(finish=>{slots.set(i,{input,owner:user,current,finish});ready();});
        completed.push(Promise.resolve().then(()=>drop(job.nodeId,job.chip,job.region??"",at,capture)).catch(()=>{}).finally(ready));
    })));
    const live:Slot[]=[];
    for(let i=0;i<picked.length;i++){
        const slot=slots.get(i);
        if(slot?.owner===owner&&canSend()&&slot.current())live.push(slot);
        else{outcome.rejected++;slot?.finish(local(409,"画布已改变或已取消，本项未提交"));}
    }
    if(live.length){
        outcome.sent=live.length;
        try{
            const res=await send("/api/tryout/quick/batch",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:JSON.stringify({items:live.map(s=>s.input)})});
            const data=await res.json().catch(()=>null);
            const rows=Array.isArray(data?.tasks)?data.tasks:[];
            for(const s of live){
                const hits=rows.filter((r:{requestId?:unknown}|null)=>r?.requestId===s.input.requestId);
                const row=hits.length===1?hits[0]:undefined;
                if(res.ok&&typeof row?.taskId==="string"&&row.taskId&&!row.error){outcome.accepted.push(row.taskId);s.finish(Response.json(row));}
                else if(res.ok&&typeof row?.error?.code==="string"||!res.ok&&res.status>=400&&res.status<500&&res.status!==408){outcome.rejected++;s.finish(local(409,row?.error?.message||data?.message||"本项未受理"));}
                else{outcome.unknown++;s.finish(local(503,"回执未确认，只查询原任务"));}
            }
        }catch{for(const s of live){outcome.unknown++;s.finish(local(503,"回执未确认，只查询原任务"));}}
    }
    await Promise.all(completed);
    return outcome;
}
