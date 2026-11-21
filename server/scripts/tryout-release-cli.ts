import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {z} from "zod";
import {paidCases,preflightReleaseSamples} from "../../tools/tryout-release-plan";
import {releaseLedger,type ReleaseGroup} from "../../tools/tryout-release-ledger";
import {dispatchReleaseGroup} from "./tryout-release-request";
import {observeReleaseGroup} from "./tryout-release-observe";

const repo=resolve(import.meta.dir,"../..");
const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const settings=z.strictObject({commit:z.string().regex(/^[a-f\d]{40}$/),origin:z.string(),deploymentId:z.string().min(1).max(100),samples:z.string().min(1),outputs:z.string().min(1)});
export async function checkReleaseTarget(origin:string,commit:string){
    const url=new URL(origin);
    if(url.origin!==origin||!["127.0.0.1","[::1]"].includes(url.hostname)||!url.port||!["http:","https:"].includes(url.protocol))throw Error("只接受隔离回环站点");
    const get=(path:string)=>fetch(origin+path,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(5000)});
    const revision=await get("/revision.txt");
    if(!revision.ok||(await revision.text()).trim()!==commit)throw Error("隔离站点版本与待发布提交不一致");
    const health=await get("/api/health");
    if(!health.ok||(await health.json()).status!=="ok")throw Error("隔离 API、数据库或队列未就绪");
    const res=await get("/api/deployment");
    if(!res.ok)throw Error("未取得隔离部署配置");
    const flags=await res.json();
    if(!flags.authenticationEnabled||!flags.tryoutDisplayBeforeSave)throw Error("隔离部署未启用账号隔离或原图入库前预览");
}
async function run(args:string[]){
    const [action,file,name,payload,execute]=args;
    if(action==="plan"&&file&&args.length===2){console.log(JSON.stringify(await preflightReleaseSamples(file),null,2));return;}
    if(!file||!paidCases.some(c=>c.group===name)||!["ids","observe","submit"].includes(action??"")||
        (action==="ids"?args.length!==3:action==="submit"?args.length!==5||execute!=="--execute":args.length!==4))throw Error("用法：plan 样品目录；ids 配置 组；observe 配置 组 原请求JSON；submit 配置 组 原请求JSON --execute");
    const group=name as ReleaseGroup,config=settings.parse(JSON.parse(await readFile(file,"utf8")));
    const preflight=await preflightReleaseSamples(config.samples);
    if(git("rev-parse","HEAD")!==config.commit||git("status","--porcelain","--untracked-files=no")!=="")throw Error("工作区有未提交修改或不是冻结候选");
    await checkReleaseTarget(config.origin,config.commit);
    const path=join(git("rev-parse","--path-format=absolute","--git-common-dir"),"qa-receipts","tryout-combined-20261122-ten");
    const ledger=await releaseLedger(path,{commit:config.commit,origin:config.origin,deploymentId:config.deploymentId,sampleHashes:preflight.files.map(v=>v.sha256)});
    if(action==="ids"){console.log(JSON.stringify({group,ids:ledger.operationIds(group),paidThisCall:0}));return;}
    const session={cookie:process.env.TRYOUT_QA_COOKIE??"",owner:process.env.TRYOUT_QA_OWNER??""};
    const input=JSON.parse(await readFile(payload!,"utf8"));
    if(action==="observe"){console.log(JSON.stringify(await observeReleaseGroup(ledger,group,input,session,config.outputs)));return;}
    const result=await dispatchReleaseGroup(ledger,group,input,session);
    console.log(JSON.stringify({group,action:result.action,requestIds:result.requestIds,status:result.status??null,next:"observe"}));
}
if(import.meta.main)run(process.argv.slice(2)).catch(e=>{console.error(e instanceof z.ZodError?"配置或请求格式不符":e instanceof Error?e.message:"验收未完成");process.exitCode=1;});
