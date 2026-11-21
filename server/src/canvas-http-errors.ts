import type {ErrorRequestHandler} from "express";
import {CanvasDocumentError} from "./canvas-document";

export const canvasHttpErrors:ErrorRequestHandler=(error,_request,response,next)=>{
    if(!(error instanceof CanvasDocumentError)||response.headersSent){next(error);return;}
    response.set("Cache-Control","no-store").status(error.status).json({error:error.code,message:error.message});
};
