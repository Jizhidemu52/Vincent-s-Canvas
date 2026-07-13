import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Cache, Database } from "../db";
import { canUsePortal } from "../rbac";
import { createSessionToken, createTotpSecret, decryptSecret, encryptSecret, hashPassword, hashToken, validatePassword, verifyPassword, verifyTotp } from "../security";
import { sessionMiddleware, setSessionCookie } from "../session";
import type { AuthenticatedRequest } from "../types";
import { mapUser, userSelect, type UserRow } from "../user-mapper";
import { rateLimit } from "../http-security";
import { createWeComAuthorizationUrl, exchangeWeComCode, WeComError } from "../wecom";
import { refreshMonthlyCreditPeriod } from "../billing";

const loginSchema = z.object({
    identifier: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(200),
    portal: z.enum(["designer", "admin"]),
    mfaCode: z.string().regex(/^\d{6}$/).optional(),
});
const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });

export function createAuthRouter(db: Database, cache: Cache, config: AppConfig) {
    const router = Router();
    const requireSession = sessionMiddleware(db, cache, config);

    router.post("/login", rateLimit(cache, {
        prefix: "login",
        limit: 20,
        windowSeconds: 300,
        key: (request) => `${request.ip}:${String(request.body?.identifier ?? "").trim().toLocaleLowerCase()}`,
    }), async (request, response, next) => {
        try {
            const input = loginSchema.parse(request.body);
            const result = await db.query<UserRow & { password_hash: string | null; locked_until: Date | null; mfa_secret_encrypted: string | null }>(
                `SELECT ${userSelect}, u.password_hash, u.locked_until, u.mfa_secret_encrypted
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
            if (row.mfa_enabled) {
                const secret = row.mfa_secret_encrypted && config.MFA_ENCRYPTION_KEY ? decryptSecret(row.mfa_secret_encrypted, config.MFA_ENCRYPTION_KEY) : null;
                if (!secret || !input.mfaCode || !verifyTotp(secret, input.mfaCode)) {
                    await writeAudit(db, { actor: mapUser(row), action: "auth.mfa", targetType: "user", targetId: row.id, result: "denied", ip: request.ip });
                    response.status(401).json({ error: "MFA_REQUIRED", message: "请输入有效的六位动态验证码" }); return;
                }
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
            await refreshMonthlyCreditPeriod(db, row.id);
            const refreshed = await db.query<UserRow>(
                `SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`, [row.id],
            );
            const user = mapUser(refreshed.rows[0] ?? row);
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

    router.post("/mfa/setup", requireSession, async (request, response, next) => {
        try {
            const authenticated = request as unknown as AuthenticatedRequest;
            if (authenticated.auth.role !== "super_admin") { response.status(403).json({ error: "FORBIDDEN", message: "仅超级管理员需要配置二次验证" }); return; }
            if (authenticated.auth.mfaEnabled) { response.status(409).json({ error: "MFA_ALREADY_ENABLED", message: "二次验证已经启用，如需重置请使用受审计的管理员恢复流程" }); return; }
            if (!config.MFA_ENCRYPTION_KEY) { response.status(503).json({ error: "MFA_NOT_CONFIGURED", message: "服务器尚未配置 MFA 加密密钥" }); return; }
            const secret = createTotpSecret();
            await db.query("UPDATE users SET mfa_secret_encrypted=$1,mfa_enabled=false,updated_at=now() WHERE id=$2", [encryptSecret(secret, config.MFA_ENCRYPTION_KEY), authenticated.auth.id]);
            const label = encodeURIComponent(`Wireless Canvas:${authenticated.auth.username}`);
            const issuer = encodeURIComponent("Wireless Canvas");
            response.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}` });
        } catch (error) { next(error); }
    });

    router.post("/mfa/enable", requireSession, async (request, response, next) => {
        try {
            const authenticated = request as unknown as AuthenticatedRequest;
            const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(request.body);
            const result = await db.query<{ mfa_secret_encrypted: string | null }>("SELECT mfa_secret_encrypted FROM users WHERE id=$1", [authenticated.auth.id]);
            const encrypted = result.rows[0]?.mfa_secret_encrypted;
            if (!encrypted || !config.MFA_ENCRYPTION_KEY || !verifyTotp(decryptSecret(encrypted, config.MFA_ENCRYPTION_KEY), input.code)) {
                response.status(400).json({ error: "INVALID_MFA_CODE", message: "动态验证码不正确" }); return;
            }
            await db.query("UPDATE users SET mfa_enabled=true,updated_at=now() WHERE id=$1", [authenticated.auth.id]);
            await writeAudit(db, { actor: authenticated.auth, action: "auth.mfa_enabled", targetType: "user", targetId: authenticated.auth.id, result: "success", ip: request.ip });
            response.status(204).end();
        } catch (error) { next(error); }
    });

    router.get("/wecom/start", async (request, response) => {
        try {
            const state = randomBytes(24).toString("base64url");
            const portal = request.query.portal === "admin" ? "admin" : "designer";
            const authorizationUrl = createWeComAuthorizationUrl(config, state);
            await cache.set(`wecom-state:${state}`, portal, { EX: 300 });
            response.json({ authorizationUrl });
        } catch (error) {
            if (error instanceof WeComError) { response.status(503).json({ error: error.code, message: error.message }); return; }
            throw error;
        }
    });

    router.get("/wecom/callback", async (request, response, next) => {
        try {
            const code = typeof request.query.code === "string" ? request.query.code : "";
            const state = typeof request.query.state === "string" ? request.query.state : "";
            const portal = state ? await cache.get(`wecom-state:${state}`) : null;
            if (!code || !state || !portal) { response.status(400).send("企业微信登录请求已失效，请返回登录页重试"); return; }
            await cache.del(`wecom-state:${state}`);
            const { userId } = await exchangeWeComCode(config, code);

            const result = await db.query<UserRow>(
                `SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id
                 LEFT JOIN external_identities e ON e.user_id=u.id AND e.provider='wecom'
                 WHERE e.subject=$1 OR u.employee_no=$1 ORDER BY (e.subject=$1) DESC LIMIT 1`, [userId],
            );
            const row = result.rows[0];
            if (!row || row.status !== "active" || !canUsePortal(row.role, portal as "designer" | "admin")) {
                response.status(403).send("该企业微信成员尚未开通对应平台权限"); return;
            }
            const session = createSessionToken();
            const client = await db.connect();
            try {
                await client.query("BEGIN");
                await client.query(`INSERT INTO external_identities(user_id,provider,subject) VALUES($1,'wecom',$2)
                    ON CONFLICT DO NOTHING`, [row.id, userId]);
                const binding = await client.query<{ user_id: string; subject: string }>("SELECT user_id,subject FROM external_identities WHERE provider='wecom' AND (subject=$1 OR user_id=$2) FOR UPDATE", [userId, row.id]);
                if (binding.rows.length !== 1 || binding.rows[0]!.user_id !== row.id || binding.rows[0]!.subject !== userId) {
                    await client.query("ROLLBACK");
                    await writeAudit(db, { action: "auth.wecom_binding_conflict", targetType: "user", targetId: row.id, result: "denied", detail: { portal }, ip: request.ip }).catch(() => undefined);
                    response.status(409).send("该企业微信成员与内部账号的绑定发生冲突，请联系超级管理员处理");
                    return;
                }
                await client.query(`INSERT INTO sessions(id,user_id,token_hash,ip_address,user_agent,expires_at)
                    VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 second'))`, [session.id, row.id, hashToken(session.token), request.ip, request.get("user-agent"), config.SESSION_TTL_SECONDS]);
                await client.query("UPDATE users SET last_login_at=now(),failed_login_count=0,locked_until=NULL WHERE id=$1", [row.id]);
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw error;
            } finally { client.release(); }
            await cache.set(`session:${hashToken(session.token)}`, session.id, { EX: config.SESSION_TTL_SECONDS });
            setSessionCookie(response, config, session.token);
            const user = mapUser(row);
            await writeAudit(db, { actor: user, action: "auth.wecom_login", targetType: "session", targetId: session.id, result: "success", ip: request.ip });
            const destination = user.mustChangePassword ? "/change-password" : user.role === "designer" ? "/" : "/admin";
            response.redirect(302, destination);
        } catch (error) {
            if (error instanceof WeComError) {
                await writeAudit(db, { action: "auth.wecom_callback", targetType: "external_identity", result: "failed", detail: { code: error.code }, ip: request.ip }).catch(() => undefined);
                response.status(502).send(error.message);
                return;
            }
            next(error);
        }
    });

    return router;
}
