import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { ZodError } from "zod";
import type { ApiErrorCode } from "../../../shared/image-conversation-contracts";
import { eventSubscriptionQuerySchema, paginationQuerySchema, requestKeySchema, uuidSchema, versionListQuerySchema } from "../../../shared/image-conversation-schemas";
import type { Database } from "../db";
import { ImageConversationEvents, parseConversationEventCursor, streamConversationEvents } from "../image-conversation-events";
import {
  cancelImageConversationTurn, createImageConversation, getImageConversation, getImageConversationByRequest, getImageConversationTurn,
  listImageConversationMessages, listImageConversations, listImageConversationVersions, submitImageConversationTurn,
} from "../image-conversation-service";
import { ImageConversationError } from "../image-conversation-store";
import { toPublicImageConversationData } from "../image-conversation-public";
import type { AuthenticatedRequest } from "../types";

export const imageConversationBoundary: RequestHandler = (_request, response, next) => {
  response.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  const json = response.json.bind(response);
  response.json = body => {
    if (response.statusCode < 400 || !body || typeof body !== "object" || "code" in body) return json(toPublicImageConversationData(body));
    const code: ApiErrorCode = response.statusCode === 401 ? "UNAUTHENTICATED"
      : response.statusCode === 403 ? "ACCOUNT_NOT_READY" : response.statusCode === 429 ? "RATE_LIMITED"
        : response.statusCode === 404 ? "NOT_FOUND" : response.statusCode >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR";
    return json(toPublicImageConversationData({ code, data: null, msg: response.statusCode >= 500 ? "会话服务暂时不可用，请查询原请求后再操作" : typeof body.message === "string" ? body.message : "会话请求未完成" }));
  };
  next();
};

export const imageConversationErrors: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) { next(error); return; }
  if (error instanceof ImageConversationError) {
    response.status(error.status).json({ code: error.code, data: error.details, msg: error.message });
  } else if (error instanceof ZodError) {
    response.status(400).json({ code: "VALIDATION_ERROR", data: { fields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) }, msg: "会话请求格式不正确" });
  } else if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
    response.status(error.type === "entity.too.large" ? 413 : 400).json({ code: "VALIDATION_ERROR", data: null, msg: error.type === "entity.too.large" ? "会话请求超过大小限制" : "请求必须是有效 JSON" });
  } else {
    console.error(JSON.stringify({ event: "image_conversation.request_failed", name: error instanceof Error ? error.name : "UnknownError" }));
    response.status(500).json({ code: "INTERNAL_ERROR", data: null, msg: "会话请求未完成，请通过原请求编号查询，避免重复提交" });
  }
};

function queryNumber(value: unknown) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
}
function owner(request: Request) {
  const actor = (request as AuthenticatedRequest).auth;
  if (!actor) throw new ImageConversationError(401, "UNAUTHENTICATED", "请先登录");
  return uuidSchema.parse(actor.id);
}
const conversationId = (request: Request) => uuidSchema.parse(request.params.conversationId);
const turnId = (request: Request) => uuidSchema.parse(request.params.turnId);

export function createImageConversationsRouter(db: Database, options: {
  cursorSecret: string; events: ImageConversationEvents; acceptingNewTurns: () => boolean;
  wakeWorker: () => void; streamPollMs?: number; streamLifetimeMs?: number;
}) {
  const router = Router();
  const acceptsWrites = () => {
    if (!options.acceptingNewTurns()) throw new ImageConversationError(503, "SERVICE_UNAVAILABLE", "新会话暂未开放，已受理的任务仍可查询和停止");
  };
  const action = (run: (request: Request, response: Response, userId: string) => Promise<unknown>): RequestHandler => async (request, response, next) => {
    try {
      const data = await run(request, response, owner(request));
      if (!response.headersSent && !response.writableEnded) response.json({ code: "OK", data, msg: "" });
    } catch (error) { next(error); }
  };
  router.post("/", action(async (request, response, userId) => {
    acceptsWrites();
    const created = await createImageConversation(db, userId, request.body);
    response.status(created.replayed ? 200 : 201);
    options.events.wake(created.snapshot.id);
    return created.snapshot;
  }));
  router.get("/", action((request, _response, userId) => listImageConversations(db, userId,
    paginationQuerySchema.parse({ ...request.query, ...(request.query.limit !== undefined ? { limit: queryNumber(request.query.limit) } : {}) }), options.cursorSecret)));
  router.get("/by-request/:clientRequestId", action((request, _response, userId) => getImageConversationByRequest(db, userId, requestKeySchema.parse(request.params.clientRequestId))));
  router.get("/:conversationId", action((request, _response, userId) => getImageConversation(db, userId, conversationId(request))));
  router.post("/:conversationId/turns", action(async (request, response, userId) => {
    acceptsWrites();
    const id = conversationId(request);
    const accepted = await submitImageConversationTurn(db, userId, id, request.body);
    response.status(accepted.replayed ? 200 : 202);
    response.json({ code: "OK", data: accepted.result, msg: "" });
    options.events.wake(id);
    options.wakeWorker();
  }));
  router.get("/:conversationId/turns/by-request/:clientRequestId", action((request, _response, userId) => getImageConversationTurn(db, userId, conversationId(request), { clientRequestId: requestKeySchema.parse(request.params.clientRequestId) })));
  router.get("/:conversationId/turns/:turnId", action((request, _response, userId) => getImageConversationTurn(db, userId, conversationId(request), { turnId: turnId(request) })));
  router.post("/:conversationId/turns/:turnId/cancel", action(async (request, _response, userId) => {
    const id = conversationId(request);
    const result = await cancelImageConversationTurn(db, userId, id, turnId(request), request.body);
    options.events.wake(id);
    return result;
  }));
  router.get("/:conversationId/messages", action((request, _response, userId) => listImageConversationMessages(db, userId, conversationId(request),
    paginationQuerySchema.parse({ ...request.query, ...(request.query.limit !== undefined ? { limit: queryNumber(request.query.limit) } : {}) }), options.cursorSecret)));
  router.get("/:conversationId/versions", action((request, _response, userId) => listImageConversationVersions(db, userId, conversationId(request),
    versionListQuerySchema.parse({ ...request.query, ...(request.query.limit !== undefined ? { limit: queryNumber(request.query.limit) } : {}) }), options.cursorSecret)));
  router.get("/:conversationId/events", action(async (request, response, userId) => {
    eventSubscriptionQuerySchema.parse({ ...request.query, ...(request.query.afterSeq !== undefined ? { afterSeq: queryNumber(request.query.afterSeq) } : {}) });
    await streamConversationEvents({ db, events: options.events, ownerId: userId, conversationId: conversationId(request),
      afterSeq: parseConversationEventCursor(request), response, pollMs: options.streamPollMs, lifetimeMs: options.streamLifetimeMs });
  }));
  router.use((_request, response) => response.status(404).json({ code: "NOT_FOUND", data: null, msg: "会话接口不存在" }));
  router.use(imageConversationErrors);
  return router;
}
