import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { canManageUser, requireRole } from "../rbac";
import { hashPassword, validatePassword } from "../security";
import type { AuthenticatedRequest, UserRole } from "../types";
import { mapUser, userSelect, type UserRow } from "../user-mapper";

const accountSchema = z.object({
    username: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(100),
    email: z.string().email().nullish(), employeeNo: z.string().trim().min(1).max(80).nullish(),
    password: z.string().min(1), role: z.enum(["super_admin", "department_admin", "designer"]).default("designer"),
    departmentId: z.string().uuid().nullish(), creditBalance: z.number().int().nonnegative().default(0),
    creditLimit: z.number().int().nonnegative().default(0),
});
const updateSchema = z.object({
    displayName: z.string().trim().min(1).max(100).optional(), email: z.string().email().nullable().optional(),
    employeeNo: z.string().trim().min(1).max(80).nullable().optional(), role: z.enum(["department_admin", "designer"]).optional(),
    departmentId: z.string().uuid().nullable().optional(), status: z.enum(["active", "disabled", "locked"]).optional(),
    creditLimit: z.number().int().nonnegative().optional(),
});
const resetSchema = z.object({ password: z.string().min(1) });
const creditSchema = z.object({ amount: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0), reason: z.string().trim().min(2).max(300) });

export function createAccountsRouter(db: Database) {
    const router = Router();
    router.use(requireRole("super_admin", "department_admin"));

    router.get("/", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const values: unknown[] = [];
            const where = actor.role === "department_admin" ? (values.push(actor.departmentId), "WHERE u.department_id=$1 AND u.role='designer'") : "";
            const result = await db.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id ${where} ORDER BY u.created_at DESC`, values);
            response.json({ users: result.rows.map(mapUser) });
        } catch (error) { next(error); }
    });

    router.post("/", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const input = accountSchema.parse(request.body);
            const passwordError = validatePassword(input.password);
            if (passwordError) { response.status(400).json({ error: "WEAK_PASSWORD", message: passwordError }); return; }
            if (actor.role === "department_admin" && (input.role !== "designer" || input.departmentId !== actor.departmentId)) {
                response.status(403).json({ error: "FORBIDDEN", message: "部门管理员只能创建本部门设计师" }); return;
            }
            if (input.role === "super_admin") {
                response.status(403).json({ error: "FORBIDDEN", message: "超级管理员只能通过受控初始化流程创建" }); return;
            }
            if (input.role === "department_admin" && !input.departmentId) {
                response.status(400).json({ error: "DEPARTMENT_REQUIRED", message: "部门管理员必须属于一个部门" }); return;
            }
            if (input.creditBalance > input.creditLimit) {
                response.status(400).json({ error: "INVALID_CREDIT", message: "初始积分不能超过积分上限" }); return;
            }
            const result = await db.query<UserRow>(
                `INSERT INTO users(username,display_name,email,employee_no,password_hash,role,department_id,credit_balance,credit_limit,created_by)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,username,display_name,email,employee_no,role,status,department_id,
                 (SELECT name FROM departments WHERE departments.id=users.department_id) department_name,must_change_password,mfa_enabled,credit_balance,credit_limit`,
                [input.username, input.displayName, input.email ?? null, input.employeeNo ?? null, await hashPassword(input.password), input.role, input.departmentId ?? null, input.creditBalance, input.creditLimit, actor.id],
            );
            const user = mapUser(result.rows[0]);
            await writeAudit(db, { actor, action: "account.created", targetType: "user", targetId: user.id, departmentId: user.departmentId, result: "success", detail: { role: user.role }, ip: request.ip });
            response.status(201).json({ user });
        } catch (error) { next(error); }
    });

    router.patch("/:id", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const input = updateSchema.parse(request.body);
            const currentResult = await db.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`, [request.params.id]);
            const current = currentResult.rows[0] && mapUser(currentResult.rows[0]);
            if (!current) { response.status(404).json({ error: "NOT_FOUND", message: "账号不存在" }); return; }
            if (!canManageUser(actor, current)) { response.status(403).json({ error: "FORBIDDEN", message: "不能管理该账号" }); return; }
            const departmentId = input.departmentId === undefined ? current.departmentId : input.departmentId;
            if (actor.role === "department_admin" && departmentId !== actor.departmentId) { response.status(403).json({ error: "FORBIDDEN", message: "不能将账号移出本部门" }); return; }
            const role = (input.role ?? current.role) as UserRole;
            if (actor.role === "department_admin" && role !== "designer") { response.status(403).json({ error: "FORBIDDEN", message: "部门管理员不能提升账号角色" }); return; }
            if (role === "department_admin" && !departmentId) { response.status(400).json({ error: "DEPARTMENT_REQUIRED", message: "部门管理员必须属于一个部门" }); return; }
            if (input.creditLimit !== undefined && input.creditLimit < current.creditBalance) { response.status(400).json({ error: "INVALID_CREDIT", message: "额度上限不能低于当前剩余积分" }); return; }
            const result = await db.query<UserRow>(
                `UPDATE users SET display_name=$1,email=$2,employee_no=$3,role=$4,department_id=$5,status=$6,credit_limit=$7,updated_at=now()
                 WHERE id=$8 RETURNING id,username,display_name,email,employee_no,role,status,department_id,
                 (SELECT name FROM departments WHERE departments.id=users.department_id) department_name,must_change_password,mfa_enabled,credit_balance,credit_limit`,
                [input.displayName ?? current.displayName, input.email === undefined ? current.email : input.email, input.employeeNo === undefined ? current.employeeNo : input.employeeNo,
                    role, departmentId, input.status ?? current.status, input.creditLimit ?? current.creditLimit, current.id],
            );
            const user = mapUser(result.rows[0]);
            await writeAudit(db, { actor, action: "account.updated", targetType: "user", targetId: user.id, departmentId: user.departmentId, result: "success", detail: input, ip: request.ip });
            response.json({ user });
        } catch (error) { next(error); }
    });

    router.post("/:id/reset-password", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const input = resetSchema.parse(request.body);
            const passwordError = validatePassword(input.password);
            if (passwordError) { response.status(400).json({ error: "WEAK_PASSWORD", message: passwordError }); return; }
            const targetResult = await db.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`, [request.params.id]);
            const target = targetResult.rows[0] && mapUser(targetResult.rows[0]);
            if (!target) { response.status(404).json({ error: "NOT_FOUND", message: "账号不存在" }); return; }
            if (!canManageUser(actor, target)) { response.status(403).json({ error: "FORBIDDEN", message: "不能重置该账号" }); return; }
            const client = await db.connect();
            try {
                await client.query("BEGIN");
                await client.query("UPDATE users SET password_hash=$1,must_change_password=true,failed_login_count=0,locked_until=NULL,updated_at=now() WHERE id=$2", [await hashPassword(input.password), target.id]);
                await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [target.id]);
                await client.query("COMMIT");
            } catch (error) { await client.query("ROLLBACK"); throw error; }
            finally { client.release(); }
            await writeAudit(db, { actor, action: "account.password_reset", targetType: "user", targetId: target.id, departmentId: target.departmentId, result: "success", ip: request.ip });
            response.status(204).end();
        } catch (error) { next(error); }
    });

    router.post("/:id/credits", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        const client = await db.connect();
        try {
            const input = creditSchema.parse(request.body);
            await client.query("BEGIN");
            const targetResult = await client.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1 FOR UPDATE OF u`, [request.params.id]);
            const target = targetResult.rows[0] && mapUser(targetResult.rows[0]);
            if (!target) { await client.query("ROLLBACK"); response.status(404).json({ error: "NOT_FOUND", message: "账号不存在" }); return; }
            if (!canManageUser(actor, target)) { await client.query("ROLLBACK"); response.status(403).json({ error: "FORBIDDEN", message: "不能调整该账号额度" }); return; }
            const nextBalance = target.creditBalance + input.amount;
            if (nextBalance < 0 || nextBalance > target.creditLimit) { await client.query("ROLLBACK"); response.status(400).json({ error: "INVALID_CREDIT", message: "调整后积分必须在 0 和额度上限之间" }); return; }
            const updated = await client.query<UserRow>(`UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2
                RETURNING id,username,display_name,email,employee_no,role,status,department_id,
                (SELECT name FROM departments WHERE departments.id=users.department_id) department_name,must_change_password,mfa_enabled,credit_balance,credit_limit`, [nextBalance, target.id]);
            await client.query("COMMIT");
            const user = mapUser(updated.rows[0]);
            await writeAudit(db, { actor, action: "account.credits_adjusted", targetType: "user", targetId: user.id, departmentId: user.departmentId, result: "success", detail: { amount: input.amount, reason: input.reason, balance: nextBalance }, ip: request.ip });
            response.json({ user });
        } catch (error) { await client.query("ROLLBACK").catch(() => undefined); next(error); }
        finally { client.release(); }
    });

    router.post("/bulk", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const accounts = z.array(accountSchema).min(1).max(200).parse(request.body.accounts);
            const failures: Array<{ index: number; message: string }> = [];
            let created = 0;
            for (const [index, account] of accounts.entries()) {
                const passwordError = validatePassword(account.password);
                if (passwordError || account.role === "super_admin" || account.creditBalance > account.creditLimit || (actor.role === "department_admin" && (account.role !== "designer" || account.departmentId !== actor.departmentId))) {
                    failures.push({ index, message: passwordError ?? "账号权限或积分设置不合法" }); continue;
                }
                try {
                    await db.query(`INSERT INTO users(username,display_name,email,employee_no,password_hash,role,department_id,credit_balance,credit_limit,created_by)
                        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [account.username, account.displayName, account.email ?? null, account.employeeNo ?? null,
                        await hashPassword(account.password), account.role, account.departmentId ?? null, account.creditBalance, account.creditLimit, actor.id]);
                    created += 1;
                } catch { failures.push({ index, message: "账号、邮箱或工号重复" }); }
            }
            await writeAudit(db, { actor, action: "account.bulk_created", targetType: "user", result: failures.length ? "failed" : "success", detail: { created, failed: failures.length }, ip: request.ip });
            response.status(failures.length ? 207 : 201).json({ created, failures });
        } catch (error) { next(error); }
    });

    return router;
}
