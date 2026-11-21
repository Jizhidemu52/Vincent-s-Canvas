import {expect,test} from "bun:test";
import {paidCases} from "../tryout-release-plan";
test("combined release has exactly ten paid outputs, backward-only dependencies and one two-output batch",()=>{
    expect(paidCases.map(c=>c.slot)).toEqual(Array.from({length:10},(_,i)=>i+1));
    for(const c of paidCases)expect(c.after.every(i=>i>=1&&i<c.slot)).toBe(true);
    expect(paidCases.filter(c=>c.group==="batch-color").map(c=>c.slot)).toEqual([8,9]);
    expect(paidCases.filter(c=>c.after.some(i=>i===5)).map(c=>c.slot)).toEqual([6,7]);
});
