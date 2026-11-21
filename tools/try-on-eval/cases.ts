import {framingFor,groups,type Framing} from "../../shared/try-on-recipes";
import {improvesBaseline,rankCandidates,summarize,type Evaluation} from "./score";

export type Variant={framing:Framing;inputMode:"original"|"cutout"|"crop-zoom";template:"brief"|"preserve"|"category";modelKey:"quick"|"hd";complexity:"low"|"medium";resolution:"1k"|"2k";twoStep:boolean;order:"model-first"|"product-first"};
export type Attempt={sampleId:string;modelIdentity:string;variant:string;repeat:number;settings:Variant};
type Round=1|2|3;
export function baseline(group:string):Variant{
    const found=groups.find(g=>g.group===group);
    if(!found)throw Error("未知品类");
    return {framing:framingFor(found.positions[0]),inputMode:"original",template:"preserve",modelKey:"quick",complexity:"low",resolution:"1k",twoStep:false,order:"model-first"};
}
export function variantKey(v:Variant){
    return [v.framing,v.inputMode,v.template,v.modelKey,v.complexity,v.resolution,v.twoStep?"two":"one",v.order].join("/");
}
export function round1Variants(base:Variant){
    const settings:Partial<Variant>[]=[...(["head","half","full"] as const).map(framing=>({framing})),{inputMode:"cutout"},{inputMode:"crop-zoom"},{template:"brief"},{template:"category"},{modelKey:"hd"},{complexity:"medium"},{resolution:"2k"},{twoStep:true},{order:"product-first"}];
    return [...new Map([base,...settings.map(s=>({...base,...s}))].map(v=>[variantKey(v),v])).values()];
}
const identity=(a:Pick<Attempt,"sampleId"|"modelIdentity"|"variant"|"repeat">)=>JSON.stringify([a.sampleId,a.modelIdentity,a.variant,a.repeat]);
export function buildRound(round:Round,variants:Variant[],samples:readonly string[],models:readonly string[]):Attempt[]{
    if(samples.length!==5||new Set(samples).size!==5||models.length!==2||new Set(models).size!==2||[...samples,...models].some(x=>!x.trim()))throw Error("每组须五件不同产品与两位不同模特");
    if(!variants.length||new Set(variants.map(variantKey)).size!==variants.length||(round===2&&variants.length>3)||(round===3&&variants.length!==1))throw Error("候选做法数量与轮次不符");
    return variants.flatMap(settings=>(round===1?samples.slice(0,2):samples).flatMap(sampleId=>(round===1?models.slice(0,1):models).flatMap(modelIdentity=>Array.from({length:round===3?3:1},(_,i)=>({sampleId,modelIdentity,variant:variantKey(settings),repeat:i+1,settings})))));
}
export function gradeRound(attempts:Attempt[],rows:Evaluation[]){
    const expected=new Map(attempts.map(a=>[identity(a),a]));
    if(!attempts.length||expected.size!==attempts.length||rows.length!==expected.size)throw Error("回执未覆盖整个计划");
    for(const r of rows){
        const a=expected.get(identity(r));
        if(!a||r.outputs!==(a.settings.twoStep?2:1))throw Error("样品、模特、做法、次数或出图数不符");
        expected.delete(identity(r));
    }
    return summarize(rows);
}
export function round2Variants(base:Variant,attempts:Attempt[],rows:Evaluation[]){
    const graded=gradeRound(attempts,rows),control=graded.find(g=>g.variant===variantKey(base));
    if(!control)throw Error("缺少基准");
    const improvements=graded.filter(g=>g!==control&&improvesBaseline(g.score,control.score)).sort((a,b)=>b.score-a.score||a.variant.localeCompare(b.variant));
    const choices:Partial<Variant>[]=[];
    for(const candidate of improvements){
        const v=attempts.find(a=>a.variant===candidate.variant)!.settings;
        const changes=(Object.keys(base) as (keyof Variant)[]).filter(k=>base[k]!==v[k]);
        if(changes.length!==1)throw Error("第一轮只能改一项");
        const key=changes[0]!;
        if(!choices.some(p=>key in p))choices.push({[key]:v[key]});
    }
    if(!choices.length)return [base];
    const combined=(changes:Partial<Variant>[]):Variant=>Object.assign({...base},...changes);
    return [...new Map([base,combined(choices.slice(0,1)),combined(choices)].map(v=>[variantKey(v),v])).values()];
}
export function round3Winner(attempts:Attempt[],rows:Evaluation[]){
    const best=rankCandidates(gradeRound(attempts,rows))[0]!;
    return attempts.find(a=>a.variant===best.variant)!.settings;
}
export function reviewCoverage(attempts:Attempt[],rows:Evaluation[]){
    const grades=gradeRound(attempts,rows);
    const reviewed=rows.filter(r=>r.reviewed).length;
    return {grades,reviewed,requiredReviews:Math.ceil(rows.length/5),reviewComplete:reviewed>=Math.ceil(rows.length/5)};
}
