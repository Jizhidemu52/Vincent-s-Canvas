import type { NextFunction, Request, Response } from "express";
import type { Cache } from "./db";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireSameOrigin(request: Request, response: Response, next: NextFunction) {
    if (SAFE_METHODS.has(request.method)) {
        next();
        return;
    }

    const origin = request.get("origin");
    if (!origin) {
        next();
        return;
    }

    try {
        if (new URL(origin).host !== request.get("host")) {
            response.status(403).json({ error: "INVALID_ORIGIN", message: "拒绝跨站写请求" });
            return;
        }
    } catch {
        response.status(403).json({ error: "INVALID_ORIGIN", message: "请求来源无效" });
        return;
    }

    next();
}

export function rateLimit(cache: Cache, input: {
    prefix: string;
    limit: number;
    windowSeconds: number;
    key?: (request: Request) => string;
}) {
    return async (request: Request, response: Response, next: NextFunction) => {
        try {
            const key = `rate:${input.prefix}:${input.key?.(request) ?? request.ip}`;
            const count = await cache.incr(key);
            if (count === 1) {
                await cache.expire(key, input.windowSeconds);
            }
            if (count > input.limit) {
                response.setHeader("retry-after", String(input.windowSeconds));
                response.status(429).json({ error: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" });
                return;
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}
