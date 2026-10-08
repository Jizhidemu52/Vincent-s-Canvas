import { Router, type ErrorRequestHandler } from "express";
import { z, ZodError } from "zod";
import type { Database } from "../db";
import type { AuthenticatedRequest } from "../types";
import { assertCanvasOwner, CanvasDocumentError } from "../canvas-document";
import { assertModuleEnabled, ModuleDisabledError } from "../module-flags";
import { referenceImportService, ReferenceImportError } from "../reference-import";

const scanInput = z.object({ url: z.string().trim().min(1).max(8192) }).strict();
const imageInput = z.object({ scanId: z.string().min(1).max(80), imageId: z.string().min(1).max(80) }).strict();
type ImportService = Pick<typeof referenceImportService, "scan" | "image">;
export class ReferenceImportRequestError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

/** Shared by the Express and local Bun entry points; never takes identity from the body. */
export async function runReferenceImportAction(ownerId: string | undefined, ownerHeader: unknown, action: "scan" | "image", body: unknown, signal?: AbortSignal, service: ImportService = referenceImportService) {
    if (!ownerId) throw new ReferenceImportRequestError("请先登录后再采集网页图片", 401);
    assertCanvasOwner(ownerHeader, ownerId);
    if (action === "scan") return service.scan(ownerId, scanInput.parse(body).url, signal);
    const input = imageInput.parse(body);
    return service.image(ownerId, input.scanId, input.imageId, signal);
}

export function referenceImportFailure(error: unknown) {
    const known = error instanceof ReferenceImportError || error instanceof ReferenceImportRequestError || error instanceof CanvasDocumentError || error instanceof ModuleDisabledError;
    const status = known ? error.status : error instanceof ZodError ? 400 : 500;
    const msg = known ? error.message : error instanceof ZodError ? "采集请求格式无效，请重新输入网页链接" : "网页采集暂时不可用，请稍后重试";
    return { status, body: { code: status, data: null, msg } };
}

/** The demo's global upload limit is large; this public-fetch entry accepts only small JSON. */
export async function readReferenceImportBody(request: Request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new ReferenceImportRequestError("采集请求必须使用 JSON", 415);
    if (Number(request.headers.get("content-length")) > 16384) throw new ReferenceImportRequestError("采集请求过大", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new ReferenceImportRequestError("采集请求为空");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16384) throw new ReferenceImportRequestError("采集请求过大", 413);
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new ReferenceImportRequestError("采集请求必须是有效的 JSON"); }
}

export const referenceImportBodyErrors: ErrorRequestHandler = (error, _request, response, next) => {
    if (!["entity.too.large", "entity.parse.failed"].includes(error?.type)) { next(error); return; }
    const failure = referenceImportFailure(new ReferenceImportRequestError(error.type === "entity.too.large" ? "采集请求过大" : "采集请求必须是有效的 JSON", error.type === "entity.too.large" ? 413 : 400));
    response.set("Cache-Control", "no-store").status(failure.status).json(failure.body);
};

export function createReferenceImportRouter(db: Database, service: ImportService = referenceImportService) {
    const router = Router();
    router.post(["/scan", "/image"], async (request, response) => {
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once("close", cancel);
        response.set("Cache-Control", "no-store");
        try {
            const ownerId = (request as AuthenticatedRequest).auth?.id;
            if (!ownerId) throw new ReferenceImportRequestError("请先登录后再采集网页图片", 401);
            assertCanvasOwner(request.get("X-Canvas-Owner-Id"), ownerId);
            if (!request.is("application/json")) throw new ReferenceImportRequestError("采集请求必须使用 JSON", 415);
            await assertModuleEnabled(db, "assets");
            const data = await runReferenceImportAction(ownerId, request.get("X-Canvas-Owner-Id"), request.path.replace(/\/$/, "") === "/scan" ? "scan" : "image", request.body, controller.signal, service);
            if (!controller.signal.aborted) response.json({ code: 0, data, msg: "" });
        } catch (error) {
            const failure = referenceImportFailure(error);
            if (!controller.signal.aborted) response.status(failure.status).json(failure.body);
        } finally { response.off("close", cancel); }
    });
    return router;
}
