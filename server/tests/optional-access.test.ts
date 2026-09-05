import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { deploymentFeatures } from "../src/deployment-features";
import { sessionMiddleware } from "../src/session";
import { reserveCredits, settleReservation } from "../src/billing";

const config = (extra: Record<string, string> = {}) => loadConfig({ DATABASE_URL: "postgres://test", REDIS_URL: "redis://test", ...extra });

describe("optional access and billing", () => {
    test("preserves current defaults and disables credit enforcement without login", () => {
        expect(deploymentFeatures(config())).toEqual({ authenticationEnabled: true, creditsEnabled: true, rolePortalsEnabled: true });
        expect(deploymentFeatures(config({ CREDITS_ENABLED: "false" }))).toEqual({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: true });
        expect(deploymentFeatures(config({ AUTH_ENABLED: "false", ROLE_PORTALS_ENABLED: "false" }))).toEqual({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false });
        expect(() => config({ AUTH_ENABLED: "off" })).toThrow();
    });

    test("does not issue a guest session for administrator routes", async () => {
        const { response, state } = responseStub();
        let next = false;
        await sessionMiddleware({} as never, {} as never, config({ AUTH_ENABLED: "false" }), { allowGuest: false })(
            { cookies: {} } as never, response as never, (() => { next = true; }) as never,
        );
        expect(state.status).toBe(401);
        expect(next).toBe(false);
        expect(state.cookies).toHaveLength(0);
    });

    test("creates a distinct unprivileged identity and cookie for each guest browser", async () => {
        const identities: string[] = [];
        const statements: string[] = [];
        const database = databaseStub((sql, params) => {
            statements.push(sql);
            if (sql.startsWith("INSERT INTO users")) identities.push(String(params[0]));
            if (sql.startsWith("SELECT")) return [{ id: identities.at(-1), username: "guest", role: "designer", status: "active", must_change_password: false, is_guest: true }];
            return [];
        });
        const cache = { set: async () => "OK" };
        const middleware = sessionMiddleware(database as never, cache as never, config({ AUTH_ENABLED: "false" }));
        for (let i = 0; i < 2; i++) {
            const { response, state } = responseStub();
            const request = { cookies: {}, get: () => "test", ip: "127.0.0.1" } as any;
            let error: unknown;
            await middleware(request, response as never, ((value: unknown) => { error = value; }) as never);
            expect(error).toBeUndefined();
            expect(request.auth.role).toBe("designer");
            expect(request.auth.mustChangePassword).toBe(false);
            expect(state.cookies[0]?.options.httpOnly).toBe(true);
        }
        expect(new Set(identities).size).toBe(2);
        expect(statements.some((sql) => sql.includes("'designer',true,false"))).toBe(true);
    });

    test("guest sessions are rejected after authentication is enabled again", async () => {
        const database = databaseStub(() => [{ id: "visitor", session_id: "session", is_guest: true }]);
        const cache = { get: async () => null, del: async () => 1 };
        const { response, state } = responseStub();
        let next = false;
        await sessionMiddleware(database as never, cache as never, config())(
            { cookies: { wireless_canvas_session: "guest-token" } } as never, response as never, (() => { next = true; }) as never,
        );
        expect(state.status).toBe(401);
        expect(next).toBe(false);
    });

    test("unbilled tasks validate models but never touch balances or require a price", async () => {
        const statements: string[] = [];
        let reservation: unknown[] = [];
        const database = databaseStub((sql, params) => {
            statements.push(sql);
            if (sql.includes("FROM model_configs")) return [{ id: "model", credit_cost: 9, rmb_cost: "0.25", capabilities: ["generate"] }];
            if (sql.startsWith("SELECT department_id")) return [{ department_id: "department-with-no-budget" }];
            if (sql.startsWith("INSERT INTO credit_reservations")) reservation = params;
            return [];
        });
        const result = await reserveCredits(database as never, { requestId: "unbilled-task", userId: "visitor", modelConfigId: "model", operationType: "image_generation", quantity: 2, creditsEnabled: false });
        expect(result.credits).toBe(0);
        expect(result.rmbCost).toBe(.5);
        expect(reservation.at(-1)).toMatchObject({ billingDisabled: true, totalCredits: 0 });
        expect(statements.some((sql) => /UPDATE (users|departments|group_credit)|INSERT INTO (credit_ledger|group_credit_ledger)/.test(sql))).toBe(false);
    });

    test("a disabled model stays blocked when credits are disabled", async () => {
        await expect(reserveCredits(databaseStub(() => []) as never, { requestId: "invalid-model", userId: "visitor", modelConfigId: "missing", operationType: "image_generation", quantity: 1, creditsEnabled: false })).rejects.toMatchObject({ code: "MODEL_DISABLED" });
    });

    test("unbilled reservations settle without refunds or monthly resets", async () => {
        const statements: string[] = [];
        const database = databaseStub((sql) => {
            statements.push(sql);
            return sql.startsWith("SELECT") ? [{ id: "reservation", status: "held", credits: 0, billing_disabled: true }] : [];
        });
        await expect(settleReservation(database as never, "unbilled-task", "release")).resolves.toMatchObject({ status: "released" });
        expect(statements.filter((sql) => sql.startsWith("UPDATE"))).toEqual(["UPDATE credit_reservations SET status=$1,settled_at=now() WHERE id=$2"]);
    });
});

function databaseStub(read: (sql: string, params: unknown[]) => unknown[]) {
    const query = async (sql: string, params: unknown[] = []) => ({ rows: read(sql, params) });
    return { query, connect: async () => ({ query, release: () => undefined }) };
}

function responseStub() {
    const state = { status: 200, cookies: [] as Array<{ options: Record<string, unknown> }> };
    const response = {
        status: (value: number) => { state.status = value; return response; },
        json: (_value: unknown) => response,
        cookie: (_name: string, _value: string, options: Record<string, unknown>) => { state.cookies.push({ options }); return response; },
        clearCookie: () => response,
    };
    return { state, response };
}
