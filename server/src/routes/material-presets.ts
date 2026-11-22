import {Router,type RequestHandler} from "express";
import {z} from "zod";
import type {Database} from "../db";
import type {AuthenticatedRequest} from "../types";
import {writeAudit} from "../audit";
import {withTransaction} from "../db-transaction";
import {requireRole} from "../rbac";
import {assertModuleEnabled} from "../module-flags";
import {assertCanvasOwner} from "../canvas-document";
import {ordinaryAsset} from "../tryout-private-assets";
import type {ObjectStorage} from "../object-storage";
import {streamAssetContent} from "../asset-delivery";

const columns='id,name,description,thumb_asset_id AS "thumbAssetId",status,sort_order AS "sortOrder"';
const fields=z.object({name:z.string().trim().min(1).max(80),description:z.string().trim().min(1).max(600),thumbAssetId:z.string().uuid().nullable(),status:z.enum(["published","hidden"]),sortOrder:z.number().int().min(-10000).max(10000)}).strict();
const create=fields.extend({thumbAssetId:fields.shape.thumbAssetId.default(null),status:fields.shape.status.default("published"),sortOrder:fields.shape.sortOrder.default(0)});
const edit=fields.partial().strict().refine(v=>Object.keys(v).length>0);
function samplePreview(db:Database,storage:ObjectStorage,admin=false):RequestHandler{
    return async(req,res,next)=>{try{
        if(!admin)await assertModuleEnabled(db,"canvas-tryout");
        const id=z.string().uuid().parse(req.params.id);
        const asset=(await db.query("SELECT a.object_key,a.filename,a.mime_type,a.thumbnail_256_key FROM material_presets p JOIN assets a ON a.id=p.thumb_asset_id WHERE p.id=$1 "+(admin?"":"AND p.status='published'")+" AND a.status='ready' AND a.kind='image' AND a.deleted_at IS NULL AND (a.metadata->>'source'='material-preset-library' OR (a.visibility_scope='company' AND "+ordinaryAsset("a")+"))",[id])).rows[0];
        if(!asset){res.sendStatus(404);return;}
        await streamAssetContent(req,res,storage,asset.thumbnail_256_key?{filename:"fabric.webp",mime_type:"image/webp",object_key:asset.thumbnail_256_key}:asset,{cacheControl:"no-store"});
    }catch(error){next(error);}};
}
export function createMaterialLibraryRouter(db:Database,storage:ObjectStorage){
    const router=Router();
    router.get("/presets/:id/thumb",samplePreview(db,storage));
    router.get("/",async(req,res,next)=>{
        try{
            await assertModuleEnabled(db,"canvas-tryout");
            const owner=(req as AuthenticatedRequest).auth.id;
            const [presets,mine]=await Promise.all([
                db.query("SELECT "+columns+" FROM material_presets WHERE status='published' ORDER BY sort_order,id"),
                db.query(`SELECT id,metadata->>'name' AS name,COALESCE(metadata->'useColor','false'::jsonb) AS "useColor" FROM assets WHERE owner_user_id=$1 AND metadata->>'source'='material-library' AND COALESCE(metadata->>'tryoutArchived','false')<>'true' AND kind='image' AND status='ready' AND deleted_at IS NULL ORDER BY created_at DESC,id`,[owner]),
            ]);
            res.json({presets:presets.rows,mine:mine.rows});
        }catch(error){next(error);}
    });
    const personal=z.object({name:fields.shape.name,useColor:z.boolean()}).strict(),uuid=z.string().uuid();
    for(const method of ["post","patch","delete"] as const)router[method](method==="post"?"/mine":"/mine/:id",async(req,res,next)=>{
        try{
            const actor=(req as AuthenticatedRequest).auth;
            assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
            await assertModuleEnabled(db,"canvas-tryout");
            const entry=method==="post"?personal.extend({assetId:uuid}).parse(req.body):undefined;
            const id=entry?.assetId??z.object({id:uuid}).parse(req.params).id;
            const data=entry?{name:entry.name,useColor:entry.useColor,tryoutArchived:false}:method==="delete"?{tryoutArchived:true}:personal.partial().refine(v=>Object.keys(v).length>0).parse(req.body);
            const found=await db.query(`UPDATE assets SET metadata=metadata || $3::jsonb,updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND metadata->>'source'='material-library' AND kind='image' AND status='ready' AND deleted_at IS NULL RETURNING id`,[id,actor.id,JSON.stringify(data)]);
            if(!found.rows.length){res.status(404).json({message:"个人材质不存在"});return;}
            if(method==="delete")res.status(204).end();else res.json({id});
        }catch(error){next(error);}
    });
    return router;
}
export function createAdminMaterialPresetsRouter(db:Database,storage:ObjectStorage){
    const router=Router();
    router.use(requireRole("super_admin"));
    router.get("/:id/thumb",samplePreview(db,storage,true));
    router.get("/",async(_req,res,next)=>{try{res.json({presets:(await db.query("SELECT "+columns+" FROM material_presets ORDER BY sort_order,id")).rows});}catch(error){next(error);}});
    for(const method of ["post","patch"] as const)router[method](method==="post"?"/":"/:id",async(req,res,next)=>{
        try{
            const actor=(req as AuthenticatedRequest).auth,id=method==="patch"?z.object({id:z.string().uuid()}).parse(req.params).id:null;
            assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
            const change=method==="post"?create.parse(req.body):edit.parse(req.body);
            const row=await withTransaction(db,async client=>{
                const previous=id?(await client.query("SELECT "+columns+" FROM material_presets WHERE id=$1 FOR UPDATE",[id])).rows[0]:null;
                if(id&&!previous)return null;
                const entry=fields.parse({...previous&&{name:previous.name,description:previous.description,status:previous.status,sortOrder:previous.sortOrder,thumbAssetId:previous.thumbAssetId},...change});
                if(entry.thumbAssetId){
                    const ok=await client.query("SELECT 1 FROM assets a WHERE id=$1 AND kind='image' AND status='ready' AND deleted_at IS NULL AND ((visibility_scope='company' AND "+ordinaryAsset("a")+") OR (metadata->>'source'='material-preset-library' AND (owner_user_id=$2 OR id=$3::uuid))) FOR SHARE",[entry.thumbAssetId,actor.id,previous?.thumbAssetId??null]);
                    if(!ok.rows.length)throw Object.assign(new Error("示意图必须是可供员工查看的公司图片"),{status:400});
                }
                const values=[entry.name,entry.description,entry.thumbAssetId,entry.status,entry.sortOrder];
                const saved=(await (id?client.query("UPDATE material_presets SET name=$1,description=$2,thumb_asset_id=$3,status=$4,sort_order=$5 WHERE id=$6 RETURNING "+columns,[...values,id])
                    :client.query("INSERT INTO material_presets(name,description,thumb_asset_id,status,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING "+columns,values))).rows[0];
                await writeAudit(client,{actor,action:id?"material-preset.updated":"material-preset.created",targetType:"material-preset",targetId:saved.id,result:"success",detail:{fields:Object.keys(change),status:entry.status}});
                return saved;
            });
            if(!row){res.status(404).json({message:"预设材质不存在"});return;}
            res.status(id?200:201).json({preset:row});
        }catch(error){next(error);}
    });
    return router;
}
