export const dimensions=["style","color","detail","wear","natural"] as const;
export type Scores=Record<typeof dimensions[number],number>;
export function evaluate(scores:Scores){
    const values=dimensions.map(k=>scores[k]);
    if(values.some(x=>!Number.isFinite(x)||x<0||x>5))throw new Error("五项评分必须齐全且在 0–5 之间");
    const score=values.reduce((a,b)=>a+b,0)/5;
    return {score,pass:score>=4&&scores.style>=4&&scores.wear>=4};
}
export type Evaluation={sampleId:string;modelIdentity:string;variant:string;repeat:number;outputs:1|2;elapsedMs:number;automatic:Scores;reviewed?:Scores};
export function summarize(rows:Evaluation[]){
    const keys=new Set<string>(),variants=new Map<string,Evaluation[]>();
    for(const row of rows){
        const key=JSON.stringify([row.sampleId,row.modelIdentity,row.variant,row.repeat]);
        if(!row.sampleId||!row.modelIdentity||!row.variant||!Number.isInteger(row.repeat)||row.repeat<1||keys.has(key)||![1,2].includes(row.outputs)||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0)throw new Error("重复或无效的试验回执");
        keys.add(key);evaluate(row.automatic);if(row.reviewed)evaluate(row.reviewed);
        variants.set(row.variant,[...(variants.get(row.variant)??[]),row]);
    }
    return [...variants.entries()].map(([variant,samples])=>{
        const graded=samples.map(r=>evaluate(r.reviewed??r.automatic)),count=samples.length,reviewed=samples.filter(r=>r.reviewed);
        const pairs=new Map<string,boolean[]>();samples.forEach((r,i)=>{const k=JSON.stringify([r.sampleId,r.modelIdentity]);pairs.set(k,[...(pairs.get(k)??[]),graded[i]!.pass]);});
        return {variant,count,score:graded.reduce((n,g)=>n+g.score,0)/count,passRate:graded.filter(g=>g.pass).length/count,outputs:samples.reduce((n,r)=>n+r.outputs,0)/count,elapsedMs:samples.reduce((n,r)=>n+r.elapsedMs,0)/count,reviewed:reviewed.length,
            stable:[...pairs.values()].every(v=>v.length===3&&v.filter(Boolean).length>=2)};
    });
}
export const improvesBaseline=(candidate:number,baseline:number)=>Math.round((candidate-baseline)*1000)>=300;
export function rankCandidates(rows:ReturnType<typeof summarize>){
    const sorted=[...rows].sort((a,b)=>b.score-a.score||a.variant.localeCompare(b.variant));
    if(!sorted.length)return [];
    const highest=sorted[0]!.score,near=sorted.filter(r=>Math.round((highest-r.score)*1000)<200);
    return [...near.sort((a,b)=>a.outputs-b.outputs||a.elapsedMs-b.elapsedMs||b.score-a.score||a.variant.localeCompare(b.variant)),...sorted.filter(r=>!near.includes(r))];
}
