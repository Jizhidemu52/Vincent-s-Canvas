import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { ensureGroupCreditPeriod } from "./group-credits";
import {
  ensureMonthlyCreditPeriod,
  refreshMonthlyCreditPeriod,
} from "./monthly-credits";

export { ensureMonthlyCreditPeriod, refreshMonthlyCreditPeriod };

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

export function splitCreditSources(personalBalance: number, totalCredits: number) {
  const personalCredits = Math.min(Math.max(0, personalBalance), totalCredits);
  return { personalCredits, groupCredits: totalCredits - personalCredits };
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
    const membership = await client.query<{ group_id: string }>(
      `SELECT gm.group_id FROM group_memberships gm
        JOIN designer_groups g ON g.id=gm.group_id
       WHERE gm.user_id=$1 AND gm.ended_at IS NULL AND g.status='active'`,
      [input.userId],
    );
    const groupContext = membership.rows[0]
      ? await ensureGroupCreditPeriod(client, membership.rows[0].group_id, input.userId)
      : null;
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
    const { personalCredits, groupCredits } = splitCreditSources(user.credit_balance, snapshot.totalCredits);
    let groupWalletBalance: number | null = null;
    if (groupCredits > 0) {
      if (!groupContext) throw new BillingError("INSUFFICIENT_CREDIT", "个人和小组可用积分不足");
      const wallet = await client.query<{ available_credits: number }>(
        `SELECT available_credits FROM group_credit_wallets
          WHERE group_id=$1 AND user_id=$2 AND period_start=$3::date FOR UPDATE`,
        [groupContext.group.id, input.userId, groupContext.period.period_start],
      );
      if (!wallet.rows[0] || wallet.rows[0].available_credits < groupCredits) {
        throw new BillingError("INSUFFICIENT_CREDIT", "个人和小组可用积分不足");
      }
      groupWalletBalance = wallet.rows[0].available_credits - groupCredits;
      await client.query(
        `UPDATE group_credit_wallets SET available_credits=$1,updated_at=now()
          WHERE group_id=$2 AND user_id=$3 AND period_start=$4::date`,
        [groupWalletBalance, groupContext.group.id, input.userId, groupContext.period.period_start],
      );
    }
    const userBalance = user.credit_balance - personalCredits;
    await client.query(
      "UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2",
      [userBalance, input.userId],
    );
    await client.query(
      `INSERT INTO credit_reservations(request_id,user_id,department_id,operation_type,model_config_id,
            quantity,credits,department_credits,rmb_cost,price_snapshot,credit_period_start,
            personal_credits,group_credits,group_id,group_period_start)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15::date)`,
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
        personalCredits,
        groupCredits,
        groupCredits > 0 ? groupContext!.group.id : null,
        groupCredits > 0 ? groupContext!.period.period_start : null,
      ],
    );
    await client.query(
      `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
            VALUES($1,$2,$2,'hold',$3,$4,'task',$5,'任务提交冻结积分',$6)`,
      [
        `${input.requestId}:user:hold`,
        input.userId,
        -personalCredits,
        userBalance,
        input.requestId,
        JSON.stringify({ ...snapshot, creditSource: { personalCredits, groupCredits } }),
      ],
    );
    if (groupCredits > 0 && groupContext) {
      await client.query(
        `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
          entry_type,wallet_amount,wallet_balance_after,reference_type,reference_id,reason,metadata)
         VALUES($1,$2,$3,$3,$4::date,'hold',$5,$6,'task',$7,
          '任务提交冻结已领取的小组额度',$8)`,
        [`${input.requestId}:group:hold`, groupContext.group.id, input.userId,
          groupContext.period.period_start, -groupCredits, groupWalletBalance,
          input.requestId, JSON.stringify(snapshot)],
      );
    }
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
      personal_credits: number;
      group_credits: number;
      group_id: string | null;
      group_period_start: string | null;
      status: string;
      credit_period_start: string;
    }>(
      `SELECT id,user_id,department_id,credits,department_credits,personal_credits,group_credits,
              group_id,group_period_start::text,status,credit_period_start::text
         FROM credit_reservations WHERE request_id=$1 FOR UPDATE`,
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
      if (reservation.group_id && reservation.group_period_start && reservation.group_credits > 0) {
        const wallet = await client.query<{ available_credits: number }>(
          `UPDATE group_credit_wallets SET spent_credits=spent_credits+$1,updated_at=now()
            WHERE group_id=$2 AND user_id=$3 AND period_start=$4::date
            RETURNING available_credits`,
          [reservation.group_credits, reservation.group_id, reservation.user_id, reservation.group_period_start],
        );
        await client.query(
          `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
            entry_type,wallet_amount,wallet_balance_after,reference_type,reference_id,reason)
           VALUES($1,$2,$3,$4,$5::date,'capture',0,$6,'task',$7,'任务成功结算小组额度')`,
          [`${requestId}:group:capture`, reservation.group_id, reservation.user_id,
            actorId ?? reservation.user_id, reservation.group_period_start,
            wallet.rows[0]?.available_credits ?? 0, requestId],
        );
      }
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
    const releasedCredits = user.credit_period_start === reservation.credit_period_start ? reservation.personal_credits : 0;
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
    if (reservation.group_id && reservation.group_period_start && reservation.group_credits > 0) {
      const currentPeriod = await client.query<{ period_start: string }>(
        "SELECT date_trunc('month', timezone('Asia/Shanghai', now()))::date::text AS period_start",
      );
      const groupReleased = currentPeriod.rows[0]!.period_start === reservation.group_period_start
        ? reservation.group_credits
        : 0;
      const wallet = await client.query<{ available_credits: number }>(
        `UPDATE group_credit_wallets SET available_credits=available_credits+$1,updated_at=now()
          WHERE group_id=$2 AND user_id=$3 AND period_start=$4::date
          RETURNING available_credits`,
        [groupReleased, reservation.group_id, reservation.user_id, reservation.group_period_start],
      );
      await client.query(
        `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
          entry_type,wallet_amount,wallet_balance_after,reference_type,reference_id,reason,metadata)
         VALUES($1,$2,$3,$4,$5::date,'release',$6,$7,'task',$8,
          '任务失败、取消或超时按原来源释放小组额度',$9)`,
        [`${requestId}:group:release`, reservation.group_id, reservation.user_id,
          actorId ?? reservation.user_id, reservation.group_period_start, groupReleased,
          wallet.rows[0]?.available_credits ?? 0, requestId,
          JSON.stringify({ expiredPeriod: groupReleased === 0 })],
      );
    }
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
