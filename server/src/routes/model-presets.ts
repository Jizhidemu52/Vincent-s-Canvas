import {Router,type Request,type RequestHandler} from "express";
import {z} from "zod";
import {modelIdentities,modelFramings} from "../../../shared/model-match";
import {modelCatalog,personalPortrait,publishedPortrait,presetColumns} from "../model-library";
import type {Database} from "../db";
import type {ObjectStorage} from "../object-storage";
import type {AuthenticatedRequest} from "../types";
import {assertCanvasOwner,CanvasDocumentError} from "../canvas-document";
import {assertModuleEnabled} from "../module-flags";
import {withTransaction} from "../db-transaction";
import {writeAudit} from "../audit";
import {requireRole} from "../rbac";
import {streamAssetContent} from "../asset-delivery";

const actorOf=(request:Request)=>(request as AuthenticatedRequest).auth;
const uuid=z.string().uuid(),identity=z.enum(["white-woman","white-man","white-girl","white-boy"]);
const selected=z.union([z.object({assetId:uuid}).strict(),z.object({presetIdentity:identity}).strict(),z.object({}).strict()]);
const profile=z.object({name:z.string().trim().min(1).max(80),audience:z.enum(["women","men","girls","boys"])}).partial().strict().refine(v=>Object.keys(v).length>0);
const unavailable=()=>new CanvasDocumentError("MODEL_UNAVAILABLE","模特图不存在或不可用",404);
const adminColumns=presetColumns+',p.draft_asset_id AS "draftAssetId",p.status,(p.sort_order / 3) AS "sortOrder"';
function preview(db:Database,storage:ObjectStorage,admin:boolean):RequestHandler{
    return async(req,res,next)=>{try{
        const id=uuid.parse(req.params.id);
        const join=admin?"a.id=COALESCE(p.draft_asset_id,p.asset_id) AND a.metadata->>'source'='model-preset-library' AND a.kind='image' AND a.status='ready' AND a.deleted_at IS NULL":publishedPortrait;
        const found=(await db.query("SELECT a.filename,a.object_key,a.mime_type,a.thumbnail_256_key FROM model_presets p JOIN assets a ON "+join+" WHERE p.id=$1",[id])).rows[0];
        if(!found)throw unavailable();
        await streamAssetContent(req,res,storage,found.thumbnail_256_key?{filename:"portrait.webp",mime_type:"image/webp",object_key:found.thumbnail_256_key}:{filename:found.filename,mime_type:found.mime_type,object_key:found.object_key},{cacheControl:"no-store"});
    }catch(error){next(error);}};
}
export function createModelLibraryRouter(db:Database,storage:ObjectStorage){
    const router=Router();
    router.use(async(_req,_res,next)=>{try{await assertModuleEnabled(db,"canvas-tryout");next();}catch(error){next(error);}});
    router.get("/",async(req,res,next)=>{try{res.set("Cache-Control","private, no-store").json(await modelCatalog(db,actorOf(req).id));}catch(error){next(error);}});
    router.get("/presets/:id/thumb",preview(db,storage,false));
    router.put("/default",async(req,res,next)=>{try{
        const owner=actorOf(req).id;
        assertCanvasOwner(req.headers["x-canvas-owner-id"],owner);
        const input=selected.parse(req.body),asset="assetId" in input?input.assetId:null,group="presetIdentity" in input?input.presetIdentity:null;
        await withTransaction(db,async client=>{
            if(asset&&!(await client.query("SELECT a.id FROM assets a WHERE "+personalPortrait+" AND a.owner_user_id=$1 AND a.id=$2 AND a.metadata->>'audience' IN ('women','men','girls','boys') FOR SHARE",[owner,asset])).rows.length)throw unavailable();
            if(group&&!(await client.query("SELECT p.id FROM model_presets p JOIN assets a ON "+publishedPortrait+" WHERE p.identity=$1 FOR SHARE OF p,a",[group])).rows.length)throw unavailable();
            await client.query("INSERT INTO user_model_defaults(user_id,asset_id,preset_identity) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET asset_id=excluded.asset_id,preset_identity=excluded.preset_identity,updated_at=now()",[owner,asset,group]);
        });
        res.status(204).end();
    }catch(error){next(error);}});
    for(const method of ["patch","delete"] as const)router[method]("/mine/:id",async(req,res,next)=>{try{
        const owner=actorOf(req).id;
        assertCanvasOwner(req.headers["x-canvas-owner-id"],owner);
        const id=uuid.parse(req.params.id),change=method==="delete"?{tryoutArchived:true}:profile.parse(req.body);
        await withTransaction(db,async client=>{
            if(!(await client.query("UPDATE assets a SET metadata=metadata || $3::jsonb,updated_at=now() WHERE "+personalPortrait+" AND a.owner_user_id=$1 AND a.id=$2 RETURNING a.id",[owner,id,JSON.stringify(change)])).rows.length)throw unavailable();
            if(method==="delete")await client.query("UPDATE user_model_defaults SET asset_id=NULL,updated_at=now() WHERE user_id=$1 AND asset_id=$2",[owner,id]);
        });
        res.status(204).end();
    }catch(error){next(error);}});
    return router;
}
export function createAdminModelPresetsRouter(db:Database,storage:ObjectStorage){
    const router=Router();
    router.use(requireRole("super_admin"));
    router.get("/",async(_req,res,next)=>{try{res.set("Cache-Control","private, no-store").json({presets:(await db.query("SELECT "+adminColumns+" FROM model_presets p ORDER BY p.sort_order,p.identity,p.framing")).rows});}catch(error){next(error);}});
    router.get("/:id/thumb",preview(db,storage,true));
    router.patch("/identities/:identity",async(req,res,next)=>{try{
        const actor=actorOf(req),group=identity.parse(req.params.identity);
        assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
        const {name,sortOrder}=z.object({name:z.string().trim().min(1).max(80),sortOrder:z.number().int().min(0).max(999)}).strict().parse(req.body);
        await withTransaction(db,async client=>{
            await client.query("SELECT pg_advisory_xact_lock(hashtext('tryout-model:'||$1))",[group]);
            const rows=await client.query("UPDATE model_presets SET name=$2,sort_order=$3::int*3+CASE framing WHEN 'full' THEN 0 WHEN 'half' THEN 1 ELSE 2 END WHERE identity=$1 RETURNING id",[group,name,sortOrder]);
            if(!rows.rows.length)throw unavailable();
            await writeAudit(client,{actor,action:"model-preset.identity-updated",targetType:"model-preset",targetId:rows.rows[0].id,result:"success",detail:{identity:group,sortOrder}});
        });res.status(204).end();
    }catch(error){next(error);}});
    router.put("/:identity/:framing/draft",async(req,res,next)=>{try{
        const actor=actorOf(req);
        assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
        const group=identity.parse(req.params.identity),frame=z.enum(modelFramings).parse(req.params.framing),{assetId}=z.object({assetId:uuid}).strict().parse(req.body);
        const m=modelIdentities.find(x=>x.identity===group)!;
        const row=await withTransaction(db,async client=>{
            if(!(await client.query("SELECT id FROM assets WHERE id=$1 AND owner_user_id=$2 AND metadata->>'source'='model-preset-library' AND kind='image' AND status='ready' AND deleted_at IS NULL FOR SHARE",[assetId,actor.id])).rows.length)throw unavailable();
            await client.query("SELECT pg_advisory_xact_lock(hashtext('tryout-model:'||$1))",[group]);
            const previous=(await client.query("SELECT name,sort_order / 3 AS rank FROM model_presets WHERE identity=$1 LIMIT 1",[group])).rows[0];
            const result=(await client.query("INSERT INTO model_presets(identity,framing,name,audience,asset_id,draft_asset_id,sort_order) VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT(identity,framing) DO UPDATE SET draft_asset_id=excluded.draft_asset_id RETURNING id",[group,frame,previous?.name??m.name,m.audience,assetId,(previous?.rank??modelIdentities.indexOf(m))*3+modelFramings.indexOf(frame)])).rows[0];
            await writeAudit(client,{actor,action:"model-preset.staged",targetType:"model-preset",targetId:result.id,result:"success",detail:{identity:group,framing:frame}});
            return result;
        });res.json(row);
    }catch(error){next(error);}});
    for(const action of ["publish","hide"] as const)router.post("/:id/"+action,async(req,res,next)=>{try{
        const actor=actorOf(req),id=uuid.parse(req.params.id);
        assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
        const {expectedAssetId}=z.object({expectedAssetId:uuid}).strict().parse(req.body);
        await withTransaction(db,async client=>{
            const result=await client.query(action==="publish"?"UPDATE model_presets p SET asset_id=$2,draft_asset_id=NULL,status='published' WHERE id=$1 AND COALESCE(draft_asset_id,asset_id)=$2 AND EXISTS(SELECT 1 FROM assets a WHERE a.id=$2 AND a.metadata->>'source'='model-preset-library' AND a.kind='image' AND a.status='ready' AND a.deleted_at IS NULL) RETURNING id":"UPDATE model_presets SET status='hidden' WHERE id=$1 AND asset_id=$2 RETURNING id",[id,expectedAssetId]);
            if(!result.rows.length)throw new CanvasDocumentError("MODEL_REVIEW_CHANGED","模特版本已变更，请刷新后重新核对",409);
            await writeAudit(client,{actor,action:"model-preset."+action,targetType:"model-preset",targetId:id,result:"success",detail:{assetId:expectedAssetId}});
        });res.status(204).end();
    }catch(error){next(error);}});
    return router;
}
