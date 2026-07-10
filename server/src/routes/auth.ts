import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Cache, Database } from "../db";
import { canUsePortal } from "../rbac";
import { createSessionToken, hashPassword, hashToken, validatePassword, verifyPassword } from "../security";
import { sessionMiddleware, setSessionCookie } from "../session";
import type { AuthenticatedRequest } from "../types";
import { mapUser, userSelect, type UserRow } from "../user-mapper";

const loginSchema = z.object({
    identifier: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(200),
    portal: z.enum(["designer", "admin"]),
});
const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });

export function createAuthRouter(db: Database, cache: Cache, config: AppConfig) {
    const router = Router();
    const requireSession = sessionMiddleware(db, cache, config);

    router.post("/login", async (request, response, next) => {
        try {
            const input = loginSchema.parse(request.body);
            const result = await db.query<UserRow & { password_hash: string | null; locked_until: Date | null }>(
                `SELECT ${userSelect}, u.password_hash, u.locked_until
                 FROM users u LEFT JOIN departments d ON d.id=u.department_id
                 WHERE u.username=$1 OR u.email=$1 OR u.employee_no=$1 LIMIT 1`,
                [input.identifier],
            );
            const row = result.rows[0];
            const valid = row?.password_hash ? await verifyPassword(row.password_hash, input.password) : false;
            if (!row || !valid || row.status !== "active" || (row.locked_until && row.locked_until > new Date()) || !canUsePortal(row.role, input.portal)) {
                if (row) {
                    await db.query(`UPDATE users SET failed_login_count=failed_login_count+1,
                        locked_until=CASE WHEN failed_login_count+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1`, [row.id]);
                }
                await writeAudit(db, { action: "auth.login", targetType: "user", targetId: row?.id, result: "denied", detail: { portal: input.portal }, ip: request.ip });
                response.status(401).json({ error: "INVALID_CREDENTIALS", message: "账号、密码或登录入口不正确" });
                return;
            }

            const session = createSessionToken();
            const client = await db.connect();
            try {
                await client.query("BEGIN");
                await client.query(`INSERT INTO sessions(id,user_id,token_hash,ip_address,user_agent,expires_at)
                    VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 second'))`,
                    [session.id, row.id, hashToken(session.token), request.ip, request.get("user-agent"), config.SESSION_TTL_SECONDS]);
                await client.query("UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [row.id]);
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
            await cache.set(`session:${hashToken(session.token)}`, session.id, { EX: config.SESSION_TTL_SECONDS });
            setSessionCookie(response, config, session.token);
            const user = mapUser(row);
            await writeAudit(db, { actor: user, action: "auth.login", targetType: "session", targetId: session.id, result: "success", detail: { portal: input.portal }, ip: request.ip });
            response.json({ user });
        } catch (error) { next(error); }
    });

    router.get("/session", requireSession, (request, response) => response.json({ user: (request as unknown as AuthenticatedRequest).auth }));

    router.post("/logout", requireSession, async (request, response, next) => {
        try {
            const authenticated = request as unknown as AuthenticatedRequest;
            const token = request.cookies[config.SESSION_COOKIE_NAME];
            await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [authenticated.sessionId]);
            await cache.del(`session:${hashToken(token)}`);
            response.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
            await writeAudit(db, { actor: authenticated.auth, action: "auth.logout", targetType: "session", targetId: authenticated.sessionId, result: "success", ip: request.ip });
            response.status(204).end();
        } catch (error) { next(error); }
    });

    router.post("/change-password", requireSession, async (request, response, next) => {
        try {
            const input = passwordSchema.parse(request.body);
            const passwordError = validatePassword(input.newPassword);
            if (passwordError) { response.status(400).json({ error: "WEAK_PASSWORD", message: passwordError }); return; }
            const authenticated = request as unknown as AuthenticatedRequest;
            const current = await db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id=$1", [authenticated.auth.id]);
            if (!current.rows[0]?.password_hash || !(await verifyPassword(current.rows[0].password_hash, input.currentPassword))) {
                response.status(400).json({ error: "INVALID_PASSWORD", message: "当前密码不正确" }); return;
            }
            await db.query("UPDATE users SET password_hash=$1,must_change_password=false,password_changed_at=now(),updated_at=now() WHERE id=$2", [await hashPassword(input.newPassword), authenticated.auth.id]);
            await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2", [authenticated.auth.id, authenticated.sessionId]);
            await writeAudit(db, { actor: authenticated.auth, action: "auth.password_changed", targetType: "user", targetId: authenticated.auth.id, result: "success", ip: request.ip });
            response.status(204).end();
        } catch (error) { next(error); }
    });

    router.get("/wecom/start", async (_request, response) => {
        if (!config.WECOM_CORP_ID || !config.WECOM_AGENT_ID || !config.WECOM_CALLBACK_URL) {
            response.status(503).json({ error: "WECOM_NOT_CONFIGURED", message: "企业微信登录尚未由公司 IT 配置" }); return;
        }
        const state = randomBytes(24).toString("base64url");
        await cache.set(`wecom-state:${state}`, "1", { EX: 300 });
        const params = new URLSearchParams({ appid: config.WECOM_CORP_ID, agentid: config.WECOM_AGENT_ID, redirect_uri: config.WECOM_CALLBACK_URL, state });
        response.json({ authorizationUrl: `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?${params}` });
    });

    return router;
}
