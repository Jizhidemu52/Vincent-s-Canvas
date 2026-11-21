import {expect,test} from "bun:test";
import {randomUUID} from "node:crypto";
import {downloadTryoutResult,openTryoutResult,sealTryoutResult} from "../src/tryout-result-receipt";

const owner=randomUUID(),key=Buffer.alloc(32,7).toString("base64"),address="https://cdn.example/original.png?ticket=private-fixture";
const task={id:randomUUID(),user_id:owner,request_id:"tryout:"+owner+":"+randomUUID(),tool_key:"canvas-edit",operation_type:"inpaint",parameters:{tryoutTier:"quick"},model_config_id:randomUUID(),upstream_task_id:"original-job"};
test("completion receipt is private, scoped to the original paid job, and expires",()=>{
    const now=100000,doc=sealTryoutResult(task,[address],key,now);
    expect(JSON.stringify(doc)).not.toContain("ticket");expect(openTryoutResult(task,doc,key,now)).toBe(address);
    for(const delta of [{id:randomUUID()},{user_id:randomUUID()},{upstream_task_id:"another-job"},{model_config_id:randomUUID()},{request_id:"ordinary"},{tool_key:"other"},{operation_type:"video_generation"}])expect(()=>openTryoutResult({...task,...delta},doc,key,now)).toThrow();
    expect(()=>openTryoutResult(task,doc,key,now+86400000)).toThrow();expect(()=>openTryoutResult(task,{...doc,sealed:"bad"},key,now)).toThrow();
    for(const urls of [[],[address,address],["file:///tmp/no"],["https://localhost/a"],["https://name:password@cdn.example/a"]])expect(()=>sealTryoutResult(task,urls,key)).toThrow();
});
test("unreadable originals never become displayable results or disclose signed URLs",async()=>{
    const doc=sealTryoutResult(task,[address],key);
    for(const fetch of [async()=>Buffer.from("not an image"),async()=>{throw new Error(address);}]){
        await expect(downloadTryoutResult(task,doc,key,fetch)).rejects.toMatchObject({code:"RESULT_DOWNLOAD_FAILED",message:"试款图已生成，未能下载原结果；只恢复本单，不会重新生成"});
    }
});
