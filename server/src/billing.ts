import type { PoolClient } from "pg";
import type { Database } from "./db";

export type PriceSnapshot = {
    operationType: string;
    operationCredits: number;
    operationRmb: number;
    modelId: string | null;
    modelCredits: number;
    modelRmb: number;
    quantity: number;
    totalCredits: number;
    totalRmb: number;
    priceVersion: number;
};

export function calculatePrice(input: Omit<PriceSnapshot, "totalCredits" | "totalRmb">): PriceSnapshot {
    return {
        ...input,
        totalCredits: (input.operationCredits + input.modelCredits) * input.quantity,
        totalRmb: Math.round((input.operationRmb + input.modelRmb) * input.quantity * 10_000) / 10_000,
    };
}

async function withTransaction<T>(db: Database, operation: (client: PoolClient) => Promise<T>) {
    const client = await db.connect();
    try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

export async function adjustCredits(db: Database, input: { requestId: string; actorId: string; userId: string; amount: number; reason: string }) {
    return withTransaction(db, async (client) => {
        const duplicate = await client.query<{ balance_after: number }>("SELECT balance_after FROM credit_ledger WHERE request_id=$1", [input.requestId]);
        if (duplicate.rows[0]) return { balance: duplicate.rows[0].balance_after, duplicate: true };
        const userResult = await client.query<{ credit_balance: number; credit_limit: number }>("SELECT credit_balance,credit_limit FROM users WHERE id=$1 FOR UPDATE", [input.userId]);
        const user = userResult.rows[0];
        if (!user) throw new BillingError("ACCOUNT_NOT_FOUND", "账号不存在");
        const balance = user.credit_balance + input.amount;
        if (balance < 0 || balance > user.credit_limit) throw new BillingError("INVALID_CREDIT", "调整后积分必须在 0 和额度上限之间");
        await client.query("UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2", [balance, input.userId]);
        await client.query(`INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
            VALUES($1,$2,$3,'adjustment',$4,$5,'user',$2::text,$6)`, [input.requestId, input.userId, input.actorId, input.amount, balance, input.reason]);
        return { balance, duplicate: false };
    });
}

export async function reserveCredits(db: Database, input: { requestId: string; userId: string; operationType: string; modelConfigId?: string | null; quantity: number }) {
    return withTransaction(db, async (client) => {
        const existing = await client.query<{ status: string; credits: number; rmb_cost: string; price_snapshot: PriceSnapshot }>("SELECT status,credits,rmb_cost,price_snapshot FROM credit_reservations WHERE request_id=$1", [input.requestId]);
        if (existing.rows[0]) return { ...existing.rows[0], rmbCost: Number(existing.rows[0].rmb_cost), snapshot: existing.rows[0].price_snapshot, duplicate: true };
        const priceResult = await client.query<{ credits: number; rmb_cost: string; version: number }>("SELECT credits,rmb_cost,version FROM pricing_rule_versions WHERE operation_type=$1 AND status='published'", [input.operationType]);
        const price = priceResult.rows[0];
        if (!price) throw new BillingError("PRICE_NOT_CONFIGURED", "管理员尚未发布该操作的价格");
        const modelResult = input.modelConfigId ? await client.query<{ id: string; credit_cost: number; rmb_cost: string }>("SELECT id,credit_cost,rmb_cost FROM model_configs WHERE id=$1 AND enabled=true", [input.modelConfigId]) : null;
        if (input.modelConfigId && !modelResult?.rows[0]) throw new BillingError("MODEL_DISABLED", "模型不存在或未启用");
        const model = modelResult?.rows[0];
        const snapshot = calculatePrice({ operationType: input.operationType, operationCredits: price.credits, operationRmb: Number(price.rmb_cost), modelId: model?.id ?? null, modelCredits: model?.credit_cost ?? 0, modelRmb: Number(model?.rmb_cost ?? 0), quantity: input.quantity, priceVersion: price.version });
        const userResult = await client.query<{ credit_balance: number; department_id: string | null }>("SELECT credit_balance,department_id FROM users WHERE id=$1 AND status='active' FOR UPDATE", [input.userId]);
        const user = userResult.rows[0];
        if (!user) throw new BillingError("ACCOUNT_DISABLED", "账号不存在或已停用");
        if (user.credit_balance < snapshot.totalCredits) throw new BillingError("INSUFFICIENT_CREDIT", "个人剩余积分不足");
        const userBalance = user.credit_balance - snapshot.totalCredits;
        await client.query("UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2", [userBalance, input.userId]);
        let departmentBalance: number | null = null;
        if (user.department_id) {
            const departmentResult = await client.query<{ credit_balance: number; credit_limit: number }>("SELECT credit_balance,credit_limit FROM departments WHERE id=$1 FOR UPDATE", [user.department_id]);
            const department = departmentResult.rows[0];
            if (department && department.credit_limit > 0) {
                if (department.credit_balance < snapshot.totalCredits) throw new BillingError("DEPARTMENT_CREDIT_EXHAUSTED", "部门预算积分不足");
                departmentBalance = department.credit_balance - snapshot.totalCredits;
                await client.query("UPDATE departments SET credit_balance=$1,updated_at=now() WHERE id=$2", [departmentBalance, user.department_id]);
            }
        }
        await client.query(`INSERT INTO credit_reservations(request_id,user_id,department_id,operation_type,model_config_id,quantity,credits,department_credits,rmb_cost,price_snapshot)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.requestId, input.userId, user.department_id, input.operationType, model?.id ?? null, input.quantity, snapshot.totalCredits, departmentBalance === null ? 0 : snapshot.totalCredits, snapshot.totalRmb, snapshot]);
        await client.query(`INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
            VALUES($1,$2,$2,'hold',$3,$4,'task',$5,'任务提交冻结积分',$6)`, [`${input.requestId}:user:hold`, input.userId, -snapshot.totalCredits, userBalance, input.requestId, snapshot]);
        if (departmentBalance !== null && user.department_id) {
            await client.query(`INSERT INTO credit_ledger(request_id,department_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
                VALUES($1,$2,$3,'hold',$4,$5,'task',$6,'任务提交冻结部门预算',$7)`, [`${input.requestId}:department:hold`, user.department_id, input.userId, -snapshot.totalCredits, departmentBalance, input.requestId, snapshot]);
        }
        return { status: "held", credits: snapshot.totalCredits, rmbCost: snapshot.totalRmb, snapshot, duplicate: false };
    });
}

export async function settleReservation(db: Database, requestId: string, outcome: "capture" | "release", actorId?: string) {
    return withTransaction(db, async (client) => {
        const result = await client.query<{ id: string; user_id: string; department_id: string | null; credits: number; department_credits: number; status: string }>("SELECT id,user_id,department_id,credits,department_credits,status FROM credit_reservations WHERE request_id=$1 FOR UPDATE", [requestId]);
        const reservation = result.rows[0];
        if (!reservation) throw new BillingError("RESERVATION_NOT_FOUND", "额度冻结记录不存在");
        if (reservation.status !== "held") return { status: reservation.status, duplicate: true };
        if (outcome === "capture") {
            const user = await client.query<{ credit_balance: number }>("SELECT credit_balance FROM users WHERE id=$1", [reservation.user_id]);
            await client.query("UPDATE credit_reservations SET status='captured',settled_at=now() WHERE id=$1", [reservation.id]);
            await client.query(`INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                VALUES($1,$2,$3,'capture',0,$4,'task',$5,'任务成功结算')`, [`${requestId}:user:capture`, reservation.user_id, actorId ?? reservation.user_id, user.rows[0]!.credit_balance, requestId]);
            if (reservation.department_id && reservation.department_credits > 0) {
                const department = await client.query<{ credit_balance: number }>("SELECT credit_balance FROM departments WHERE id=$1", [reservation.department_id]);
                await client.query(`INSERT INTO credit_ledger(request_id,department_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                    VALUES($1,$2,$3,'capture',0,$4,'task',$5,'任务成功结算部门预算')`, [`${requestId}:department:capture`, reservation.department_id, actorId ?? reservation.user_id, department.rows[0]!.credit_balance, requestId]);
            }
            return { status: "captured", duplicate: false };
        }
        const user = await client.query<{ credit_balance: number }>("SELECT credit_balance FROM users WHERE id=$1 FOR UPDATE", [reservation.user_id]);
        const userBalance = user.rows[0]!.credit_balance + reservation.credits;
        await client.query("UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2", [userBalance, reservation.user_id]);
        await client.query(`INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
            VALUES($1,$2,$3,'release',$4,$5,'task',$6,'任务失败、取消或超时释放积分')`, [`${requestId}:user:release`, reservation.user_id, actorId ?? reservation.user_id, reservation.credits, userBalance, requestId]);
        if (reservation.department_id && reservation.department_credits > 0) {
            const department = await client.query<{ credit_balance: number }>("SELECT credit_balance FROM departments WHERE id=$1 FOR UPDATE", [reservation.department_id]);
            if (department.rows[0]) {
                const balance = department.rows[0].credit_balance + reservation.department_credits;
                await client.query("UPDATE departments SET credit_balance=$1,updated_at=now() WHERE id=$2", [balance, reservation.department_id]);
                await client.query(`INSERT INTO credit_ledger(request_id,department_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                    VALUES($1,$2,$3,'release',$4,$5,'task',$6,'任务释放部门预算')`, [`${requestId}:department:release`, reservation.department_id, actorId ?? reservation.user_id, reservation.department_credits, balance, requestId]);
            }
        }
        await client.query("UPDATE credit_reservations SET status='released',settled_at=now() WHERE id=$1", [reservation.id]);
        return { status: "released", duplicate: false };
    });
}

export class BillingError extends Error {
    constructor(public code: string, message: string) { super(message); }
}
