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
import { OA_SESSION_TTL_SECONDS } from "./oa";
import { getCreditsEnabled } from "./credit-policy";
import { isWorkspaceRole } from "../../shared/workspace-access";

const GUEST_SESSION_TTL_SECONDS = 365 * 24 * 60 * 60;
const SESSION_RENEW_INTERVAL_SECONDS = 600;
type SessionRow = UserRow & { session_id: string; auth_provider: string; session_remaining_seconds: number };
const sessionSelect = `${userSelect}, s.id AS session_id, s.auth_provider,
    FLOOR(EXTRACT(EPOCH FROM (s.expires_at-now())))::int AS session_remaining_seconds`;

export function sessionMiddleware(db: Database, cache: Cache, config: AppConfig, options: { allowGuest?: boolean; allowAdminSession?: boolean; allowPersonalWorkspace?: boolean; unauthenticatedStatus?: 401 | 403; renewSession?: boolean; refreshSessionCookie?: boolean } = {}) {
    const features = deploymentFeatures(config);
    const allowGuest = !features.oaLoginEnabled && !features.authenticationEnabled && options.allowGuest !== false;
    const acceptsProvider = (row: UserRow & { auth_provider: string }) => {
        // A role change must not turn a designer's QR login into an admin session.
        if (row.auth_provider === "wecom") return !features.oaLoginEnabled && row.role === "designer" && !row.is_guest;
        return !features.oaLoginEnabled
            || (row.auth_provider === "oa" && row.role === "designer")
            || (row.auth_provider === "local" && (options.allowGuest === false
                || (options.allowPersonalWorkspace && row.role === "super_admin")
                || (options.allowAdminSession && (row.role === "super_admin" || row.role === "department_admin"))));
    };
    return async (request: Request, response: Response, next: NextFunction) => {
        // Internal route policy, never sourced from the request body or headers.
        (request as AuthenticatedRequest).allowsAnonymousCreation = allowGuest;
        const token = request.cookies?.[config.SESSION_COOKIE_NAME];
        if (!token || typeof token !== "string") {
            if (allowGuest) {
                try { await createGuestSession(db, cache, config, request, response); next(); }
                catch (error) { next(error); }
                return;
            }
            response.status(options.unauthenticatedStatus ?? 401).json({ error: "UNAUTHENTICATED", message: "请先登录" });
            return;
        }

        try {
            const tokenHash = hashToken(token);
            const cacheKey = `session:${tokenHash}`;
            const cachedId = await cache.get(cacheKey);
            const result = await db.query<SessionRow>(
                `SELECT ${sessionSelect}
                 FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN departments d ON d.id=u.department_id
                 WHERE s.token_hash=$1 AND ($2::uuid IS NULL OR s.id=$2::uuid) AND s.revoked_at IS NULL
                   AND s.expires_at>now() AND u.status='active' AND u.deleted_at IS NULL`,
                [tokenHash, cachedId],
            );
            let row = result.rows[0];
            if (!row || (row.is_guest && !allowGuest) || !acceptsProvider(row)) {
                await cache.del(cacheKey);
                response.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
                if (!row && allowGuest) {
                    await createGuestSession(db, cache, config, request, response);
                    next();
                    return;
                }
                response.status(options.unauthenticatedStatus ?? 401).json({ error: "SESSION_EXPIRED", message: "登录已失效，请重新登录" });
                return;
            }
            // Compare with the database clock, not the API host's clock. Most requests
            // need neither the policy lookup, a row-locking transaction, nor a reread.
            if (row.credit_period_start !== row.current_credit_period_start
                && features.authenticationEnabled && await getCreditsEnabled(db, features.creditsEnabled)) {
                await refreshMonthlyCreditPeriod(db, row.id);
                const refreshed = await db.query<SessionRow>(
                    `SELECT ${sessionSelect}
                     FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN departments d ON d.id=u.department_id
                     WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'
                       AND u.deleted_at IS NULL`, [row.session_id],
                );
                row = refreshed.rows[0];
            }
            if (!row || (row.is_guest && !allowGuest) || !acceptsProvider(row)) {
                await cache.del(cacheKey);
                response.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
                response.status(options.unauthenticatedStatus ?? 401).json({ error: "SESSION_EXPIRED", message: "登录已失效，请重新登录" });
                return;
            }
            const expectedOwnerId = request.get("X-Canvas-Owner-Id");
            if (features.authenticationEnabled && isWorkspaceRole(row.role) && expectedOwnerId !== undefined && expectedOwnerId !== row.id) {
                response.status(403).json({ error: "CANVAS_OWNER_MISMATCH", message: "当前员工身份已变化，请重新打开画布后再试。" });
                return;
            }
            const ttl = row.auth_provider === "oa" ? OA_SESSION_TTL_SECONDS : config.SESSION_TTL_SECONDS;
            const renew = !row.is_guest && options.renewSession !== false;
            if (renew && row.session_remaining_seconds <= ttl - SESSION_RENEW_INTERVAL_SECONDS) {
                // The database clock and predicate own renewal. Parallel requests
                // may all read an old expiry, but only one can extend it in ten minutes.
                const renewed = await db.query<{ session_remaining_seconds: number }>(
                    `UPDATE sessions s SET expires_at=now()+($2::int * interval '1 second')
                     WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
                       AND s.expires_at<=now()+(($2::int-$3::int) * interval '1 second')
                       AND s.user_id=$4 AND s.auth_provider=$5 AND s.token_hash=$7
                       AND EXISTS(SELECT 1 FROM users u WHERE u.id=s.user_id AND u.status='active'
                         AND u.deleted_at IS NULL AND u.is_guest=false AND u.role=$6)
                     RETURNING FLOOR(EXTRACT(EPOCH FROM (s.expires_at-now())))::int AS session_remaining_seconds`,
                    [row.session_id, ttl, SESSION_RENEW_INTERVAL_SECONDS, row.id, row.auth_provider, row.role, tokenHash],
                );
                if (renewed.rows[0]) row.session_remaining_seconds = renewed.rows[0].session_remaining_seconds;
                else {
                    // Another request may have renewed first; expiry, revocation or
                    // an identity change must instead fail closed, never revive a row.
                    const refreshed = await db.query<SessionRow>(
                        `SELECT ${sessionSelect}
                         FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN departments d ON d.id=u.department_id
                         WHERE s.id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL
                           AND s.expires_at>now() AND u.status='active' AND u.deleted_at IS NULL`,
                        [row.session_id, tokenHash],
                    );
                    const current = refreshed.rows[0];
                    if (!current || current.is_guest || !acceptsProvider(current) || current.id !== row.id
                        || current.role !== row.role || current.auth_provider !== row.auth_provider) {
                        await cache.del(cacheKey);
                        response.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
                        response.status(options.unauthenticatedStatus ?? 401).json({ error: "SESSION_EXPIRED", message: "登录已失效，请重新登录" });
                        return;
                    }
                    row = current;
                }
            }
            // Only the short session-status response sends a cookie. A slow business
            // response must not overwrite a newer login's cookie when it finishes.
            // Resend remaining lifetime even if another request renewed the DB first.
            if (renew && options.refreshSessionCookie && Number.isFinite(row.session_remaining_seconds) && row.session_remaining_seconds > 0) {
                setSessionCookie(response, config, token, row.session_remaining_seconds);
            }
            await cache.set(cacheKey, row.session_id, { EX: ttl });
            const authenticated = request as AuthenticatedRequest;
            authenticated.auth = mapUser(row);
            // Only the server-verified session source bypasses local onboarding.
            // Keep the account's stored password requirement for local logins.
            if (row.auth_provider === "wecom") authenticated.auth.mustChangePassword = false;
            authenticated.sessionId = row.session_id;
            next();
        } catch (error) {
            next(error);
        }
    };
}

export function requireAccountReady(request: Request, response: Response, next: NextFunction) {
    const authenticated = request as unknown as AuthenticatedRequest;
    if (authenticated.auth.mustChangePassword && !authenticated.allowsAnonymousCreation) {
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
