import {expect,test} from "bun:test";
import {recipeFor} from "../../shared/try-on-recipes";
import {wearPrompt} from "../../shared/tryout-prompts";
import type {WearPosition} from "../../shared/product-card";
import {evaluate,improvesBaseline,rankCandidates,summarize,type Evaluation} from "../../tools/try-on-eval/score";

test("small-item baseline uses the observed placement and never treats an untested category as paid two-step or measured",()=>{
    const items:[string,WearPosition,string][]=[["棒球帽","head","帽子"],["针织围脖","neck","围脖与围巾"],["连指手套","hand","手套"],["中筒袜","foot","袜子"],["托特包","hand","包"],["发箍","head","腰带与小配件"],["earrings","head","首饰"],["皮靴","foot","鞋"],["连帽外套","upper","大件对照"],["spring fabric","hand","通用"]];
    for(const [category,wearPosition,group] of items)expect(recipeFor({category,wearPosition})).toMatchObject({group,enabled:true,twoStep:false,score:null,passRate:null});
    const p=wearPrompt([{category:"帽子",wearPosition:"head"},{category:"托特包",wearPosition:"hand"}]);
    expect(p).toContain("图片2中实际存在的细节");expect(p).toContain("提起图片3的托特包");expect(p).toContain("不互相混合");
    expect(recipeFor(null)).toMatchObject({group:"通用",framing:"full"});
});
test("scoring includes human corrections, counts each retry exactly once, gates style and fit separately and uses cost to break near ties",()=>{
    const top={style:5,color:5,detail:5,wear:5,natural:5},bad={...top,wear:3};
    expect(evaluate(bad)).toEqual({score:4.6,pass:false});
    expect(()=>evaluate({...top,style:NaN})).toThrow();expect(improvesBaseline(4.3,4)).toBe(true);expect(improvesBaseline(4.29,4)).toBe(false);
    const rows:Evaluation[]=[1,2,3].map(repeat=>({sampleId:"01",modelIdentity:"woman",variant:"a",repeat,outputs:1,elapsedMs:500,automatic:top,...(repeat===1?{reviewed:bad}:{})}));
    expect(summarize(rows)[0]).toMatchObject({stable:true,reviewed:1,passRate:2/3});expect(summarize(rows.slice(1))[0]?.stable).toBe(false);
    expect(()=>summarize([...rows,rows[0]!])).toThrow();
    const one=summarize(rows)[0]!;
    expect(rankCandidates([{...one,score:4.1,variant:"quick"},{...one,score:4.29,outputs:2,variant:"double"}])[0]?.variant).toBe("quick");
    expect(rankCandidates([{...one,score:4.1,variant:"quick"},{...one,score:4.3,outputs:2,variant:"double"}])[0]?.variant).toBe("double");
});
