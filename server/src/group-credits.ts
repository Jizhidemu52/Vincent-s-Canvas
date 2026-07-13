import type { PoolClient } from "pg";

import { writeAudit } from "./audit";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import { ensureMonthlyCreditPeriod } from "./monthly-credits";
import type { SessionUser } from "./types";

type GroupPolicyRow = {
  id: string;
  department_id: string;
  status: string;
  monthly_shared_credit_limit: number;
  shared_credit_per_request_limit: number;
  shared_credit_daily_user_limit: number;
  shared_credit_monthly_user_limit: number;
  current_period_start: string;
};

type GroupPeriodRow = {
  id: string;
  group_id: string;
  period_start: string;
  fixed_credits: number;
  contributed_credits: number;
  allocated_credits: number;
  expired_credits: number;
  pool_balance: number;
  status: "active" | "closed";
};

type MembershipRow = {
  group_id: string;
  member_role: "member" | "leader";
};

const periodSelect = `id,group_id,period_start::text,fixed_credits,contributed_credits,
  allocated_credits,expired_credits,pool_balance,status`;

async function lockGroupPolicy(client: PoolClient, groupId: string) {
  const result = await client.query<GroupPolicyRow>(
    `SELECT id,department_id,status,monthly_shared_credit_limit,
            shared_credit_per_request_limit,shared_credit_daily_user_limit,
            shared_credit_monthly_user_limit,
            date_trunc('month', timezone('Asia/Shanghai', now()))::date::text AS current_period_start
       FROM designer_groups WHERE id=$1 FOR UPDATE`,
    [groupId],
  );
  const group = result.rows[0];
  if (!group) throw new GroupCreditError("GROUP_NOT_FOUND", "小组不存在", 404);
  if (group.status !== "active") throw new GroupCreditError("GROUP_DISABLED", "小组已停用", 409);
  return group;
}

async function activeMembership(client: PoolClient, userId: string) {
  const result = await client.query<MembershipRow>(
    `SELECT gm.group_id,gm.member_role
       FROM group_memberships gm JOIN designer_groups g ON g.id=gm.group_id
      WHERE gm.user_id=$1 AND gm.ended_at IS NULL AND g.status='active'`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function expireOldPeriods(
  client: PoolClient,
  group: GroupPolicyRow,
  actorId: string,
) {
  const oldPeriods = await client.query<GroupPeriodRow>(
    `SELECT ${periodSelect} FROM group_credit_periods
      WHERE group_id=$1 AND status='active' AND period_start<>$2::date
      ORDER BY period_start FOR UPDATE`,
    [group.id, group.current_period_start],
  );
  for (const period of oldPeriods.rows) {
    const wallets = await client.query<{
      user_id: string;
      available_credits: number;
    }>(
      `SELECT user_id,available_credits FROM group_credit_wallets
        WHERE group_id=$1 AND period_start=$2::date FOR UPDATE`,
      [group.id, period.period_start],
    );
    for (const wallet of wallets.rows) {
      if (wallet.available_credits <= 0) continue;
      await client.query(
        `UPDATE group_credit_wallets
            SET available_credits=0,expired_credits=expired_credits+$1,updated_at=now()
          WHERE group_id=$2 AND user_id=$3 AND period_start=$4::date`,
        [wallet.available_credits, group.id, wallet.user_id, period.period_start],
      );
      await client.query(
        `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
          entry_type,wallet_amount,wallet_balance_after,reference_type,reference_id,reason,metadata)
         VALUES($1,$2,$3,$4,$5::date,'period_expired',$6,0,'credit_period',($5::date)::text,
          '月末清零成员未使用的小组领取额度',$7) ON CONFLICT(request_id) DO NOTHING`,
        [
          `group-period-expire:${group.id}:${period.period_start}:${wallet.user_id}`,
          group.id,
          wallet.user_id,
          actorId,
          period.period_start,
          -wallet.available_credits,
          JSON.stringify({ timezone: "Asia/Shanghai" }),
        ],
      );
    }
    await client.query(
      `UPDATE group_credit_periods
          SET pool_balance=0,expired_credits=expired_credits+$1,status='closed',closed_at=now()
        WHERE id=$2`,
      [period.pool_balance, period.id],
    );
    await client.query(
      `INSERT INTO group_credit_ledger(request_id,group_id,actor_user_id,period_start,
        entry_type,pool_amount,pool_balance_after,reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$3,$4::date,'period_expired',$5,0,'credit_period',($4::date)::text,
        '月末清零小组共享池余额',$6) ON CONFLICT(request_id) DO NOTHING`,
      [
        `group-period-expire:${group.id}:${period.period_start}:pool`,
        group.id,
        actorId,
        period.period_start,
        -period.pool_balance,
        JSON.stringify({ timezone: "Asia/Shanghai" }),
      ],
    );
    const expiredRequests = await client.query<{ id: string; user_id: string; amount: number }>(
      `UPDATE group_credit_requests SET status='expired',updated_at=now()
        WHERE group_id=$1 AND period_start=$2::date AND status='pending'
        RETURNING id,user_id,amount`,
      [group.id, period.period_start],
    );
    for (const request of expiredRequests.rows) {
      await client.query(
        `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
          entry_type,reference_type,reference_id,reason,metadata)
         VALUES($1,$2,$3,$4,$5::date,'request_expired','group_credit_request',$6,
          '跨月未审批申请自动失效',$7) ON CONFLICT(request_id) DO NOTHING`,
        [`group-request:${request.id}:expired`, group.id, request.user_id, actorId,
          period.period_start, request.id, JSON.stringify({ amount: request.amount, timezone: "Asia/Shanghai" })],
      );
    }
  }
}

export async function closeActiveGroupCreditPeriods(
  client: PoolClient,
  groupId: string,
  actorId: string,
) {
  const result = await client.query<GroupPolicyRow>(
    `SELECT id,department_id,status,monthly_shared_credit_limit,
            shared_credit_per_request_limit,shared_credit_daily_user_limit,
            shared_credit_monthly_user_limit,'0001-01-01'::date::text AS current_period_start
       FROM designer_groups WHERE id=$1`,
    [groupId],
  );
  if (result.rows[0]) await expireOldPeriods(client, result.rows[0], actorId);
}

export async function ensureGroupCreditPeriod(
  client: PoolClient,
  groupId: string,
  actorId: string,
) {
  const group = await lockGroupPolicy(client, groupId);
  await expireOldPeriods(client, group, actorId);
  const inserted = await client.query<GroupPeriodRow>(
    `INSERT INTO group_credit_periods(group_id,period_start,fixed_credits,pool_balance)
     VALUES($1,$2::date,$3,$3) ON CONFLICT(group_id,period_start) DO NOTHING
     RETURNING ${periodSelect}`,
    [group.id, group.current_period_start, group.monthly_shared_credit_limit],
  );
  if (inserted.rows[0]) {
    await client.query(
      `INSERT INTO group_credit_ledger(request_id,group_id,actor_user_id,period_start,
        entry_type,pool_amount,pool_balance_after,reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$3,$4::date,'period_opened',$5,$5,'credit_period',($4::date)::text,
        '新自然月恢复小组固定共享额度',$6) ON CONFLICT(request_id) DO NOTHING`,
      [
        `group-period-open:${group.id}:${group.current_period_start}`,
        group.id,
        actorId,
        group.current_period_start,
        group.monthly_shared_credit_limit,
        JSON.stringify({ timezone: "Asia/Shanghai" }),
      ],
    );
    return { group, period: inserted.rows[0] };
  }
  const period = await client.query<GroupPeriodRow>(
    `SELECT ${periodSelect} FROM group_credit_periods
      WHERE group_id=$1 AND period_start=$2::date FOR UPDATE`,
    [group.id, group.current_period_start],
  );
  return { group, period: period.rows[0]! };
}

async function assertManager(client: PoolClient, actor: SessionUser, groupId: string) {
  if (actor.role === "super_admin") return;
  const group = await client.query<{ department_id: string }>(
    "SELECT department_id FROM designer_groups WHERE id=$1",
    [groupId],
  );
  if (
    (actor.role === "department_admin" && group.rows[0]?.department_id === actor.departmentId) ||
    (actor.role === "designer" && actor.groupRole === "leader" && actor.groupId === groupId)
  ) return;
  throw new GroupCreditError("FORBIDDEN", "无权管理该小组额度", 403);
}

export async function getMyGroupCredits(db: Database, actor: SessionUser) {
  return withTransaction(db, async (client) => {
    const membership = await activeMembership(client, actor.id);
    if (!membership) throw new GroupCreditError("GROUP_REQUIRED", "当前账号尚未加入有效小组", 409);
    const { group, period } = await ensureGroupCreditPeriod(client, membership.group_id, actor.id);
    const wallet = await client.query<{
      grantedCredits: number; availableCredits: number; spentCredits: number;
    }>(
      `SELECT granted_credits AS "grantedCredits",available_credits AS "availableCredits",
              spent_credits AS "spentCredits"
         FROM group_credit_wallets
        WHERE group_id=$1 AND user_id=$2 AND period_start=$3::date`,
      [group.id, actor.id, period.period_start],
    );
    const requests = await client.query(
      `SELECT id,request_id AS "requestId",amount,reason,status,decision_note AS "decisionNote",
              created_at AS "createdAt",reviewed_at AS "reviewedAt"
         FROM group_credit_requests WHERE group_id=$1 AND user_id=$2
        ORDER BY created_at DESC LIMIT 100`,
      [group.id, actor.id],
    );
    return {
      groupId: group.id,
      periodStart: period.period_start,
      poolBalance: period.pool_balance,
      policy: policyProjection(group),
      wallet: wallet.rows[0] ?? { grantedCredits: 0, availableCredits: 0, spentCredits: 0 },
      requests: requests.rows,
    };
  });
}

export async function getManagedGroupCredits(
  db: Database,
  actor: SessionUser,
  groupId: string,
) {
  return withTransaction(db, async (client) => {
    await assertManager(client, actor, groupId);
    const { group, period } = await ensureGroupCreditPeriod(client, groupId, actor.id);
    const requests = await client.query(
      `SELECT r.id,r.request_id AS "requestId",r.user_id AS "userId",u.display_name AS "userName",
              r.amount,r.reason,r.status,r.decision_note AS "decisionNote",r.created_at AS "createdAt",
              r.reviewed_at AS "reviewedAt",reviewer.display_name AS "reviewerName"
         FROM group_credit_requests r JOIN users u ON u.id=r.user_id
         LEFT JOIN users reviewer ON reviewer.id=r.reviewed_by
        WHERE r.group_id=$1 ORDER BY (r.status='pending') DESC,r.created_at DESC LIMIT 500`,
      [groupId],
    );
    const wallets = await client.query(
      `SELECT w.user_id AS "userId",u.display_name AS "userName",w.granted_credits AS "grantedCredits",
              w.available_credits AS "availableCredits",w.spent_credits AS "spentCredits"
         FROM group_credit_wallets w JOIN users u ON u.id=w.user_id
        WHERE w.group_id=$1 AND w.period_start=$2::date ORDER BY u.display_name`,
      [groupId, period.period_start],
    );
    const ledger = await client.query(
      `SELECT id,entry_type AS "entryType",user_id AS "userId",pool_amount AS "poolAmount",
              wallet_amount AS "walletAmount",pool_balance_after AS "poolBalanceAfter",
              wallet_balance_after AS "walletBalanceAfter",reason,created_at AS "createdAt"
         FROM group_credit_ledger WHERE group_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [groupId],
    );
    return {
      groupId,
      period: {
        periodStart: period.period_start,
        fixedCredits: period.fixed_credits,
        contributedCredits: period.contributed_credits,
        allocatedCredits: period.allocated_credits,
        expiredCredits: period.expired_credits,
        poolBalance: period.pool_balance,
      },
      policy: policyProjection(group),
      requests: requests.rows,
      wallets: wallets.rows,
      ledger: ledger.rows,
    };
  });
}

export async function configureGroupCreditPolicy(
  db: Database,
  input: {
    actor: SessionUser;
    groupId: string;
    monthlySharedCreditLimit: number;
    perRequestLimit: number;
    dailyUserLimit: number;
    monthlyUserLimit: number;
    applyCurrentPeriod: boolean;
    ip?: string;
  },
) {
  return withTransaction(db, async (client) => {
    await assertManager(client, input.actor, input.groupId);
    if (input.actor.role === "designer") {
      throw new GroupCreditError("FORBIDDEN", "组长不能提高或修改小组总额度", 403);
    }
    const { group, period } = await ensureGroupCreditPeriod(client, input.groupId, input.actor.id);
    await client.query(
      `UPDATE designer_groups SET monthly_shared_credit_limit=$1,
              shared_credit_per_request_limit=$2,shared_credit_daily_user_limit=$3,
              shared_credit_monthly_user_limit=$4,shared_credit_updated_by=$5,
              shared_credit_updated_at=now(),updated_at=now() WHERE id=$6`,
      [input.monthlySharedCreditLimit, input.perRequestLimit, input.dailyUserLimit,
        input.monthlyUserLimit, input.actor.id, input.groupId],
    );
    if (input.applyCurrentPeriod && input.monthlySharedCreditLimit !== period.fixed_credits) {
      const delta = input.monthlySharedCreditLimit - period.fixed_credits;
      const balance = period.pool_balance + delta;
      if (balance < 0) {
        throw new GroupCreditError("POOL_ALREADY_ALLOCATED", "本月已分配额度超过新的固定额度，不能直接调低", 409);
      }
      await client.query(
        `UPDATE group_credit_periods SET fixed_credits=$1,pool_balance=$2 WHERE id=$3`,
        [input.monthlySharedCreditLimit, balance, period.id],
      );
      await client.query(
        `INSERT INTO group_credit_ledger(request_id,group_id,actor_user_id,period_start,
          entry_type,pool_amount,pool_balance_after,reference_type,reference_id,reason,metadata)
         VALUES($1,$2,$3,$4::date,'correction',$5,$6,'group_policy',($2::uuid)::text,
          '管理员同步调整本月小组固定额度',$7)`,
        [`group-policy:${input.groupId}:${crypto.randomUUID()}`, input.groupId, input.actor.id,
          period.period_start, delta, balance, JSON.stringify({ previousFixedCredits: period.fixed_credits })],
      );
    }
    await writeAudit(client, {
      actor: input.actor,
      action: "group.credit_policy_updated",
      targetType: "group",
      targetId: input.groupId,
      departmentId: group.department_id,
      result: "success",
      detail: { ...input, actor: undefined, ip: undefined },
      ip: input.ip,
    });
    return getManagedSnapshotInTransaction(client, input.groupId);
  });
}

export async function submitGroupCreditRequest(
  db: Database,
  input: { actor: SessionUser; requestId: string; amount: number; reason: string; ip?: string },
) {
  return withTransaction(db, async (client) => {
    const duplicate = await client.query<{ id: string; user_id: string; status: string }>(
      "SELECT id,user_id,status FROM group_credit_requests WHERE request_id=$1",
      [input.requestId],
    );
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].user_id !== input.actor.id) throw new GroupCreditError("DUPLICATE_REQUEST", "请求编号已被使用", 409);
      return { id: duplicate.rows[0].id, status: duplicate.rows[0].status, duplicate: true };
    }
    const membership = await activeMembership(client, input.actor.id);
    if (!membership) throw new GroupCreditError("GROUP_REQUIRED", "当前账号尚未加入有效小组", 409);
    const { group, period } = await ensureGroupCreditPeriod(client, membership.group_id, input.actor.id);
    if (group.shared_credit_per_request_limit <= 0 || input.amount > group.shared_credit_per_request_limit) {
      throw new GroupCreditError("CLAIM_LIMIT_EXCEEDED", "申请积分超过单次领取上限", 400);
    }
    const inserted = await client.query<{ id: string; status: string }>(
      `INSERT INTO group_credit_requests(request_id,group_id,user_id,period_start,amount,reason)
       VALUES($1,$2,$3,$4::date,$5,$6) RETURNING id,status`,
      [input.requestId, group.id, input.actor.id, period.period_start, input.amount, input.reason],
    );
    await client.query(
      `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
        entry_type,reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$3,$3,$4::date,'request_submitted','group_credit_request',$5,
        '成员提交小组共享额度申请',$6)`,
      [`${input.requestId}:submitted`, group.id, input.actor.id, period.period_start,
        inserted.rows[0]!.id, JSON.stringify({ amount: input.amount, reason: input.reason })],
    );
    await writeAudit(client, { actor: input.actor, action: "group.credit_requested", targetType: "group_credit_request",
      targetId: inserted.rows[0]!.id, departmentId: input.actor.departmentId, result: "success",
      detail: { groupId: group.id, amount: input.amount }, ip: input.ip });
    return { ...inserted.rows[0]!, duplicate: false };
  });
}

export async function decideGroupCreditRequest(
  db: Database,
  input: { actor: SessionUser; requestId: string; decision: "approved" | "rejected"; note?: string; ip?: string },
) {
  return withTransaction(db, async (client) => {
    const result = await client.query<{
      id: string; group_id: string; user_id: string; period_start: string; amount: number; status: string;
    }>(
      `SELECT id,group_id,user_id,period_start::text,amount,status
         FROM group_credit_requests WHERE id=$1 FOR UPDATE`,
      [input.requestId],
    );
    const request = result.rows[0];
    if (!request) throw new GroupCreditError("REQUEST_NOT_FOUND", "额度申请不存在", 404);
    await assertManager(client, input.actor, request.group_id);
    if (request.status === input.decision) return { status: request.status, duplicate: true };
    if (request.status !== "pending") throw new GroupCreditError("REQUEST_ALREADY_DECIDED", "该申请已处理", 409);
    if (input.decision === "approved" && request.user_id === input.actor.id) {
      throw new GroupCreditError("SELF_APPROVAL_FORBIDDEN", "组长不能审批自己的额度申请", 403);
    }
    const membership = await activeMembership(client, request.user_id);
    if (!membership || membership.group_id !== request.group_id) {
      throw new GroupCreditError("MEMBERSHIP_CHANGED", "申请人已离组、调组或停用，不能继续审批", 409);
    }
    const { group, period } = await ensureGroupCreditPeriod(client, request.group_id, input.actor.id);
    if (request.period_start !== period.period_start) {
      throw new GroupCreditError("REQUEST_EXPIRED", "该申请已跨月失效", 409);
    }
    if (input.decision === "rejected") {
      await client.query(
        `UPDATE group_credit_requests SET status='rejected',decision_note=$1,reviewed_by=$2,
          reviewed_at=now(),updated_at=now() WHERE id=$3`,
        [input.note ?? null, input.actor.id, request.id],
      );
      await client.query(
        `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
          entry_type,reference_type,reference_id,reason,metadata)
         VALUES($1,$2,$3,$4,$5::date,'request_rejected','group_credit_request',$6,
          '组长或管理员拒绝额度申请',$7)`,
        [`group-request:${request.id}:rejected`, request.group_id, request.user_id, input.actor.id,
          request.period_start, request.id, JSON.stringify({ amount: request.amount, note: input.note })],
      );
      await writeAudit(client, { actor: input.actor, action: "group.credit_request_rejected",
        targetType: "group_credit_request", targetId: request.id, departmentId: input.actor.departmentId,
        result: "success", detail: { groupId: request.group_id, userId: request.user_id, amount: request.amount }, ip: input.ip });
      return { status: "rejected", duplicate: false };
    }
    if (request.amount > group.shared_credit_per_request_limit) {
      throw new GroupCreditError("CLAIM_LIMIT_EXCEEDED", "申请积分超过单次领取上限", 409);
    }
    const usage = await client.query<{ daily: number; monthly: number }>(
      `SELECT coalesce(sum(amount) FILTER (
                WHERE timezone('Asia/Shanghai',reviewed_at)::date=timezone('Asia/Shanghai',now())::date
              ),0)::int AS daily,
              coalesce(sum(amount),0)::int AS monthly
         FROM group_credit_requests
        WHERE user_id=$1 AND group_id=$2 AND period_start=$3::date AND status='approved'`,
      [request.user_id, request.group_id, period.period_start],
    );
    if (group.shared_credit_daily_user_limit <= 0 || usage.rows[0]!.daily + request.amount > group.shared_credit_daily_user_limit) {
      throw new GroupCreditError("DAILY_LIMIT_EXCEEDED", "该成员今日领取额度已达上限", 409);
    }
    if (group.shared_credit_monthly_user_limit <= 0 || usage.rows[0]!.monthly + request.amount > group.shared_credit_monthly_user_limit) {
      throw new GroupCreditError("MONTHLY_LIMIT_EXCEEDED", "该成员本月领取额度已达上限", 409);
    }
    if (period.pool_balance < request.amount) throw new GroupCreditError("POOL_CREDIT_EXHAUSTED", "小组共享池积分不足", 409);
    const poolBalance = period.pool_balance - request.amount;
    await client.query(
      `UPDATE group_credit_periods SET pool_balance=$1,allocated_credits=allocated_credits+$2 WHERE id=$3`,
      [poolBalance, request.amount, period.id],
    );
    const wallet = await client.query<{ available_credits: number }>(
      `INSERT INTO group_credit_wallets(group_id,user_id,period_start,granted_credits,available_credits)
       VALUES($1,$2,$3::date,$4,$4)
       ON CONFLICT(group_id,user_id,period_start) DO UPDATE SET
         granted_credits=group_credit_wallets.granted_credits+EXCLUDED.granted_credits,
         available_credits=group_credit_wallets.available_credits+EXCLUDED.available_credits,
         updated_at=now()
       RETURNING available_credits`,
      [request.group_id, request.user_id, period.period_start, request.amount],
    );
    await client.query(
      `UPDATE group_credit_requests SET status='approved',decision_note=$1,reviewed_by=$2,
        reviewed_at=now(),updated_at=now() WHERE id=$3`,
      [input.note ?? null, input.actor.id, request.id],
    );
    await client.query(
      `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
        entry_type,pool_amount,wallet_amount,pool_balance_after,wallet_balance_after,
        reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$3,$4,$5::date,'allocation_approved',$6,$7,$8,$9,
        'group_credit_request',$10,'审批通过并发放本月小组额度',$11)`,
      [`group-request:${request.id}:approved`, request.group_id, request.user_id, input.actor.id,
        period.period_start, -request.amount, request.amount, poolBalance,
        wallet.rows[0]!.available_credits, request.id, JSON.stringify({ note: input.note })],
    );
    await writeAudit(client, { actor: input.actor, action: "group.credit_request_approved",
      targetType: "group_credit_request", targetId: request.id, departmentId: input.actor.departmentId,
      result: "success", detail: { groupId: request.group_id, userId: request.user_id, amount: request.amount }, ip: input.ip });
    return { status: "approved", duplicate: false };
  });
}

export async function contributePersonalCredits(
  db: Database,
  input: { actor: SessionUser; requestId: string; amount: number; ip?: string },
) {
  return withTransaction(db, async (client) => {
    const duplicate = await client.query<{ pool_balance_after: number | null }>(
      "SELECT pool_balance_after FROM group_credit_ledger WHERE request_id=$1",
      [input.requestId],
    );
    if (duplicate.rows[0]) return { poolBalance: duplicate.rows[0].pool_balance_after ?? 0, duplicate: true };
    const membership = await activeMembership(client, input.actor.id);
    if (!membership) throw new GroupCreditError("GROUP_REQUIRED", "当前账号尚未加入有效小组", 409);
    const { period } = await ensureGroupCreditPeriod(client, membership.group_id, input.actor.id);
    const user = await ensureMonthlyCreditPeriod(client, input.actor.id, input.actor.id);
    if (input.amount > user.credit_balance) throw new GroupCreditError("INSUFFICIENT_PERSONAL_CREDIT", "个人本月未使用积分不足", 409);
    const userBalance = user.credit_balance - input.amount;
    const poolBalance = period.pool_balance + input.amount;
    await client.query("UPDATE users SET credit_balance=$1,updated_at=now() WHERE id=$2", [userBalance, input.actor.id]);
    await client.query(
      `UPDATE group_credit_periods SET pool_balance=$1,contributed_credits=contributed_credits+$2 WHERE id=$3`,
      [poolBalance, input.amount, period.id],
    );
    await client.query(
      `INSERT INTO credit_ledger(request_id,user_id,actor_user_id,entry_type,amount,balance_after,
        reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$2,'group_contribution',$3,$4,'group',($5::uuid)::text,'成员归还本月未使用个人额度到本组共享池',$6)`,
      [`${input.requestId}:personal`, input.actor.id, -input.amount, userBalance, membership.group_id,
        JSON.stringify({ periodStart: period.period_start, groupId: membership.group_id })],
    );
    await client.query(
      `INSERT INTO group_credit_ledger(request_id,group_id,user_id,actor_user_id,period_start,
        entry_type,pool_amount,pool_balance_after,reference_type,reference_id,reason,metadata)
       VALUES($1,$2,$3,$3,$4::date,'contribution',$5,$6,'user',($3::uuid)::text,
        '成员归还本月未使用个人额度',$7)`,
      [input.requestId, membership.group_id, input.actor.id, period.period_start,
        input.amount, poolBalance, JSON.stringify({ personalBalanceAfter: userBalance })],
    );
    await writeAudit(client, { actor: input.actor, action: "group.credit_contributed", targetType: "group",
      targetId: membership.group_id, departmentId: input.actor.departmentId, result: "success",
      detail: { amount: input.amount, poolBalance }, ip: input.ip });
    return { poolBalance, personalBalance: userBalance, duplicate: false };
  });
}

async function getManagedSnapshotInTransaction(client: PoolClient, groupId: string) {
  const policy = await client.query<GroupPolicyRow>(
    `SELECT id,department_id,status,monthly_shared_credit_limit,
            shared_credit_per_request_limit,shared_credit_daily_user_limit,
            shared_credit_monthly_user_limit,
            date_trunc('month', timezone('Asia/Shanghai', now()))::date::text AS current_period_start
       FROM designer_groups WHERE id=$1`,
    [groupId],
  );
  const period = await client.query<GroupPeriodRow>(
    `SELECT ${periodSelect} FROM group_credit_periods
      WHERE group_id=$1 AND period_start=$2::date`,
    [groupId, policy.rows[0]!.current_period_start],
  );
  return { groupId, policy: policyProjection(policy.rows[0]!), period: period.rows[0] };
}

function policyProjection(group: GroupPolicyRow) {
  return {
    monthlySharedCreditLimit: group.monthly_shared_credit_limit,
    perRequestLimit: group.shared_credit_per_request_limit,
    dailyUserLimit: group.shared_credit_daily_user_limit,
    monthlyUserLimit: group.shared_credit_monthly_user_limit,
  };
}

export class GroupCreditError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
