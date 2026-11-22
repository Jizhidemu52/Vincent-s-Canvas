import type {Database} from "./db";
import {CanvasDocumentError} from "./canvas-document";
import {pickModel,type ModelSelection,type PersonalModel,type ModelDefault,type ModelPreset} from "../../shared/model-match";
import type {ProductCardItem} from "../../shared/product-card";

type Query=Pick<Database,"query">;
const ready="a.kind='image' AND a.status='ready' AND a.deleted_at IS NULL";
export const publishedPortrait=`p.asset_id=a.id AND p.status='published' AND a.metadata->>'source'='model-preset-library' AND ${ready}`;
export const customPortrait=`a.metadata->>'source'='company-model-library' AND a.metadata->'companyPreset'->>'status'='published' AND ${ready}`;
export const allowedPreset=(param:string)=>`((a.id=${param} AND ${customPortrait}) OR EXISTS(SELECT 1 FROM model_presets p WHERE p.id=${param} AND ${publishedPortrait}))`;
export const customModelFields="a.id,a.metadata->'companyPreset'->>'name' AS name,a.metadata->'companyPreset'->>'description' AS description,a.metadata->'companyPreset'->>'status' AS status";
export const personalPortrait=`a.metadata->>'source'='model-library' AND COALESCE(a.metadata->>'tryoutArchived','false')<>'true' AND ${ready}`;
export const presetColumns='p.id,p.identity,p.name,p.audience,p.framing,p.asset_id AS "assetId"';
export async function modelCatalog(db:Query,owner:string){
    const [presets,mine,pref,custom]=await Promise.all([
        db.query<ModelPreset>(`SELECT ${presetColumns} FROM model_presets p JOIN assets a ON ${publishedPortrait} ORDER BY p.sort_order,p.identity,p.framing`),
        db.query<PersonalModel>(`SELECT a.id,coalesce(NULLIF(a.metadata->>'name',''),a.filename) AS name,a.metadata->>'audience' AS audience FROM assets a WHERE ${personalPortrait} AND a.owner_user_id=$1 AND a.metadata->>'audience' IN ('women','men','girls','boys') ORDER BY a.created_at DESC,a.id`,[owner]),
        db.query<ModelDefault>('SELECT preset_identity AS "presetIdentity",asset_id AS "assetId",last_child AS "lastChild" FROM user_model_defaults WHERE user_id=$1',[owner]),
        db.query(`SELECT ${customModelFields} FROM assets a WHERE ${customPortrait} ORDER BY a.created_at,a.id`),
    ]);
    return {presets:presets.rows,mine:mine.rows,custom:custom.rows,preference:pref.rows[0]??{}};
}
export async function resolvePortrait(db:Query,owner:string,input:ModelSelection,item:ProductCardItem|null){
    let choice:{assetId:string}|{presetId:string}|null;
    if("auto" in input){const c=await modelCatalog(db,owner);choice=pickModel(c.presets,item,c.preference,c.mine);}
    else if("presetIdentity" in input){
        const rows=(await db.query<ModelPreset>(`SELECT ${presetColumns} FROM model_presets p JOIN assets a ON ${publishedPortrait} WHERE p.identity=$1`,[input.presetIdentity])).rows;
        const group=rows[0]?.audience;
        choice=group?pickModel(rows,{audience:group==="girls"||group==="boys"?"kids":group,wearPosition:item?.wearPosition??"full"},{presetIdentity:input.presetIdentity}):null;
    }else choice=input;
    if(!choice)throw new CanvasDocumentError("TRYOUT_MODEL_EMPTY","暂无匹配的已发布模特，可上传自己的模特图",409);
    if("presetId" in choice){
        const custom=(await db.query(`SELECT ${customModelFields} FROM assets a WHERE a.id=$1 AND ${customPortrait}`,[choice.presetId])).rows[0];
        if(custom)return {assetId:custom.id as string,presetId:custom.id as string,name:custom.name as string,audience:null};
        const p=(await db.query<ModelPreset>(`SELECT ${presetColumns} FROM model_presets p JOIN assets a ON ${publishedPortrait} WHERE p.id=$1`,[choice.presetId])).rows[0];
        if(!p)throw new CanvasDocumentError("TRYOUT_PRESET_UNAVAILABLE","该模特图已变更或下架，未提交任务",409);
        return {assetId:p.assetId,presetId:p.id,name:p.name,audience:p.audience};
    }
    const mine=(await db.query<{name:string;audience:string|null}>("SELECT COALESCE(NULLIF(metadata->>'name',''),filename) AS name,metadata->>'audience' AS audience FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL AND COALESCE(metadata->>'tryoutArchived','false')<>'true' AND COALESCE(metadata->>'source','') NOT IN ('model-preset-library','material-library','material-preset-library','company-model-library')",[choice.assetId,owner])).rows[0];
    if(!mine)throw new CanvasDocumentError("TRYOUT_ASSET_UNAVAILABLE","模特图不可用或不属于当前员工",404);
    return {assetId:choice.assetId,presetId:null,name:mine.name.slice(0,80),audience:mine.audience};
}
export async function lockPreset(db:Query,preset:string,asset:string){
    if(preset===asset&&(await db.query(`SELECT a.id FROM assets a WHERE a.id=$1 AND ${customPortrait} FOR SHARE`,[asset])).rows.length)return;
    const row=await db.query(`SELECT p.id FROM model_presets p JOIN assets a ON ${publishedPortrait} WHERE p.id=$1 AND a.id=$2 FOR SHARE OF p,a`,[preset,asset]);
    if(!row.rows.length)throw new CanvasDocumentError("TRYOUT_PRESET_CHANGED","已选模特图已被替换或下架，未提交任务",409);
}
