import history from "./try-on-review-history.json" with {type:"json"};
import {DEFAULT_RECIPE,framingFor,groups} from "./try-on-recipes";

export type ReviewPoint={group:string;variant:string;origin:"physical"|"synthetic";testedAt:string;sampleCount:number;reviewed:number;passed:number;score:number;stable:boolean;evidenceSha256:string};
export const currentRecipeRows=()=>groups.map(g=>({
    group:g.group,guard:g.guard,enabled:DEFAULT_RECIPE.enabled,framing:[...new Set(g.positions.map(framingFor))],
    inputMode:DEFAULT_RECIPE.inputMode,twoStep:DEFAULT_RECIPE.twoStep,complexity:DEFAULT_RECIPE.complexity,resolution:DEFAULT_RECIPE.resolution
}));
export function qualityReport(points:readonly ReviewPoint[]=history as ReviewPoint[]){
    const seen=new Set<string>(),keys=new Set(groups.map(g=>g.group));
    for(const p of points){
        if(!keys.has(p.group)||!["physical","synthetic"].includes(p.origin)||!p.variant||typeof p.stable!=="boolean"||!Number.isFinite(p.score)||p.score<0||p.score>5||p.sampleCount!==30||!Number.isInteger(p.reviewed)||p.reviewed<6||p.reviewed>30||!Number.isInteger(p.passed)||p.passed<0||p.passed>30||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.testedAt)||!Number.isFinite(Date.parse(p.testedAt))||new Date(p.testedAt).toISOString()!==p.testedAt||!/^[a-f\d]{64}$/.test(p.evidenceSha256)||seen.has(p.evidenceSha256))throw Error("上身评测摘要无效或回执重复");
        seen.add(p.evidenceSha256);
    }
    return currentRecipeRows().map(g=>({...g,reviews:points.filter(p=>p.group===g.group).sort((a,b)=>b.testedAt.localeCompare(a.testedAt)).map(p=>({origin:p.origin,variant:p.variant,testedAt:p.testedAt,score:p.score,passRate:p.passed/p.sampleCount,sampleCount:p.sampleCount,reviewed:p.reviewed,stable:p.stable}))}));
}
