import type { Database } from "./db";
import type { PoolClient } from "pg";
import { getApimartImageCost, type ApimartImageCost } from "../../shared/apimart-image-costs";
import { withTransaction } from "./db-transaction";
import type { ToolConfiguration } from "./tool-configuration";
import { ensureGroupCreditPeriod } from "./group-credits";
import {
  ensureMonthlyCreditPeriod,
  refreshMonthlyCreditPeriod,
} from "./monthly-credits";

export { ensureMonthlyCreditPeriod, refreshMonthlyCreditPeriod };

export type PriceSnapshot = {
  imageCost?: ApimartImageCost;
  settledQuantity?: number;
  settledTotalRmb?: number;
  toolKey?: string;
  configurationVersion?: number;
  creditCostOverride?: number | null;
  rmbCostOverride?: number | null;
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
      (input.creditCostOverride ?? (input.operationCredits + input.modelCredits)) * input.quantity,
    totalRmb:
      Math.round(
        (input.imageCost?.rmbPerImage ?? input.rmbCostOverride ?? (input.operationRmb + input.modelRmb)) * input.quantity * 1_000_000,
      ) / 1_000_000,
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
  chat: ["chat"],
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

type TaskPricingInput = {
  operationType: string;
  modelConfigId?: string | null;
  toolConfiguration?: ToolConfiguration;
  quantity: number;
  creditsEnabled?: boolean;
};

/** Capture once for a batch. Later configuration edits cannot change its per-item total. */
export async function loadTaskPriceSnapshot(client: Pick<Database, "query">, input: TaskPricingInput): Promise<PriceSnapshot> {
  const priceResult = await client.query<{ credits: number; rmb_cost: string; version: number }>(
    "SELECT credits,rmb_cost,version FROM pricing_rule_versions WHERE operation_type=$1 AND status='published'", [input.operationType],
  );
  const creditsEnabled = input.creditsEnabled !== false;
  const overrides = input.toolConfiguration;
  const price = priceResult.rows[0] ?? (!creditsEnabled || input.operationType === "chat" || (overrides?.creditCostOverride != null && overrides?.rmbCostOverride != null) ? { credits: 0, rmb_cost: "0", version: 0 } : undefined);
  if (!price) throw new BillingError("PRICE_NOT_CONFIGURED", "管理员尚未发布该操作的价格");
  const modelResult = input.modelConfigId ? await client.query<{
    id: string; provider_id: string; model_id: string; credit_cost: number; rmb_cost: string; capabilities: string[];
  }>(`SELECT m.id,m.provider_id,m.model_id,m.credit_cost,m.rmb_cost,m.capabilities
       FROM model_configs m JOIN providers p ON p.id=m.provider_id
       LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id
       WHERE m.id=$1 AND m.enabled=true AND p.enabled=true AND (m.workflow_config_id IS NULL OR w.enabled=true)`, [input.modelConfigId]) : null;
  const model = modelResult?.rows[0];
  if (input.modelConfigId && !model) throw new BillingError("MODEL_DISABLED", "模型不存在或未启用");
  if (model && !modelSupportsOperation(input.operationType, model.capabilities)) throw new BillingError("MODEL_CAPABILITY_MISMATCH", "所选模型不支持当前操作");
  const snapshot = calculatePrice({
    ...(model && input.operationType !== "chat" ? { imageCost: getApimartImageCost(model.provider_id, model.model_id) ?? undefined } : {}),
    toolKey: overrides?.toolKey,
    configurationVersion: overrides?.configurationVersion,
    creditCostOverride: overrides?.creditCostOverride,
    rmbCostOverride: overrides?.rmbCostOverride,
    operationType: input.operationType,
    operationCredits: price.credits,
    operationRmb: Number(price.rmb_cost),
    modelId: model?.id ?? null,
    modelCredits: model?.credit_cost ?? 0,
    modelRmb: Number(model?.rmb_cost ?? 0),
    quantity: input.quantity,
    priceVersion: price.version,
  });
  if (!creditsEnabled) snapshot.totalCredits = 0;
  return snapshot;
}

export async function adjustCredits(
  db: Database,
  input: { requestId: string; actorId: string; userId: string; amount: number; reason: string },
  transactionClient?: PoolClient,
) {
  return changeCreditBalance(db, { ...input, mode: "add", value: input.amount }, transactionClient);
}

export async function setCreditBalance(
  db: Database,
  input: { requestId: string; actorId: string; userId: string; balance: number; reason: string },
  transactionClient?: PoolClient,
) {
  return changeCreditBalance(db, { ...input, mode: "set", value: input.balance }, transactionClient);
}

async function changeCreditBalance(
  db: Database,
  input: { requestId: string; actorId: string; userId: string; mode: "add" | "set"; value: number; reason: string },
  transactionClient?: PoolClient,
) {
  const change = async (client: PoolClient) => {
    if (!Number.isSafeInteger(input.value) || Math.abs(input.value) > 2_147_483_647 || (input.mode === "set" && input.value < 0)) {
      throw new BillingError("INVALID_CREDIT", "积分必须是有效范围内的整数，设置余额不能小于 0");
    }
    // Serialize reused request IDs even when callers target different users. The
    // user's monthly balance is locked before checking or applying the adjustment.
    const user = await ensureMonthlyCreditPeriod(client, input.userId, input.actorId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`account-credit:${input.requestId}`]);
    const duplicate = await client.query<{
      user_id: string | null; actor_user_id: string | null; entry_type: string;
      balance_after: number; amount: number; reason: string;
      metadata: { mode?: string; requestedValue?: number; balanceBefore?: number };
    }>(
      "SELECT user_id,actor_user_id,entry_type,balance_after,amount,reason,metadata FROM credit_ledger WHERE request_id=$1",
      [input.requestId],
    );
    const previous = duplicate.rows[0];
    if (previous) {
      if (previous.user_id !== input.userId || previous.actor_user_id !== input.actorId || previous.entry_type !== "adjustment"
        || previous.metadata.mode !== input.mode || previous.metadata.requestedValue !== input.value || previous.reason !== input.reason) {
        throw new BillingError("CREDIT_REQUEST_CONFLICT", "该请求编号已用于其他积分操作，请刷新后重试");
      }
      return { balance: previous.balance_after, balanceBefore: previous.metadata.balanceBefore!, amount: previous.amount, duplicate: true };
    }
    const balanceBefore = user.credit_balance;
    const balance = input.mode === "set" ? input.value : balanceBefore + input.value;
    if (balance < 0) throw new BillingError("INVALID_CREDIT", "本月临时扣减不能使剩余积分低于 0");
    const amount = balance - balanceBefore;
    if (balance > 2_147_483_647 || Math.abs(user.temporary_credit_adjustment + amount) > 2_147_483_647) {
      throw new BillingError("INVALID_CREDIT", "积分调整超过可保存范围");
    }
    // Holds have already left the available balance but can still return on a
    // failed/cancelled task. Keep room for every current-period personal refund.
    // Do not lock reservation rows here: settlement locks them before the user.
    const held = await client.query<{ credits: string }>(
      `SELECT COALESCE(SUM(personal_credits),0)::text AS credits FROM credit_reservations
        WHERE user_id=$1 AND status='held' AND credit_period_start=$2::date`,
      [input.userId, user.credit_period_start],
    );
    if (balance + Number(held.rows[0]!.credits) > 2_147_483_647) {
      throw new BillingError("INVALID_CREDIT", "积分余额与当前冻结积分之和超过可保存范围");
    }
    const creditLimit = Math.max(user.credit_limit, balance);
    await client.query(
      `UPDATE users SET credit_balance=$1,credit_limit=$2,
         temporary_credit_adjustment=temporary_credit_adjustment+$3,updated_at=now() WHERE id=$4`,
      [balance, creditLimit, amount, input.userId],
    );
    await client.query(
      `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$3,'adjustment',$4,$5,'user',$6,$7,$8)`,
      [input.requestId, input.userId, input.actorId, amount, balance, input.userId, input.reason,
        JSON.stringify({ scope: "temporary", periodStart: user.credit_period_start, mode: input.mode, requestedValue: input.value, balanceBefore })],
    );
    return { balance, balanceBefore, amount, duplicate: false };
  };
  return transactionClient ? change(transactionClient) : withTransaction(db, change);
}

export async function reserveCredits(
  db: Database,
  input: {
    requestId: string;
    userId: string;
    operationType: string;
    modelConfigId?: string | null;
    toolConfiguration?: ToolConfiguration;
    quantity: number;
    creditsEnabled?: boolean;
    priceSnapshot?: PriceSnapshot;
  },
  transactionClient?: PoolClient,
) {
  const reserve = async (client: PoolClient) => {
    // A reservation can also be submitted without a task row. Serialize its ID
    // before lookup so concurrent retries cannot race the unique INSERT below.
    // Existing department -> group -> user balance-lock ordering is unchanged.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`reservation:${input.requestId}`]);
    const existing = await client.query<{
      user_id: string;
      operation_type: string;
      model_config_id: string | null;
      quantity: number;
      status: string;
      credits: number;
      rmb_cost: string;
      price_snapshot: PriceSnapshot;
    }>(
      "SELECT user_id,operation_type,model_config_id,quantity,status,credits,rmb_cost,price_snapshot FROM credit_reservations WHERE request_id=$1",
      [input.requestId],
    );
    const previous = existing.rows[0];
    if (previous) {
      if (previous.user_id !== input.userId) throw new BillingError("DUPLICATE_REQUEST", "请求编号已被其他账号占用");
      if (previous.operation_type !== input.operationType || previous.model_config_id !== (input.modelConfigId ?? null)
        || previous.quantity !== input.quantity || (previous.price_snapshot.toolKey ?? null) !== (input.toolConfiguration?.toolKey ?? null)) {
        throw new BillingError("DUPLICATE_REQUEST", "请求编号已用于不同的积分冻结操作");
      }
      // Prices, configuration versions and the deployment's current credit switch
      // may change after submission; identical retries retain their original hold.
      return {
        status: previous.status,
        credits: previous.credits,
        rmbCost: Number(previous.rmb_cost),
        snapshot: previous.price_snapshot,
        duplicate: true,
      };
    }
    const creditsEnabled = input.creditsEnabled !== false;
    const snapshot = input.priceSnapshot ?? await loadTaskPriceSnapshot(client, input);
    const identityResult = await client.query<{ department_id: string | null }>(
      "SELECT department_id FROM users WHERE id=$1 AND status='active'",
      [input.userId],
    );
    const identity = identityResult.rows[0];
    if (!identity)
      throw new BillingError("ACCOUNT_DISABLED", "账号不存在或已停用");
    if (!creditsEnabled) {
      await client.query(
        `INSERT INTO credit_reservations(request_id,user_id,operation_type,model_config_id,quantity,credits,rmb_cost,price_snapshot)
         VALUES($1,$2,$3,$4,$5,0,$6,$7)`,
        [input.requestId, input.userId, input.operationType, snapshot.modelId, input.quantity, snapshot.totalRmb, { ...snapshot, billingDisabled: true }],
      );
      return { status: "held", credits: 0, rmbCost: snapshot.totalRmb, snapshot, duplicate: false };
    }
    let departmentBalance: number | null = null;
    if (identity.department_id) {
      const departmentResult = await client.query<{
        credit_balance: number;
        credit_limit: number;
      }>(
        // Task foreign keys already hold KEY SHARE; serialize balances without a lock upgrade deadlock.
        "SELECT credit_balance,credit_limit FROM departments WHERE id=$1 FOR NO KEY UPDATE",
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
        snapshot.modelId,
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
  };
  return transactionClient ? reserve(transactionClient) : withTransaction(db, reserve);
}

export async function settleReservation(
  db: Database,
  requestId: string,
  outcome: "capture" | "release",
  actorId?: string,
  existingClient?: PoolClient,
  outputQuantity?: number,
) {
  const settle = async (client: PoolClient) => {
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
      billing_disabled: boolean;
      price_snapshot: PriceSnapshot;
    }>(
      `SELECT id,user_id,department_id,credits,department_credits,personal_credits,group_credits,
              group_id,group_period_start::text,status,credit_period_start::text,
              COALESCE((price_snapshot->>'billingDisabled')::boolean,false) AS billing_disabled,price_snapshot
         FROM credit_reservations WHERE request_id=$1 FOR UPDATE`,
      [requestId],
    );
    const reservation = result.rows[0];
    if (!reservation)
      throw new BillingError("RESERVATION_NOT_FOUND", "额度冻结记录不存在");
    if (reservation.status !== "held")
      return { status: reservation.status, duplicate: true };
    // Only new per-image snapshots settle against actual outputs. Keep the planned
    // snapshot, employee credit hold and historical/non-image billing unchanged.
    if (outcome === "capture" && reservation.price_snapshot?.imageCost && outputQuantity !== undefined) {
      if (!Number.isSafeInteger(outputQuantity) || outputQuantity < 1) {
        throw new BillingError("INVALID_OUTPUT_QUANTITY", "成功图片任务必须至少有一张有效结果");
      }
      const settledTotalRmb = Math.round(reservation.price_snapshot.imageCost.rmbPerImage * outputQuantity * 1_000_000) / 1_000_000;
      const snapshot = { ...reservation.price_snapshot, settledQuantity: outputQuantity, settledTotalRmb };
      await client.query("UPDATE credit_reservations SET rmb_cost=$1,price_snapshot=$2 WHERE id=$3", [settledTotalRmb, snapshot, reservation.id]);
      await client.query("UPDATE tasks SET rmb_cost=$1,updated_at=now() WHERE request_id=$2", [settledTotalRmb, requestId]);
    }
    if (reservation.billing_disabled) {
      const status = outcome === "capture" ? "captured" : "released";
      await client.query("UPDATE credit_reservations SET status=$1,settled_at=now() WHERE id=$2", [status, reservation.id]);
      return { status, duplicate: false };
    }
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
        "SELECT credit_balance FROM departments WHERE id=$1 FOR NO KEY UPDATE",
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
  };
  return existingClient ? settle(existingClient) : withTransaction(db, settle);
}

export class BillingError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
