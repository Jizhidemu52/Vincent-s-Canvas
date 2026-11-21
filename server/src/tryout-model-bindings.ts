import {MARK_GPT26_IMAGE_MODELS} from "../../shared/mark-image-models";
import type {Database} from "./db";
import {BillingError} from "./billing";
import {resolveToolExecution} from "./tool-configuration";
import {CanvasDocumentError} from "./canvas-document";

type Query=Pick<Database,"query">;
export type TryoutTier="quick"|"hd";
export type TryoutBinding={tier:TryoutTier;modelConfigId:string|null;revision:number};
export const bindingColumns='tier,model_config_id AS "modelConfigId",revision';
const modelIds=MARK_GPT26_IMAGE_MODELS.map(m=>m.modelId);
const supported="p.enabled AND m.enabled AND p.protocol='apimart' AND m.workflow_config_id IS NULL AND 'edit'=ANY(m.capabilities) AND m.model_id=ANY($1::text[])";
export async function listTryoutModels(db:Query){
    return (await db.query<{id:string;name:string;provider:string;modelId:string}>(`SELECT m.id,m.name,p.name AS provider,m.model_id AS "modelId" FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE ${supported} ORDER BY p.name,m.name,m.id`,[modelIds])).rows;
}
export async function assertTryoutImageModel(db:Query,id:string,lock=false){
    const model=await db.query("SELECT m.id FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE "+supported+" AND m.id=$2"+(lock?" FOR SHARE OF m,p":""),[modelIds,id]);
    if(!model.rows.length)throw new BillingError("TRYOUT_MODEL_UNAVAILABLE","当前绑定不支持试款参数或已停用，未提交任务");
}
export async function resolveTryoutBinding(db:Query,tier:TryoutTier,lock=false){
    const binding=(await db.query<TryoutBinding>("SELECT "+bindingColumns+" FROM tryout_model_bindings WHERE tier=$1"+(lock?" FOR SHARE":""),[tier])).rows[0];
    if(!binding)throw new CanvasDocumentError("TRYOUT_BINDING_MISSING","试款模型配置尚未就绪",503);
    if(tier==="hd"&&!binding.modelConfigId)throw new CanvasDocumentError("TRYOUT_HD_NOT_CONFIGURED","尚未配置高清模型，快速档图片不变，本次未扣费",409);
    if(lock)await db.query("SELECT tool_key FROM tool_api_configurations WHERE tool_key IN ('canvas','canvas-edit') ORDER BY tool_key FOR SHARE");
    const base=await resolveToolExecution(db,{toolKey:"canvas-edit",operationType:"inpaint",modelConfigId:binding.modelConfigId},{allowModelOverride:binding.modelConfigId!==null});
    await assertTryoutImageModel(db,base.modelConfigId,lock);
    return {binding,execution:base};
}
