import {readFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import {createHash} from "node:crypto";
import {qualityReport,type ReviewPoint} from "../shared/try-on-quality";
import {groups} from "../shared/try-on-recipes";
import {baseline,buildRound,reviewCoverage,round1Variants,round2Variants,round3Winner} from "./try-on-eval/cases";
import type {Evaluation} from "./try-on-eval/score";

type RecordSet={round:number;group:string;rows:Evaluation[]};
export function offlineReport(round:1|2|3,review:boolean,records:RecordSet[],includeCases:boolean,selected?:string){
    const used=new Set<RecordSet>();
    const selectedGroups=selected?groups.filter(g=>g.group===selected):groups;
    if(!selectedGroups.length)throw Error("未知品类");
    const summaries=selectedGroups.map(g=>{
        const samples=Array.from({length:5},(_,i)=>String(groups.indexOf(g)*5+i+1).padStart(2,"0")),models=["adult-a","adult-b"];
        const base=baseline(g.group);
        let variants=round1Variants(base);
        for(const step of [1,2,3] as const){
            const attempts=buildRound(step,variants,samples,models);
            const entry=records.find(r=>r.group===g.group&&r.round===step);
            const grading=entry?reviewCoverage(attempts,entry.rows):null;
            if(entry)used.add(entry);
            if(step===round){
                if(review&&!grading)throw Error(g.group+"缺少本轮回执");
                return {group:g.group,round,variants:variants.length,attempts:attempts.length,plannedImages:attempts.reduce((n,a)=>n+(a.settings.twoStep?2:1),0),plannedJudgeCalls:attempts.length,...(grading?{grading}:{}),...(includeCases?{cases:attempts}:{})};
            }
            if(!entry||!grading?.reviewComplete)throw Error(g.group+"上一轮回执或两成人工抽查未齐");
            variants=step===1?round2Variants(base,attempts,entry.rows):[round3Winner(attempts,entry.rows)];
        }
        throw Error("无效轮次");
    });
    if(used.size!==records.length)throw Error("回执包含未知品类、重复或未请求的轮次");
    return {mode:"offline" as const,source:"local-evaluation-records" as const,paidSubmissions:0,round,plannedImages:summaries.reduce((s,g)=>s+g.plannedImages,0),plannedJudgeCalls:summaries.reduce((s,g)=>s+g.plannedJudgeCalls,0),groups:summaries};
}
export function reviewedSnapshot(group:string,records:RecordSet[],origin:ReviewPoint["origin"],testedAt:string):ReviewPoint{
    const report=offlineReport(3,true,records,false,group).groups[0]!,grade=report.grading;
    if(!grade?.reviewComplete||grade.grades.length!==1)throw Error("第三轮稳定性测试及人工抽查必须齐全");
    const result=grade.grades[0]!;
    const receipts=records.slice().sort((a,b)=>a.round-b.round).map(batch=>[batch.round,batch.group,batch.rows.map(r=>[r.sampleId,r.modelIdentity,r.variant,r.repeat,r.outputs,r.elapsedMs,...(["style","color","detail","wear","natural"] as const).map(k=>[r.automatic[k],r.reviewed?.[k]??null])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
    const snapshot={group,variant:result.variant,origin,testedAt,sampleCount:result.count,reviewed:result.reviewed,passed:Math.round(result.passRate*result.count),score:result.score,stable:result.stable,evidenceSha256:createHash("sha256").update(JSON.stringify(receipts)).digest("hex")};
    qualityReport([snapshot]);return snapshot;
}
if(import.meta.main){
    try {
        const {positionals,values}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{round:{type:"string"},group:{type:"string"},records:{type:"string"},cases:{type:"boolean"},origin:{type:"string"},at:{type:"string"},media:{type:"string"}}});
        const action=positionals[0],round=Number(values.round);
        if(positionals.length!==1||!["plan","report","snapshot"].includes(action??"")||![1,2,3].includes(round))throw Error("用法：plan|report --round 1|2|3 [--group 品类] [--records 本地回执.json] [--cases]。不会调用供应商。");
        const data=values.records?JSON.parse(await readFile(values.records,"utf8")):[];
        if(!Array.isArray(data))throw Error("回执应为逐轮逐品类的数组");
        if(action==="snapshot"){
            if(round!==3||!values.group||!values.at||!(values.origin==="physical"||values.origin==="synthetic"))throw Error("snapshot 需要 --round 3 --group --at UTC时间 --origin physical|synthetic 和完整回执");
            console.log(JSON.stringify(reviewedSnapshot(values.group,data,values.origin,values.at),null,2));
        }else{
            const report=offlineReport(round as 1|2|3,action==="report",data,!!values.cases,values.group);
            if(values.media){
                if(action!=="report"||!values.group)throw Error("对比页需要 report --group 与当前轮次的图像清单");
                const {writeContactSheet}=await import("./try-on-eval/report");
                const batch=(data as RecordSet[]).find(r=>r.group===values.group&&r.round===round)!;
                console.log(JSON.stringify({...report,contactSheet:await writeContactSheet(values.media,values.group,round,batch.rows)},null,2));
            }else console.log(JSON.stringify(report,null,2));
        }
    }catch(e){console.error(e instanceof Error?e.message:"评测预检失败");process.exitCode=1;}
}
