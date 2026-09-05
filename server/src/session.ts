import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config";
import type { Cache, Database } from "./db";
import { createSessionToken, hashToken } from "./security";
import type { AuthenticatedRequest } from "./types";
import { mapUser, userSelect, type UserRow } from "./user-mapper";
import { refreshMonthlyCreditPeriod } from "./billing";
import { withTransaction } from "./db-transaction";
import { deploymentFeatures } from "./deployment-features";

const GUEST_SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;

export function sessionMiddleware(db: Database, cache: Cache, config: AppConfig, options: { allowGuest?: boolean } = {}) {
    const features = deploymentFeatures(config);
    const allowGuest = !features.authenticationEnabled && options.allowGuest !== false;
    return async (request: Request, response: Response, next: NextFunction) => {
        const token = request.cookies?.[config.SESSION_COOKIE_NAME];
        if (!token || typeof token !== "string") {
            if (allowGuest) {
                try { await createGuestSession(db, cache, config, request, response); next(); }
                catch (error) { next(error); }
                return;
            }
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
            let row = result.rows[0];
            if (!row || (row.is_guest && !allowGuest)) {
                await cache.del(cacheKey);
                if (!row) response.clearCookie(config.SESSION_COOKIE_NAME);
                if (!row && allowGuest) {
                    await createGuestSession(db, cache, config, request, response);
                    next();
                    return;
                }
                response.status(401).json({ error: "SESSION_EXPIRED", message: "登录已失效，请重新登录" });
                return;
            }
            if (features.creditsEnabled) await refreshMonthlyCreditPeriod(db, row.id);
            const refreshed = await db.query<UserRow & { session_id: string }>(
                `SELECT ${userSelect}, s.id AS session_id
                 FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN departments d ON d.id=u.department_id
                 WHERE s.id=$1`, [row.session_id],
            );
            row = refreshed.rows[0] ?? row;
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

export function requireAccountReady(request: Request, response: Response, next: NextFunction) {
    const authenticated = request as unknown as AuthenticatedRequest;
    if (authenticated.auth.mustChangePassword) {
        response.status(403).json({
            error: "PASSWORD_CHANGE_REQUIRED",
            message: "首次登录必须先修改密码",
        });
        return;
    }
    next();
}

export function setSessionCookie(response: Response, config: AppConfig, token: string, ttlSeconds = config.SESSION_TTL_SECONDS) {
    response.cookie(config.SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: ttlSeconds * 1000,
        path: "/",
    });
}

async function createGuestSession(db: Database, cache: Cache, config: AppConfig, request: Request, response: Response) {
    const userId = randomUUID();
    const session = createSessionToken();
    const row = await withTransaction(db, async (client) => {
        await client.query(
            "INSERT INTO users(id,username,display_name,role,is_guest,must_change_password) VALUES($1,$2,'访客','designer',true,false)",
            [userId, `guest-${userId}`],
        );
        await client.query(
            `INSERT INTO sessions(id,user_id,token_hash,ip_address,user_agent,expires_at)
             VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 second'))`,
            [session.id, userId, hashToken(session.token), request.ip, request.get("user-agent"), GUEST_SESSION_TTL_SECONDS],
        );
        const result = await client.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`, [userId]);
        return result.rows[0]!;
    });
    await cache.set(`session:${hashToken(session.token)}`, session.id, { EX: GUEST_SESSION_TTL_SECONDS });
    setSessionCookie(response, config, session.token, GUEST_SESSION_TTL_SECONDS);
    const authenticated = request as AuthenticatedRequest;
    authenticated.auth = mapUser(row);
    authenticated.sessionId = session.id;
}
