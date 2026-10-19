import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import { adjustCredits, BillingError, ensureMonthlyCreditPeriod, refreshMonthlyCreditPeriod, setCreditBalance } from "../billing";
import type { Database } from "../db";
import { withTransaction } from "../db-transaction";
import { canManageUser, requireRole } from "../rbac";
import { hashPassword, validatePassword } from "../security";
import type { AuthenticatedRequest, UserRole } from "../types";
import { mapUser, userSelect, type UserRow } from "../user-mapper";

const creditValueSchema = z.number().int().nonnegative().max(2_147_483_647);
const accountSchema = z.object({
    username: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(100),
    email: z.string().email().nullish(), employeeNo: z.string().trim().min(1).max(80).nullish(),
    password: z.string().min(1), role: z.enum(["super_admin", "department_admin", "designer"]).default("designer"),
    status: z.enum(["active", "disabled"]).default("active"),
    departmentId: z.string().uuid().nullish(), creditBalance: creditValueSchema.default(0),
    creditLimit: creditValueSchema.default(0),
    monthlyCreditLimit: creditValueSchema.optional(),
});
const updateSchema = z.object({
    displayName: z.string().trim().min(1).max(100).optional(), email: z.string().email().nullable().optional(),
    employeeNo: z.string().trim().min(1).max(80).nullable().optional(), role: z.enum(["department_admin", "designer"]).optional(),
    departmentId: z.string().uuid().nullable().optional(), status: z.enum(["active", "disabled", "locked"]).optional(),
    creditLimit: creditValueSchema.optional(),
    monthlyCreditLimit: creditValueSchema.optional(),
});
const resetSchema = z.object({ password: z.string().min(1) });
const creditSchema = z.object({ requestId: z.string().min(8).max(200), scope: z.literal("temporary").default("temporary"), amount: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0), reason: z.string().trim().min(2).max(300) });
const setCreditSchema = z.object({ requestId: z.string().min(8).max(200), balance: creditValueSchema, reason: z.string().trim().min(2).max(300) });

const existingAccountCondition = "u.deleted_at IS NULL";

export function createAccountsRouter(db: Database) {
    const router = Router();
    router.use(requireRole("super_admin", "department_admin"));

    router.get("/", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const values: unknown[] = [];
            const where = actor.role === "department_admin" ? (values.push(actor.departmentId), "WHERE u.department_id=$1 AND u.role='designer'") : "";
            const accountWhere = `${where ? `${where} AND` : "WHERE"} ${existingAccountCondition}`;
            let result = await db.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id ${accountWhere} ORDER BY u.created_at DESC`, values);
            const staleRows = result.rows.filter(row => row.credit_period_start !== row.current_credit_period_start);
            for (const row of staleRows) await refreshMonthlyCreditPeriod(db, row.id, actor.id);
            if (staleRows.length) {
                result = await db.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id ${accountWhere} ORDER BY u.created_at DESC`, values);
            }
            const usage = await db.query<{ total_used_credits: string }>(
                `SELECT COALESCE(SUM(r.credits),0)::text AS total_used_credits
                   FROM credit_reservations r JOIN users u ON u.id=r.user_id
                   ${where ? `${where} AND` : "WHERE"} r.status='captured'`, values,
            );
            response.json({ users: result.rows.map(mapUser), totalUsedCredits: Number(usage.rows[0]!.total_used_credits) });
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
            const client = await db.connect();
            let createdRow: UserRow;
            try {
                await client.query("BEGIN");
                const inserted = await client.query<{ id: string }>(`INSERT INTO users(username,display_name,email,employee_no,password_hash,role,status,department_id,credit_balance,credit_limit,monthly_credit_limit,created_by)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
                    [input.username, input.displayName, input.email ?? null, input.employeeNo ?? null, await hashPassword(input.password), input.role, input.status, input.departmentId ?? null, input.creditBalance, input.creditLimit, input.monthlyCreditLimit ?? input.creditLimit, actor.id]);
                await client.query(`INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                    VALUES($1,$2,$3,'adjustment',$4,$4,'account',$5,'账号初始额度')`, [`account-create:${inserted.rows[0].id}`, inserted.rows[0].id, actor.id, input.creditBalance, inserted.rows[0].id]);
                const selected = await client.query<UserRow>(
                    `SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`,
                    [inserted.rows[0].id],
                );
                createdRow = selected.rows[0];
                const user = mapUser(createdRow);
                await writeAudit(client, { actor, action: "account.created", targetType: "user", targetId: user.id, departmentId: user.departmentId, result: "success", detail: { role: user.role }, ip: request.ip });
                await client.query("COMMIT");
            } catch (error) { await client.query("ROLLBACK"); throw error; }
            finally { client.release(); }
            const user = mapUser(createdRow!);
            response.status(201).json({ user });
        } catch (error) { next(error); }
    });

    router.patch("/:id", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const input = updateSchema.parse(request.body);
            const user = await withTransaction(db, async client => {
                const currentResult = await client.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1 AND ${existingAccountCondition} FOR NO KEY UPDATE OF u`, [request.params.id]);
                const current = currentResult.rows[0] && mapUser(currentResult.rows[0]);
                if (!current) throw new BillingError("NOT_FOUND", "账号不存在");
                if (!canManageUser(actor, current)) throw new BillingError("FORBIDDEN", "不能管理该账号");
                const departmentId = input.departmentId === undefined ? current.departmentId : input.departmentId;
                if (actor.role === "department_admin" && departmentId !== actor.departmentId) throw new BillingError("FORBIDDEN", "不能将账号移出本部门");
                const role = (input.role ?? current.role) as UserRole;
                if (actor.role === "department_admin" && role !== "designer") throw new BillingError("FORBIDDEN", "部门管理员不能提升账号角色");
                if (role === "department_admin" && !departmentId) throw new BillingError("DEPARTMENT_REQUIRED", "部门管理员必须属于一个部门");
                // A new fixed allowance applies next month, even when this edit is
                // the first request to touch the account after the month changed.
                const period = await ensureMonthlyCreditPeriod(client, current.id, actor.id);
                await client.query(
                    `UPDATE users SET display_name=$1,email=$2,employee_no=$3,role=$4,department_id=$5,status=$6,
                        credit_limit=$7,monthly_credit_limit=$8,updated_at=now() WHERE id=$9`,
                    [input.displayName ?? current.displayName, input.email === undefined ? current.email : input.email, input.employeeNo === undefined ? current.employeeNo : input.employeeNo,
                        role, departmentId, input.status ?? current.status, input.creditLimit ?? period.credit_limit,
                        input.monthlyCreditLimit ?? period.monthly_credit_limit, current.id],
                );
                if (departmentId !== current.departmentId || role !== "designer" || (input.status ?? current.status) !== "active") {
                    await client.query(
                        "UPDATE group_memberships SET ended_at=now(),ended_by=$1 WHERE user_id=$2 AND ended_at IS NULL",
                        [actor.id, current.id],
                    );
                }
                if ((input.status ?? current.status) !== "active") {
                    await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [current.id]);
                }
                const result = await client.query<UserRow>(
                    `SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`,
                    [current.id],
                );
                const updated = mapUser(result.rows[0]);
                await writeAudit(client, { actor, action: input.monthlyCreditLimit !== undefined ? "account.monthly_credit_updated" : "account.updated", targetType: "user", targetId: updated.id, departmentId: updated.departmentId, result: "success", detail: input, ip: request.ip });
                return updated;
            });
            response.json({ user });
        } catch (error) {
            if (error instanceof BillingError) {
                const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 400;
                response.status(status).json({ error: error.code, message: error.message }); return;
            }
            next(error);
        }
    });

    router.post("/:id/reset-password", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const input = resetSchema.parse(request.body);
            const passwordError = validatePassword(input.password);
            if (passwordError) { response.status(400).json({ error: "WEAK_PASSWORD", message: passwordError }); return; }
            const targetResult = await db.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1 AND ${existingAccountCondition}`, [request.params.id]);
            const target = targetResult.rows[0] && mapUser(targetResult.rows[0]);
            if (!target) { response.status(404).json({ error: "NOT_FOUND", message: "账号不存在" }); return; }
            if (!canManageUser(actor, target)) { response.status(403).json({ error: "FORBIDDEN", message: "不能重置该账号" }); return; }
            const client = await db.connect();
            try {
                await client.query("BEGIN");
                await client.query("UPDATE users SET password_hash=$1,must_change_password=true,failed_login_count=0,locked_until=NULL,updated_at=now() WHERE id=$2", [await hashPassword(input.password), target.id]);
                await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [target.id]);
                await writeAudit(client, { actor, action: "account.password_reset", targetType: "user", targetId: target.id, departmentId: target.departmentId, result: "success", ip: request.ip });
                await client.query("COMMIT");
            } catch (error) { await client.query("ROLLBACK"); throw error; }
            finally { client.release(); }
            response.status(204).end();
        } catch (error) { next(error); }
    });

    router.route("/:id/credits").post(changeCredits).put(changeCredits);

    async function changeCredits(request: Request, response: Response, next: NextFunction) {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const input = request.method === "PUT" ? setCreditSchema.parse(request.body) : creditSchema.parse(request.body);
            const user = await withTransaction(db, async client => {
                const targetResult = await client.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1 AND ${existingAccountCondition} FOR NO KEY UPDATE OF u`, [request.params.id]);
                const target = targetResult.rows[0] && mapUser(targetResult.rows[0]);
                if (!target) throw new BillingError("NOT_FOUND", "账号不存在");
                if (!canManageUser(actor, target)) throw new BillingError("FORBIDDEN", "不能调整该账号额度");
                const context = { requestId: input.requestId, actorId: actor.id, userId: target.id, reason: input.reason };
                const adjustment = "balance" in input
                    ? await setCreditBalance(db, { ...context, balance: input.balance }, client)
                    : await adjustCredits(db, { ...context, amount: input.amount }, client);
                const updated = await client.query<UserRow>(`SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`, [target.id]);
                const result = mapUser(updated.rows[0]);
                if (!adjustment.duplicate) await writeAudit(client, {
                    actor, action: "balance" in input ? "account.credits_set" : "account.credits_adjusted", targetType: "user", targetId: result.id,
                    departmentId: result.departmentId, result: "success", detail: { requestId: input.requestId, mode: "balance" in input ? "set" : "add", amount: adjustment.amount, reason: input.reason, balanceBefore: adjustment.balanceBefore, balance: adjustment.balance }, ip: request.ip,
                });
                return result;
            });
            response.json({ user });
        } catch (error) {
            if (error instanceof BillingError) {
                const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : error.code === "CREDIT_REQUEST_CONFLICT" ? 409 : 400;
                response.status(status).json({ error: error.code, message: error.message }); return;
            }
            next(error);
        }
    }

    router.post("/bulk", async (request, response, next) => {
        const actor = (request as unknown as AuthenticatedRequest).auth;
        try {
            const accounts = z.array(accountSchema).min(1).max(200).parse(request.body.accounts);
            const { created, failures } = await withTransaction(db, async client => {
                const failures: Array<{ index: number; message: string }> = [];
                let created = 0;
                for (const [index, account] of accounts.entries()) {
                    const passwordError = validatePassword(account.password);
                    if (passwordError || account.role === "super_admin" || account.creditBalance > account.creditLimit || (actor.role === "department_admin" && (account.role !== "designer" || account.departmentId !== actor.departmentId))) {
                        failures.push({ index, message: passwordError ?? "账号权限或积分设置不合法" }); continue;
                    }
                    // Preserve per-row partial success, but commit all accepted
                    // accounts only together with the batch's required audit.
                    await client.query("SAVEPOINT bulk_account");
                    try {
                        const inserted = await client.query<{ id: string }>(`INSERT INTO users(username,display_name,email,employee_no,password_hash,role,status,department_id,credit_balance,credit_limit,monthly_credit_limit,created_by)
                            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [account.username, account.displayName, account.email ?? null, account.employeeNo ?? null,
                            await hashPassword(account.password), account.role, account.status, account.departmentId ?? null, account.creditBalance, account.creditLimit, account.monthlyCreditLimit ?? account.creditLimit, actor.id]);
                        await client.query(`INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                            VALUES($1,$2,$3,'adjustment',$4,$4,'account',$5,'批量导入初始额度')`, [`account-import:${randomUUID()}`, inserted.rows[0].id, actor.id, account.creditBalance, inserted.rows[0].id]);
                        created += 1;
                    } catch { await client.query("ROLLBACK TO SAVEPOINT bulk_account"); failures.push({ index, message: "账号、邮箱或工号重复" }); }
                    finally { await client.query("RELEASE SAVEPOINT bulk_account"); }
                }
                await writeAudit(client, { actor, action: "account.bulk_created", targetType: "user", result: failures.length ? "failed" : "success", detail: { created, failed: failures.length }, ip: request.ip });
                return { created, failures };
            });
            response.status(failures.length ? 207 : 201).json({ created, failures });
        } catch (error) { next(error); }
    });

    return router;
}
