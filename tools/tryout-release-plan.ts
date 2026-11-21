import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join} from "node:path";

export const paidCases=[
    {slot:1,group:"portrait-full",operation:"管理员高清全身",inputs:[],after:[],check:"只生成草稿；员工不可见；在隔离账号中审阅。"},
    {slot:2,group:"portrait-head",operation:"管理员同人头肩",inputs:[],after:[1],check:"参考图只有 01 的原始全身图，核对身份和取景；隔离库审核发布后供上身。"},
    {slot:3,group:"hat-color",operation:"帽体快速试色",inputs:["01-beanie.png"],after:[],check:"白底不扣费；有效松手只提交一次，首显与最终保存分别留时间及截图。"},
    {slot:4,group:"scarf-material",operation:"围脖快速换材质",inputs:["06-cowl.png"],after:[],check:"保留轮廓和原配色，只换表面质感。"},
    {slot:5,group:"wear",operation:"帽子上身",inputs:["01-beanie.png"],after:[2],check:"模特在前帽子在后，不令识别阻断受理；保存同一人、帽型、佩戴位置的对照图。"},
    {slot:6,group:"outfit",operation:"原上身加围脖",inputs:["06-cowl.png"],after:[5],check:"引用 05 对应的原模特与帽子，再加围脖，不把 05 的结果当参考图。"},
    {slot:7,group:"hd",operation:"上身高清与原单保存恢复",inputs:[],after:[5],check:"原位保留快速图，故障注入只发生在收到高清结果后的本地保存。恢复只取同一单，核对回执和原图。"},
    {slot:8,group:"batch-color",operation:"批量试色 · A",inputs:["11-rib-glove.png"],after:[],check:"和 09 一次发起，分别取得独立上游 ID 与结算回执，不共用素材。"},
    {slot:9,group:"batch-color",operation:"批量试色 · B",inputs:["16-striped-crew.png"],after:[],check:"核对袜筒条纹、单独节点与单独结算。"},
    {slot:10,group:"creative-original",operation:"创意设计优化不可用兜底",inputs:["41-knit-pullover.png"],after:[],check:"只在隔离环境让提示词优化不可用，按原文实际出图；刷新核对同一单和诊断文案。"},
] as const;

export async function preflightReleaseSamples(directory:string){
    const inputs=[...new Set(paidCases.flatMap(c=>[...c.inputs] as string[]))];
    const hashes=new Set<string>(),files=[];
    for(const name of inputs){
        const bytes=await readFile(join(directory,name));
        if(bytes.length<33||bytes.length>20*1024*1024||!bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"))||bytes.toString("ascii",12,16)!=="IHDR")throw new Error("输入不是可用 PNG："+name);
        const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),sha256=createHash("sha256").update(bytes).digest("hex");
        if(!width||!height||width*height>48e6||hashes.has(sha256))throw new Error("无效尺寸或重复输入："+name);
        hashes.add(sha256);files.push({name,width,height,sha256});
    }
    return {scope:"final-combined-candidate",mode:"preflight-only",paidSubmissions:0,budget:10,files,cases:paidCases};
}
if(import.meta.main){
    if(process.argv.length!==3)throw new Error("用法：bun tools/tryout-release-plan.ts <样品目录>；仅预检，不调用供应商");
    console.log(JSON.stringify(await preflightReleaseSamples(process.argv[2]!),null,2));
}
