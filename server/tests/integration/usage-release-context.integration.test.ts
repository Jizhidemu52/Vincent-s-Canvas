import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { usageV2Overview } from "../../src/usage-analytics-v2";
import { readUsageReleaseContext, usageControlDaily } from "../../src/usage-release-context";
import { processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const scope: UsageV2Scope = {
    from: "2026-10-01T00:00:00+08:00",
    to: "2026-10-03T00:00:00+08:00",
    timezone: "Asia/Shanghai",
    compare: "none",
    departmentBasis: "current",
};
sqlTest(
    "overview publishes only global in-range log metadata in the same read transaction and controls use the original filtered daily facts",
    async () => {
        const f = await createIsolatedPostgres({ usageRollupsEnabled: true });
        try {
            const user = randomUUID(),
                other = randomUUID();
            await f.db.query(
                "INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'release-user','Fixture','super_admin',false),($2,'release-other','Other','designer',false)",
                [user, other],
            );
            await f.db.query(`INSERT INTO release_notes(version,title,content,published_at) VALUES
            ('v1.0.0','Draft','SECRET_BODY',NULL),
            ('v1.0.1','Before','SECRET_BODY','2026-09-30T15:59:59Z'),
            ('v1.0.2','First','SECRET_BODY','2026-09-30T16:00:00Z'),
            ('v1.0.3','Second','SECRET_BODY','2026-10-01T16:00:00Z'),
            ('v1.0.4','End excluded','SECRET_BODY','2026-10-02T16:00:00Z')`);
            for (const [owner, board, action, control, at] of [
                [user, "canvas", "click", "submit", "2026-10-01T15:59:59Z"],
                [user, "canvas", "submit", "submit", "2026-10-01T16:00:00Z"],
                [user, "image", "click", "submit", "2026-10-01T16:00:00Z"],
                [user, "canvas", "visit", "navigation", "2026-10-01T16:00:00Z"],
                [user, "canvas", "gap", "collection-gap", "2026-10-01T16:00:00Z"],
                [user, "canvas", "click", null, "2026-10-01T16:00:00Z"],
                [other, "canvas", "click", "submit", "2026-10-01T16:00:00Z"],
            ])
                await f.db.query(
                    "INSERT INTO usage_events(event_id,user_id,board_key,action,control_key,parameters,occurred_at) VALUES($1,$2,$3,$4,$5,'{}',$6)",
                    [randomUUID(), owner, board, action, control, at],
                );
            await queueUsageRollup(
                f.db,
                { fromDay: "2026-10-01", toDay: "2026-10-02", idempotencyKey: randomUUID() },
                user,
            );
            expect((await processUsageRollups(f.db, 2)).every((row) => row.status === "processed")).toBe(true);
            const before = f.statements.length;
            const result = await usageV2Overview(
                f.db,
                { ...scope, userIds: [user], boardKeys: ["canvas"] },
                { source: "daily" },
            );
            const statements = f.statements.slice(before);
            expect(statements.filter((sql) => sql.startsWith("BEGIN"))).toEqual([
                "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
            ]);
            expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
            expect(statements.findIndex((sql) => sql.includes("FROM release_notes"))).toBeLessThan(
                statements.indexOf("COMMIT"),
            );
            expect(statements.some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
            expect(result.releaseContext).toMatchObject({
                source: "release_notes.published_at",
                scope: "global_publications_in_selected_dates",
                truncated: false,
            });
            expect(result.releaseContext!.releases.map((row) => [row.version, row.day])).toEqual([
                ["v1.0.2", "2026-10-01"],
                ["v1.0.3", "2026-10-02"],
            ]);
            expect(JSON.stringify(result.releaseContext)).not.toContain("SECRET_BODY");
            expect(result.controlDaily).toMatchObject({ totalControls: 1, missingControlRecords: 1, truncated: false });
            expect(result.controlDaily!.series).toEqual([
                {
                    boardKey: "canvas",
                    boardLabel: "无线画布总入口",
                    controlKey: "submit",
                    label: "提交",
                    total: 2,
                    daily: [
                        { day: "2026-10-01", count: 1 },
                        { day: "2026-10-02", count: 1 },
                    ],
                },
            ]);
        } finally {
            await f.close();
        }
    },
    120000,
);

sqlTest(
    "publication context excludes drafts and future publication relative to observation, and explicitly limits dense ranges",
    async () => {
        const f = await createIsolatedPostgres();
        try {
            await f.db.query(
                "INSERT INTO release_notes(version,title,content,published_at) SELECT 'v2.0.'||n,'Public','PRIVATE_BODY','2026-10-01T00:00:00Z'::timestamptz+n*interval '1 minute' FROM generate_series(1,202) n",
            );
            const client = await f.db.connect();
            try {
                const full = await readUsageReleaseContext(client, scope, "2026-10-02T00:00:00Z");
                expect(full.releases).toHaveLength(200);
                expect(full.truncated).toBe(true);
                const early = await readUsageReleaseContext(client, scope, "2026-10-01T00:02:00Z");
                expect(early.releases.map((row) => row.version)).toEqual(["v2.0.1", "v2.0.2"]);
                expect(early.truncated).toBe(false);
            } finally {
                client.release();
            }
        } finally {
            await f.close();
        }
    },
    120000,
);

test("control curves separate boards and expose top-20 truncation without inventing zero-use dates", () => {
    const facts = Array.from({ length: 21 }, (_, i) => ({
        kind: "event",
        action: "click",
        board_key: "canvas",
        control_key: `fallback:button:${i}`,
        occurred_at: "2026-10-01T16:00:00Z",
    }));
    const result = usageControlDaily([...facts, facts[20]!]);
    expect(result.totalControls).toBe(21);
    expect(result.truncated).toBe(true);
    expect(result.series).toHaveLength(20);
    expect(result.series[0]?.total).toBe(2);
    expect(result.series[0]?.daily).toEqual([{ day: "2026-10-02", count: 2 }]);
});
