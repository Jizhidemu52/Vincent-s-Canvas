import {createHash} from "node:crypto";
import {z} from "zod";
import {outfitTryout,refineTryout,tryoutBatch,tryoutSubmission} from "../../shared/tryout-submission";
import {portraitOrder} from "../src/model-preset-generation";
import type {ReleaseGroup,releaseLedger} from "../../tools/tryout-release-ledger";

const uuid=z.string().uuid();
const creative=z.object({requestId:uuid,projectId:z.string().min(1),toolKey:z.literal("creative-garment-colorway"),operationType:z.literal("inpaint"),modelConfigId:uuid,prompt:z.string().min(1),promptInput:z.object({scene:z.literal("garment-colorway"),mode:z.literal("edit"),userText:z.string().min(1),fields:z.record(z.string(),z.unknown()),referenceRoles:z.array(z.string()).length(1)}).strict(),sourceUrls:z.tuple([z.string().regex(/^\/api\/assets\/[a-f0-9-]{36}\/content$/i)]),parameters:z.strictObject({size:z.literal("1:1").optional(),resolution:z.literal("1k"),quality:z.enum(["low","medium"]),n:z.literal(1),count:z.literal(1),output_format:z.literal("png")})}).strict();
type Ledger=Awaited<ReturnType<typeof releaseLedger>>;
function check(ok:boolean){if(!ok)throw Error("请求与锁定的十单清单不一致");}
export function paidReleaseRoute(group:ReleaseGroup,ids:string[],input:unknown){
    if(group==="portrait-full"||group==="portrait-head"){
        const p=portraitOrder.parse(input),s=p.slots[0]!;
        check(p.confirmedCount===1&&p.requestId===ids[0]&&s.identity==="white-woman"&&s.framing===(group==="portrait-full"?"full":"head"));
        return "/api/admin/model-presets/generation";
    }
    if(group==="creative-original"){
        const c=creative.parse(input);check(c.requestId===ids[0]&&c.promptInput.userText===c.prompt);return "/api/tasks";
    }
    if(group==="batch-color"){
        const b=tryoutBatch.parse(input);check(b.items.length===2&&b.items.every((v,i)=>v.kind==="color"&&v.requestId===ids[i]));
        return "/api/tryout/quick/batch";
    }
    if(group==="hd")refineTryout.parse(input);
    else if(group==="outfit"){check(outfitTryout.parse(input).requestId===ids[0]);}
    else{const p=tryoutSubmission.parse(input);check(p.requestId===ids[0]&&p.tier==="quick"&&p.kind===({"hat-color":"color","scarf-material":"material",wear:"wear"} as const)[group]);}
    return "/api/tryout/quick";
}
export async function dispatchReleaseGroup(ledger:Ledger,group:ReleaseGroup,input:unknown,session:{cookie:string;owner:string}){
    if(!session.cookie||/[\r\n]/.test(session.cookie))throw Error("缺少有效的隔离会话");
    uuid.parse(session.owner);
    const ids=ledger.operationIds(group),body=JSON.stringify(input),path=paidReleaseRoute(group,ids,JSON.parse(body));
    const claim=await ledger.claim(group,createHash("sha256").update(body).digest("hex"));
    if(claim.action==="query-only")return {action:claim.action,requestIds:ids};
    const response=await fetch(ledger.origin+path,{method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),headers:{cookie:session.cookie,origin:ledger.origin,"Content-Type":"application/json","X-Canvas-Owner-Id":session.owner},body});
    return {action:claim.action,requestIds:ids,status:response.status,receipt:await response.json()};
}
