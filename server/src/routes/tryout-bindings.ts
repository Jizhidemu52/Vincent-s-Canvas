import {Router} from "express";
import {z} from "zod";
import type {Database} from "../db";
import {withTransaction} from "../db-transaction";
import {requireRole} from "../rbac";
import type {AuthenticatedRequest} from "../types";
import {writeAudit} from "../audit";
import {assertCanvasOwner,CanvasDocumentError} from "../canvas-document";
import {assertTryoutImageModel,bindingColumns,listTryoutModels} from "../tryout-model-bindings";
import {tryoutSpeedReport} from "../tryout-speed";
import {qualityReport} from "../../../shared/try-on-quality";

export function createTryoutBindingsAdmin(db:Database){
    const router=Router();
    router.use(requireRole("super_admin"));
    router.get("/wear-quality",(_req,res)=>res.set("Cache-Control","private, no-store").json({groups:qualityReport()}));
    router.get("/speed",async(_req,res,next)=>{try{
        res.set("Cache-Control","private, no-store").json(await tryoutSpeedReport(db));
    }catch(e){next(e);}});
    router.get("/",async(_req,res,next)=>{try{
        const [slots,models]=await Promise.all([db.query("SELECT "+bindingColumns+" FROM tryout_model_bindings ORDER BY tier"),listTryoutModels(db)]);
        res.set("Cache-Control","no-store").json({bindings:slots.rows,models});
    }catch(e){next(e);}});
    router.put("/:tier",async(req,res,next)=>{try{
        const actor=(req as unknown as AuthenticatedRequest).auth,tier=z.enum(["quick","hd"]).parse(req.params.tier);
        assertCanvasOwner(req.headers["x-canvas-owner-id"],actor.id);
        const {modelConfigId,revision}=z.strictObject({modelConfigId:z.string().uuid().nullable(),revision:z.number().int().positive()}).parse(req.body);
        const binding=await withTransaction(db,async client=>{
            const slot=(await client.query("SELECT "+bindingColumns+" FROM tryout_model_bindings WHERE tier=$1 FOR UPDATE",[tier])).rows[0];
            if(!slot||slot.revision!==revision)throw new CanvasDocumentError("TRYOUT_BINDING_CHANGED","配置已被更改，请刷新后核对",409);
            if(modelConfigId)await assertTryoutImageModel(client,modelConfigId,true);
            if(slot.modelConfigId===modelConfigId)return slot;
            const saved=(await client.query("UPDATE tryout_model_bindings SET model_config_id=$2,revision=revision+1 WHERE tier=$1 RETURNING "+bindingColumns,[tier,modelConfigId])).rows[0];
            await writeAudit(client,{actor,action:"tryout-model-binding.updated",targetType:"tryout-model-binding",targetId:tier,result:"success",detail:{modelConfigId,revision:saved.revision}});
            return saved;
        });res.json({binding});
    }catch(e){next(e);}});
    return router;
}
