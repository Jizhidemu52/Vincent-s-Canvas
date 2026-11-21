import {expect,test} from "bun:test";
import {offlineReport,reviewedSnapshot} from "../../tools/try-on-eval";
import {qualityReport} from "../../shared/try-on-quality";
import {baseline,buildRound,round1Variants,variantKey} from "../../tools/try-on-eval/cases";
import type {Evaluation} from "../../tools/try-on-eval/score";

const base=baseline("帽子"),variants=round1Variants(base),samples=["01","02","03","04","05"],models=["adult-a","adult-b"];
const scores=(n:number)=>({style:n,color:n,detail:n,wear:n,natural:n});
const receipts=(as:ReturnType<typeof buildRound>):Evaluation[]=>as.map((a,i)=>({...a,outputs:a.settings.twoStep?2:1,elapsedMs:a.settings.resolution==="1k"?100:200,automatic:scores(a.settings.inputMode==="cutout"||a.settings.resolution==="2k"?4.6:4),...(i%5===0?{reviewed:scores(a.settings.inputMode==="cutout"||a.settings.resolution==="2k"?4.6:4)}:{})}));
test("round one isolates each variable; charges are counted per image, including a two-step output, never submitted",()=>{
    for(const v of variants)expect(Object.keys(v).filter(k=>v[k as keyof typeof v]!==base[k as keyof typeof v]).length).toBe(variantKey(v)===variantKey(base)?0:1);
    const r=offlineReport(1,false,[],true,"帽子");expect(r.paidSubmissions).toBe(0);expect(r.plannedImages).toBe(r.plannedJudgeCalls+2);
    expect(offlineReport(1,false,[],false).groups).toHaveLength(9);
});
test("advancement needs full receipts and human review, not repeated scores for one image",()=>{
    const one=receipts(buildRound(1,variants,samples,models)),data={round:1,group:"帽子",rows:one};
    expect(()=>offlineReport(2,false,[{...data,rows:one.slice(1)}],false,"帽子")).toThrow();
    expect(()=>offlineReport(2,false,[{...data,rows:[one[0]!,...one.slice(0,-1)]}],false,"帽子")).toThrow();
    expect(()=>offlineReport(2,false,[{...data,rows:one.map(r=>({...r,reviewed:undefined}))}],false,"帽子")).toThrow();
    const two=offlineReport(2,false,[data],true,"帽子").groups[0]!;
    expect(two.variants).toBe(3);expect(two.attempts).toBe(30);
    const records=[data,{round:2,group:"帽子",rows:receipts(two.cases!)}],three=offlineReport(3,false,records,true,"帽子").groups[0]!;
    expect(three.variants).toBe(1);expect(three.attempts).toBe(30);
    const report=offlineReport(3,true,[...records,{round:3,group:"帽子",rows:receipts(three.cases!)}],false,"帽子");
    expect(report.groups[0]?.grading?.grades[0]).toMatchObject({stable:true,count:30});
    const ready=[...records,{round:3,group:"帽子",rows:receipts(three.cases!)}];
    const point=reviewedSnapshot("帽子",ready,"synthetic","2026-11-21T00:00:00.000Z");
    expect(qualityReport([point])[0]?.reviews[0]).toMatchObject({origin:"synthetic",sampleCount:30,reviewed:6,stable:true});
    expect(qualityReport([]).every(g=>g.reviews.length===0)).toBe(true);
    expect(()=>qualityReport([point,{...point,origin:"physical"}])).toThrow();
    expect(()=>qualityReport([{...point,testedAt:"2026-11-31T00:00:00.000Z"}])).toThrow();
    expect(()=>offlineReport(3,true,records,false,"帽子")).toThrow();
});
