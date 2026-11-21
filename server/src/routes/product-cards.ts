import {Router,type Request} from "express";
import {z} from "zod";
import {assertCanvasOwner} from "../canvas-document";
import type {AuthenticatedRequest} from "../types";
import type {createProductCards} from "../product-card-service";
import {productCardSchema} from "../../../shared/product-card-schema";
const session=(req:Request)=>req as AuthenticatedRequest;
const ownerId=(req:Request)=>session(req).auth.id;
export function createProductCardRouter(cards:ReturnType<typeof createProductCards>){
    const r=Router();
    r.route("/:id/product-card").all((req,res,next)=>{
        try{if(session(req).allowsAnonymousCreation){res.sendStatus(403);return;}assertCanvasOwner(req.headers["x-canvas-owner-id"],ownerId(req));z.string().uuid().parse(req.params.id);res.setHeader("cache-control","private, no-store");next();}catch(e){next(e);}
    }).get(async(req,res,next)=>{try{res.json(await cards.read(ownerId(req),req.params.id));}catch(e){next(e);}})
      .post(async(req,res,next)=>{try{z.strictObject({}).parse(req.body??{});const result=await cards.start(ownerId(req),req.params.id);res.status(result.status==="pending"?202:200).json(result);}catch(e){next(e);}})
      .put(async(req,res,next)=>{try{res.json(await cards.save(ownerId(req),req.params.id,productCardSchema.parse(req.body)));}catch(e){next(e);}});
    return r;
}
