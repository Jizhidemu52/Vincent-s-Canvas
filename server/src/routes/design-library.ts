import { Router, type ErrorRequestHandler, type RequestHandler, type Response } from "express";
import type { AuthenticatedRequest } from "../types";
import {
    DesignLibraryError, DesignLibraryService, designLibraryFailure,
    type DesignLibraryActor, type LibraryImageRecord,
} from "../design-library";

/** Register before sessionMiddleware: an off-mode request must never provision a guest. */
export function designLibraryBoundary(enabled: boolean): RequestHandler {
    return (_request, response, next) => {
        response.set("Cache-Control", "private, no-store");
        response.set("X-Content-Type-Options", "nosniff");
        // Existing authentication middleware has a legacy error shape; preserve its
        // status/meaning while keeping this new API's documented envelope consistent.
        const json = response.json.bind(response);
        response.json = body => {
            if (response.statusCode >= 400 && body && typeof body === "object" && !("code" in body)) {
                return json({ code: response.statusCode, error: typeof body.error === "string" ? body.error : "REQUEST_FAILED",
                    msg: typeof body.message === "string" ? body.message : "灵感库请求失败" });
            }
            return json(body);
        };
        if (!enabled) {
            const failure = designLibraryFailure(new DesignLibraryError("OA_REQUIRED", "公司设计灵感库仅在 OA 企业模式下开放；试用模式不使用真实员工身份", 403));
            response.status(failure.status).json(failure.body);
            return;
        }
        next();
    };
}

export const designLibraryBodyErrors: ErrorRequestHandler = (error, _request, response, next) => {
    if (!["entity.too.large", "entity.parse.failed"].includes(error?.type)) { next(error); return; }
    const large = error.type === "entity.too.large";
    const failure = designLibraryFailure(new DesignLibraryError(large ? "REQUEST_TOO_LARGE" : "INVALID_JSON",
        large ? "分享请求超过大小限制，请减少文字或标签" : "分享请求必须是有效的 JSON", large ? 413 : 400));
    response.status(failure.status).json(failure.body);
};

function actorFromRequest(request: AuthenticatedRequest, admin: boolean): DesignLibraryActor {
    const user = request.auth;
    if (!user || request.allowsAnonymousCreation) throw new DesignLibraryError("OA_IDENTITY_REQUIRED", "请通过公司 OA 员工入口登录", 401);
    if (admin ? !["super_admin", "department_admin"].includes(user.role) : user.role !== "designer") {
        throw new DesignLibraryError("FORBIDDEN", "当前入口不允许此账号执行操作", 403);
    }
    return { id: user.id, name: user.displayName, role: user.role, departmentId: user.departmentId, departmentName: user.departmentName, kind: admin ? "admin" : "employee" };
}

function sendImage(response: Response, result: { bytes: Uint8Array; image: LibraryImageRecord }, download: boolean) {
    response.set("Content-Type", result.image.mimeType);
    response.set("Content-Length", String(result.bytes.byteLength));
    response.set("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(result.image.filename)}`);
    response.set("Content-Security-Policy", "default-src 'none'; sandbox");
    response.send(Buffer.from(result.bytes));
}

/** Requires the real OA session middleware (or strict admin session middleware) at mount. */
export function createDesignLibraryRouter(service: DesignLibraryService, options: { admin?: boolean } = {}) {
    const router = Router();
    const admin = options.admin === true;
    router.use((request, response, next) => {
        response.set("Cache-Control", "private, no-store");
        response.set("X-Content-Type-Options", "nosniff");
        try {
            const actor = actorFromRequest(request as AuthenticatedRequest, admin);
            if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.get("X-Canvas-Owner-Id") !== actor.id) {
                throw new DesignLibraryError("CANVAS_OWNER_MISMATCH", "当前员工身份已变化，请重新打开工作区后再试", 403);
            }
            response.locals.designLibraryActor = actor;
            next();
        } catch (error) { const failure = designLibraryFailure(error); response.status(failure.status).json(failure.body); }
    });
    const action = (run: (request: Parameters<RequestHandler>[0], response: Response, actor: DesignLibraryActor) => Promise<unknown>): RequestHandler =>
        async (request, response) => {
            try {
                const data = await run(request, response, response.locals.designLibraryActor);
                if (!response.headersSent) response.json({ code: 0, data, msg: "" });
            } catch (error) {
                const failure = designLibraryFailure(error);
                if (!response.headersSent) response.status(failure.status).json(failure.body);
            }
        };
    router.get("/", action((request, _response, actor) => service.list(actor, request.query)));
    router.get("/:id", action(async (request, _response, actor) => ({ entry: await service.detail(actor, String(request.params.id)) })));
    router.get("/:id/stats", action((request, _response, actor) => service.stats(actor, String(request.params.id), request.query)));
    router.get("/:id/images/:imageId/content", action(async (request, response, actor) => {
        sendImage(response, await service.image(actor, String(request.params.id), String(request.params.imageId)), false);
    }));
    if (admin) {
        router.post("/:id/moderate", action(async (request, _response, actor) => ({ entry: await service.moderate(actor, String(request.params.id), request.body) })));
    } else {
        router.post("/", action(async (request, _response, actor) => ({ entry: await service.publish(actor, request.body) })));
        router.post("/:id/withdraw", action(async (request, _response, actor) => ({ entry: await service.withdraw(actor, String(request.params.id)) })));
        router.post("/:id/images/:imageId/download", action(async (request, response, actor) => {
            sendImage(response, await service.download(actor, String(request.params.id), String(request.params.imageId), request.body), true);
        }));
        router.post("/:id/images/:imageId/reuse", action((request, _response, actor) => service.reuse(actor, String(request.params.id), String(request.params.imageId), request.body)));
        router.post("/:id/events", action((request, _response, actor) => service.receipt(actor, String(request.params.id), request.body)));
    }
    return router;
}
