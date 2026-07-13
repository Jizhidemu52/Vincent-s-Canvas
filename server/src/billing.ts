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

export function calculatePrice(
  input: Omit<PriceSnapshot, "totalCredits" | "totalRmb">,
): PriceSnapshot {
  return {
    ...input,
    totalCredits:
      (input.operationCredits + input.modelCredits) * input.quantity,
    totalRmb:
      Math.round(
        (input.operationRmb + input.modelRmb) * input.quantity * 10_000,
      ) / 10_000,
  };
}

const operationCapabilities: Record<string, string[]> = {
  image_generation: ["generate"],
  video_generation: ["video"],
  audio_generation: ["audio"],
  upscale: ["upscale", "edit"],
  remove_background: ["remove_background"],
  inpaint: ["edit"],
  batch_image: ["batch", "edit"],
  seamless_stitch: ["edit"],
};

export function modelSupportsOperation(
  operationType: string,
  capabilities: string[],
) {
  const accepted = operationCapabilities[operationType];
  return (
    !accepted ||
    accepted.some((capability) => capabilities.includes(capability))
  );
}

async function withTransaction<T>(
  db: Database,
  operation: (client: PoolClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if ((code !== "40P01" && code !== "40001") || attempt === 3) throw error;
      await Bun.sleep(20 * (attempt + 1));
    } finally {
      client.release();
    }
  }
  throw new Error("Transaction retry limit reached");
}

type CreditPeriodRow = {
  credit_balance: number;
  credit_limit: number;
  monthly_credit_limit: number;
  temporary_credit_adjustment: number;
  credit_period_start: string;
  current_period_start: string;
};

export async function ensureMonthlyCreditPeriod(
  client: PoolClient,
  userId: string,
  actorId = userId,
) {
  const result = await client.query<CreditPeriodRow>(
    `SELECT credit_balance,credit_limit,monthly_credit_limit,temporary_credit_adjustment,
            credit_period_start::text,
            date_trunc('month', timezone('Asia/Shanghai', now()))::date::text AS current_period_start
       FROM users WHERE id=$1 FOR UPDATE`,
    [userId],
  );
  const user = result.rows[0];
  if (!user) throw new BillingError("ACCOUNT_NOT_FOUND", "账号不存在");
  if (user.credit_period_start === user.current_period_start) return user;

  const balance = user.monthly_credit_limit;
  const requestId = `monthly-reset:${userId}:${user.current_period_start.slice(0, 7)}`;
  await client.query(
    `UPDATE users SET credit_balance=$1,credit_limit=$1,temporary_credit_adjustment=0,
            credit_period_start=$2::date,updated_at=now() WHERE id=$3`,
    [balance, user.current_period_start, userId],
  );
  await client.query(
    `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
     VALUES($1,$2,$3,'monthly_reset',$4,$5,'credit_period',$6,'自然月固定额度重置',$7)
     ON CONFLICT(request_id) DO NOTHING`,
    [requestId, userId, actorId, balance - user.credit_balance, balance, user.current_period_start,
      JSON.stringify({ previousPeriodStart: user.credit_period_start, previousBalance: user.credit_balance,
        expiredTemporaryAdjustment: user.temporary_credit_adjustment, monthlyCreditLimit: user.monthly_credit_limit,
        timezone: "Asia/Shanghai" })],
  );
  return { ...user, credit_balance: balance, credit_limit: balance,
    temporary_credit_adjustment: 0, credit_period_start: user.current_period_start };
}

export async function refreshMonthlyCreditPeriod(
  db: Database,
  userId: string,
  actorId = userId,
) {
  return withTransaction(db, (client) => ensureMonthlyCreditPeriod(client, userId, actorId));
}

export async function adjustCredits(
  db: Database,
  input: { requestId: string; actorId: string; userId: string; amount: number; reason: string },
) {
  return withTransaction(db, async (client) => {
    const duplicate = await client.query<{ balance_after: number }>(
      "SELECT balance_after FROM credit_ledger WHERE request_id=$1",
      [input.requestId],
    );
    if (duplicate.rows[0]) return { balance: duplicate.rows[0].balance_after, duplicate: true };
    const user = await ensureMonthlyCreditPeriod(client, input.userId, input.actorId);
    const balance = user.credit_balance + input.amount;
    if (balance < 0) throw new BillingError("INVALID_CREDIT", "本月临时扣减不能使剩余积分低于 0");
    const creditLimit = Math.max(user.credit_limit, balance);
    await client.query(
      `UPDATE users SET credit_balance=$1,credit_limit=$2,
         temporary_credit_adjustment=temporary_credit_adjustment+$3,updated_at=now() WHERE id=$4`,
      [balance, creditLimit, input.amount, input.userId],
    );
    await client.query(
      `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$3,'adjustment',$4,$5,'user',$6,$7,$8)`,
      [input.requestId, input.userId, input.actorId, input.amount, balance, input.userId, input.reason,
        JSON.stringify({ scope: "temporary", periodStart: user.credit_period_start })],
    );
    return { balance, duplicate: false };
  });
}

export async function reserveCredits(
  db: Database,
  input: {
    requestId: string;
    userId: string;
    operationType: string;
    modelConfigId?: string | null;
    quantity: number;
  },
) {
  return withTransaction(db, async (client) => {
    const existing = await client.query<{
      status: string;
      credits: number;
      rmb_cost: string;
      price_snapshot: PriceSnapshot;
    }>(
      "SELECT status,credits,rmb_cost,price_snapshot FROM credit_reservations WHERE request_id=$1",
      [input.requestId],
    );
    if (existing.rows[0])
      return {
        ...existing.rows[0],
        rmbCost: Number(existing.rows[0].rmb_cost),
        snapshot: existing.rows[0].price_snapshot,
        duplicate: true,
      };
    const priceResult = await client.query<{
      credits: number;
      rmb_cost: string;
      version: number;
    }>(
      "SELECT credits,rmb_cost,version FROM pricing_rule_versions WHERE operation_type=$1 AND status='published'",
      [input.operationType],
    );
    const price = priceResult.rows[0];
    if (!price)
      throw new BillingError(
        "PRICE_NOT_CONFIGURED",
        "管理员尚未发布该操作的价格",
      );
    const modelResult = input.modelConfigId
      ? await client.query<{
          id: string;
          credit_cost: number;
          rmb_cost: string;
          capabilities: string[];
        }>(
          `SELECT m.id,m.credit_cost,m.rmb_cost,m.capabilities
            FROM model_configs m JOIN providers p ON p.id=m.provider_id
            WHERE m.id=$1 AND m.enabled=true AND p.enabled=true`,
          [input.modelConfigId],
        )
      : null;
    if (input.modelConfigId && !modelResult?.rows[0])
      throw new BillingError("MODEL_DISABLED", "模型不存在或未启用");
    const model = modelResult?.rows[0];
    if (
      model &&
      !modelSupportsOperation(input.operationType, model.capabilities)
    ) {
      throw new BillingError(
        "MODEL_CAPABILITY_MISMATCH",
        "所选模型不支持当前操作",
      );
    }
    const snapshot = calculatePrice({
      operationType: input.operationType,
      operationCredits: price.credits,
      operationRmb: Number(price.rmb_cost),
      modelId: model?.id ?? null,
      modelCredits: model?.credit_cost ?? 0,
      modelRmb: Number(model?.rmb_cost ?? 0),
      quantity: input.quantity,
      priceVersion: price.version,
    });
    const identityResult = await client.query<{ department_id: string | null }>(
      "SELECT department_id FROM users WHERE id=$1 AND status='active'",
      [input.userId],
    );
    const identity = identityResult.rows[0];
    if (!identity)
      throw new BillingError("ACCOUNT_DISABLED", "账号不存在或已停用");
    let departmentBalance: number | null = null;
    if (identity.department_id) {
      const departmentResult = await client.query<{
        credit_balance: number;
        credit_limit: number;
      }>(
        "SELECT credit_balance,credit_limit FROM departments WHERE id=$1 FOR UPDATE",
        [identity.department_id],
      );
      const department = departmentResult.rows[0];
      if (department && department.credit_limit > 0) {
        if (department.credit_balance < snapshot.totalCredits)
          throw new BillingError(
            "DEPARTMENT_CREDIT_EXHAUSTED",
            "部门预算积分不足",
          );
        departmentBalance = department.credit_balance - snapshot.totalCredits;
        await client.query(
          "UPDATE departments SET credit_balance=$1,updated_at=now() WHERE id=$2",
          [departmentBalance, identity.department_id],
        );
      }
    }
    const periodUser = await ensureMonthlyCreditPeriod(client, input.userId);
    const userResult = await client.query<{
      credit_balance: number;
      department_id: string | null;
      credit_period_start: string;
    }>(
      "SELECT credit_balance,department_id,credit_period_start::text FROM users WHERE id=$1 AND status='active'",
      [input.userId],
    );
    const user = userResult.rows[0];
    if (!user) throw new BillingError("ACCOUNT_DISABLED", "账号不存在或已停用");
    if (user.department_id !== identity.department_id)
      throw new BillingError("ACCOUNT_CHANGED", "账号部门刚刚发生变更，请重试");
    if (user.credit_balance < snapshot.totalCredits)
      throw new BillingError("INSUFFICIENT_CREDIT", "个人剩余积分不足");
    const userBalance = user.credit_balance - snapshot.totalCredits;
    await client.query(
      "UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2",
      [userBalance, input.userId],
    );
    await client.query(
      `INSERT INTO credit_reservations(request_id,user_id,department_id,operation_type,model_config_id,quantity,credits,department_credits,rmb_cost,price_snapshot,credit_period_start)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date)`,
      [
        input.requestId,
        input.userId,
        user.department_id,
        input.operationType,
        model?.id ?? null,
        input.quantity,
        snapshot.totalCredits,
        departmentBalance === null ? 0 : snapshot.totalCredits,
        snapshot.totalRmb,
        snapshot,
        periodUser.credit_period_start,
      ],
    );
    await client.query(
      `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
            VALUES($1,$2,$2,'hold',$3,$4,'task',$5,'任务提交冻结积分',$6)`,
      [
        `${input.requestId}:user:hold`,
        input.userId,
        -snapshot.totalCredits,
        userBalance,
        input.requestId,
        snapshot,
      ],
    );
    if (departmentBalance !== null && user.department_id) {
      await client.query(
        `INSERT INTO credit_ledger(request_id,department_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
                VALUES($1,$2,$3,'hold',$4,$5,'task',$6,'任务提交冻结部门预算',$7)`,
        [
          `${input.requestId}:department:hold`,
          user.department_id,
          input.userId,
          -snapshot.totalCredits,
          departmentBalance,
          input.requestId,
          snapshot,
        ],
      );
    }
    return {
      status: "held",
      credits: snapshot.totalCredits,
      rmbCost: snapshot.totalRmb,
      snapshot,
      duplicate: false,
    };
  });
}

export async function settleReservation(
  db: Database,
  requestId: string,
  outcome: "capture" | "release",
  actorId?: string,
) {
  return withTransaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      user_id: string;
      department_id: string | null;
      credits: number;
      department_credits: number;
      status: string;
      credit_period_start: string;
    }>(
      "SELECT id,user_id,department_id,credits,department_credits,status,credit_period_start::text FROM credit_reservations WHERE request_id=$1 FOR UPDATE",
      [requestId],
    );
    const reservation = result.rows[0];
    if (!reservation)
      throw new BillingError("RESERVATION_NOT_FOUND", "额度冻结记录不存在");
    if (reservation.status !== "held")
      return { status: reservation.status, duplicate: true };
    if (outcome === "capture") {
      await client.query(
        "UPDATE credit_reservations SET status='captured',settled_at=now() WHERE id=$1",
        [reservation.id],
      );
      if (reservation.department_id && reservation.department_credits > 0) {
        const department = await client.query<{ credit_balance: number }>(
          "SELECT credit_balance FROM departments WHERE id=$1 FOR SHARE",
          [reservation.department_id],
        );
        await client.query(
          `INSERT INTO credit_ledger(request_id,department_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                    VALUES($1,$2,$3,'capture',0,$4,'task',$5,'任务成功结算部门预算')`,
          [
            `${requestId}:department:capture`,
            reservation.department_id,
            actorId ?? reservation.user_id,
            department.rows[0]!.credit_balance,
            requestId,
          ],
        );
      }
      const user = await ensureMonthlyCreditPeriod(client, reservation.user_id, actorId ?? reservation.user_id);
      await client.query(
        `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                VALUES($1,$2,$3,'capture',0,$4,'task',$5,'任务成功结算')`,
        [
          `${requestId}:user:capture`,
          reservation.user_id,
          actorId ?? reservation.user_id,
          user.credit_balance,
          requestId,
        ],
      );
      return { status: "captured", duplicate: false };
    }
    if (reservation.department_id && reservation.department_credits > 0) {
      const department = await client.query<{ credit_balance: number }>(
        "SELECT credit_balance FROM departments WHERE id=$1 FOR UPDATE",
        [reservation.department_id],
      );
      if (department.rows[0]) {
        const balance =
          department.rows[0].credit_balance + reservation.department_credits;
        await client.query(
          "UPDATE departments SET credit_balance=$1,updated_at=now() WHERE id=$2",
          [balance, reservation.department_id],
        );
        await client.query(
          `INSERT INTO credit_ledger(request_id,department_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
                    VALUES($1,$2,$3,'release',$4,$5,'task',$6,'任务释放部门预算')`,
          [
            `${requestId}:department:release`,
            reservation.department_id,
            actorId ?? reservation.user_id,
            reservation.department_credits,
            balance,
            requestId,
          ],
        );
      }
    }
    const user = await ensureMonthlyCreditPeriod(client, reservation.user_id, actorId ?? reservation.user_id);
    const releasedCredits = user.credit_period_start === reservation.credit_period_start ? reservation.credits : 0;
    const userBalance = user.credit_balance + releasedCredits;
    await client.query(
      "UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2",
      [userBalance, reservation.user_id],
    );
    await client.query(
      `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason)
            VALUES($1,$2,$3,'release',$4,$5,'task',$6,'任务失败、取消或超时释放积分')`,
      [
        `${requestId}:user:release`,
        reservation.user_id,
        actorId ?? reservation.user_id,
        releasedCredits,
        userBalance,
        requestId,
      ],
    );
    await client.query(
      "UPDATE credit_reservations SET status='released',settled_at=now() WHERE id=$1",
      [reservation.id],
    );
    return { status: "released", duplicate: false };
  });
}

export class BillingError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
