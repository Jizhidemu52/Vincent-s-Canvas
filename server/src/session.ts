import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config";
import type { Cache, Database } from "./db";
import { hashToken } from "./security";
import type { AuthenticatedRequest } from "./types";
import { mapUser, userSelect, type UserRow } from "./user-mapper";

export function sessionMiddleware(db: Database, cache: Cache, config: AppConfig) {
    return async (request: Request, response: Response, next: NextFunction) => {
        const token = request.cookies?.[config.SESSION_COOKIE_NAME];
        if (!token || typeof token !== "string") {
            response.status(401).json({ error: "UNAUTHENTICATED", message: "请先登录" });
            return;
        }

        try {
            const tokenHash = hashToken(token);
            const cacheKey = `session:${tokenHash}`;
            const cachedId = await cache.get(cacheKey);
            const result = await db.query<UserRow & { session_id: string }>(
                `SELECT ${userSelect}, s.id AS session_id
                 FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN departments d ON d.id=u.department_id
                 WHERE s.token_hash=$1 AND ($2::uuid IS NULL OR s.id=$2::uuid) AND s.revoked_at IS NULL
                   AND s.expires_at>now() AND u.status='active'`,
                [tokenHash, cachedId],
            );
            const row = result.rows[0];
            if (!row) {
                await cache.del(cacheKey);
                response.clearCookie(config.SESSION_COOKIE_NAME);
                response.status(401).json({ error: "SESSION_EXPIRED", message: "登录已失效，请重新登录" });
                return;
            }
            await cache.set(cacheKey, row.session_id, { EX: config.SESSION_TTL_SECONDS });
            const authenticated = request as AuthenticatedRequest;
            authenticated.auth = mapUser(row);
            authenticated.sessionId = row.session_id;
            next();
        } catch (error) {
            next(error);
        }
    };
}

export function setSessionCookie(response: Response, config: AppConfig, token: string) {
    response.cookie(config.SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: config.SESSION_TTL_SECONDS * 1000,
        path: "/",
    });
}
