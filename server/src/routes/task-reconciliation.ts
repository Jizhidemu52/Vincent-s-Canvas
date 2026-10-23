import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { Cache, Database } from "../db";
import type { AuthenticatedRequest } from "../types";
import { chatReconciliationSchema, listTaskReconciliation, reconcileChatReservation, reconcileTask, ReconciliationError, taskReconciliationSchema } from "../task-reconciliation";

export function createTaskReconciliationRouter(db: Database, cache: Cache) {
    const router = Router();
    router.use((request, response, next) => {
        response.setHeader("cache-control", "private, no-store");
        if ((request as AuthenticatedRequest).auth?.role !== "super_admin") {
            response.status(403).json({ code: "FORBIDDEN", data: null, msg: "只有超级管理员可以核查结算", error: "FORBIDDEN", message: "只有超级管理员可以核查结算" });
            return;
        }
        next();
    });
    router.get("/", async (request, response, next) => {
        try {
            const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
            response.json({ code: 0, data: await listTaskReconciliation(db, (request as AuthenticatedRequest).auth, limit), msg: "" });
        } catch (error) { next(error); }
    });
    router.post("/tasks/:id/resolve", async (request, response, next) => {
        try {
            const id = z.string().uuid().parse(request.params.id);
            const input = taskReconciliationSchema.parse(request.body);
            response.json({ code: 0, data: await reconcileTask(db, cache, id, { ...input, actor: (request as unknown as AuthenticatedRequest).auth, ip: request.ip }), msg: "" });
        } catch (error) { next(error); }
    });
    router.post("/chat/resolve", async (request, response, next) => {
        try {
            const input = chatReconciliationSchema.parse(request.body);
            response.json({ code: 0, data: await reconcileChatReservation(db, { ...input, actor: (request as AuthenticatedRequest).auth, ip: request.ip }), msg: "" });
        } catch (error) { next(error); }
    });
    router.use(((error, _request, response, next) => {
        if (error instanceof ReconciliationError || error instanceof z.ZodError) {
            const code = error instanceof ReconciliationError ? error.code : "INVALID_RECONCILIATION_INPUT";
            const message = error instanceof ReconciliationError ? error.message : "请填写有效的核查结论、理由和供应商证据编号";
            response.status(error instanceof ReconciliationError ? error.status : 400).json({ code, data: null, msg: message, error: code, message });
            return;
        }
        next(error);
    }) as ErrorRequestHandler);
    return router;
}
