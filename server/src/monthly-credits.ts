import type { PoolClient } from "pg";

import type { Database } from "./db";
import { withTransaction } from "./db-transaction";

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
  if (!user) throw new Error("ACCOUNT_NOT_FOUND");
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
