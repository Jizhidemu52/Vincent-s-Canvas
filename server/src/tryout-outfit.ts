import type {Database} from "./db";
import {BillingError} from "./billing";
import {tryoutProductItems} from "./product-card-service";
import {wearPrompt} from "../../shared/tryout-prompts";
import type {outfitTryout} from "../../shared/tryout-submission";

export async function outfitRecipe(db:Pick<Database,"query">,owner:string,input:ReturnType<typeof outfitTryout.parse>,cards:boolean,lock:boolean){
    const origin=(await db.query(`SELECT source_urls,parameters->'tryoutModel' AS model,parameters->>'tryoutPresetId' AS preset FROM tasks
        WHERE id=$1 AND user_id=$2 AND project_id=$3 AND parameters->>'tryoutNodeId'=$4 AND parameters->>'tryoutKind'='wear'
        AND request_id LIKE $5 AND status='success'`+(lock?" FOR SHARE":""),[input.originTaskId,owner,input.canvasId,input.originNodeId,"tryout:"+owner+":%"])).rows[0];
    if(!origin||!Array.isArray(origin.source_urls)||origin.source_urls.length<2||typeof origin.model?.name!=="string")throw new BillingError("TRYOUT_OUTFIT_ORIGIN","找不到本画布上已完成的上身任务");
    const ids:string[]=origin.source_urls.map((url:string)=>{const id=/^\/api\/assets\/([0-9a-f-]{36})\/content$/i.exec(url)?.[1];if(!id)throw new BillingError("TRYOUT_REFERENCES","原上身参考图不可用");return id;});
    if(ids.length>=5)throw new BillingError("TRYOUT_OUTFIT_LIMIT","一套最多搭配四件产品，本次未提交");
    if(ids.includes(input.sourceAssetId))throw new BillingError("TRYOUT_OUTFIT_DUPLICATE","这张图已在搭配中，本次未提交");
    ids.push(input.sourceAssetId);
    const productIds=ids.slice(1),items=await tryoutProductItems(db,owner,productIds,cards),products=productIds.map(id=>items.get(id)??null);
    if(products.some(p=>p?.wearPosition==="none"))throw new BillingError("TRYOUT_NOT_WEARABLE","这件产品不适合上身，可修正产品卡");
    return {kind:"wear" as const,tier:"quick" as const,prompt:wearPrompt(products),ids,model:origin.model,presetId:typeof origin.preset==="string"?origin.preset:undefined,child:undefined};
}
