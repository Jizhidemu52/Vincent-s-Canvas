import { describe, expect, test } from "bun:test";
import { adjustCredits, setCreditBalance } from "../src/billing";
import type { Database } from "../src/db";

function fixture() {
  const user = { credit_balance: 80, credit_limit: 100, monthly_credit_limit: 100, temporary_credit_adjustment: 0, credit_period_start: "2026-10-01", current_period_start: "2026-10-01" };
  const ledger = new Map<string, Record<string, unknown>>();
  const statements: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    if (sql.includes("FROM users")) return { rows: [{ ...user }] };
    if (sql.includes("FROM credit_ledger")) return { rows: [ledger.get(String(values[0]))].filter(Boolean) };
    if (sql.startsWith("UPDATE users")) {
      user.credit_balance = Number(values[0]);
      user.credit_limit = Number(values[1]);
      user.temporary_credit_adjustment += Number(values[2]);
    }
    if (sql.includes("INSERT INTO credit_ledger")) ledger.set(String(values[0]), {
      user_id: values[1], actor_user_id: values[2], entry_type: "adjustment", amount: values[3], balance_after: values[4], reason: values[6], metadata: JSON.parse(String(values[7])),
    });
    return { rows: [] };
  };
  return { user, ledger, statements, db: { query, connect: async () => ({ query, release() {} }) } as unknown as Database };
}

const operation = { requestId: "credit-request-1", actorId: "admin", userId: "designer", reason: "测试调整" };

describe("administrator credit changes", () => {
  test("sets an absolute balance under a user lock and preserves monthly allowance", async () => {
    const state = fixture();
    expect(await setCreditBalance(state.db, { ...operation, balance: 500 })).toEqual({ balance: 500, balanceBefore: 80, amount: 420, duplicate: false });
    expect(state.user).toMatchObject({ credit_balance: 500, credit_limit: 500, monthly_credit_limit: 100, temporary_credit_adjustment: 420 });
    expect(state.statements.findIndex(sql => sql.includes("FOR NO KEY UPDATE"))).toBeLessThan(state.statements.findIndex(sql => sql.includes("FROM credit_ledger")));
    expect(state.ledger.get(operation.requestId)).toMatchObject({ metadata: { mode: "set", requestedValue: 500, balanceBefore: 80, scope: "temporary" } });
  });

  test("retries a set once without restoring a balance already consumed afterwards", async () => {
    const state = fixture();
    await setCreditBalance(state.db, { ...operation, balance: 500 });
    state.user.credit_balance -= 10;
    expect(await setCreditBalance(state.db, { ...operation, balance: 500 })).toMatchObject({ balance: 500, duplicate: true });
    expect(state.user.credit_balance).toBe(490);
    expect(state.ledger.size).toBe(1);
  });

  test("rejects request ID reuse for a different actor, target, amount, mode or reason", async () => {
    const state = fixture();
    await adjustCredits(state.db, { ...operation, amount: 20 });
    for (const changed of [{ actorId: "another-admin" }, { userId: "other-designer" }, { amount: 21 }, { reason: "另一原因" }]) {
      await expect(adjustCredits(state.db, { ...operation, amount: 20, ...changed })).rejects.toMatchObject({ code: "CREDIT_REQUEST_CONFLICT" });
    }
    await expect(setCreditBalance(state.db, { ...operation, balance: 20 })).rejects.toMatchObject({ code: "CREDIT_REQUEST_CONFLICT" });
    expect(state.user.credit_balance).toBe(100);
    expect(state.ledger.size).toBe(1);
  });

  test("supports zero balance and negative adjustments but not overdrafts or invalid integers", async () => {
    const state = fixture();
    await adjustCredits(state.db, { ...operation, amount: -30 });
    expect(state.user.credit_balance).toBe(50);
    await expect(adjustCredits(state.db, { ...operation, requestId: "overdraw", amount: -51 })).rejects.toMatchObject({ code: "INVALID_CREDIT" });
    for (const balance of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      await expect(setCreditBalance(state.db, { ...operation, requestId: "invalid-number", balance })).rejects.toMatchObject({ code: "INVALID_CREDIT" });
    }
    await setCreditBalance(state.db, { ...operation, requestId: "set-zero", balance: 0 });
    expect(state.user).toMatchObject({ credit_balance: 0, monthly_credit_limit: 100, temporary_credit_adjustment: -80 });
  });
});
