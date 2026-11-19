import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getPerformanceDashboard } from "../../src/performance";
import type { SessionUser } from "../../src/types";
import { conversationDatabaseMode, createConversationPostgres } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? describe : describe.skip;
const range = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" };
const occurredAt = "2026-11-02T08:00:00.000Z";
const now = new Date("2026-11-19T08:00:00.000Z");

integration("performance employee options preserve deleted-account history", () => {
  let fixture: Awaited<ReturnType<typeof createConversationPostgres>>;
  const departmentA = randomUUID(), departmentB = randomUUID();
  const groupA = randomUUID(), groupA2 = randomUUID(), groupB = randomUUID();
  const activeA = randomUUID(), activeA2 = randomUUID(), activeB = randomUUID(), deletedA = randomUUID();
  const taskId = randomUUID(), assetId = randomUUID();
  const actor = (role: SessionUser["role"], departmentId: string | null = null, groupId: string | null = null) =>
    ({ id: randomUUID(), role, departmentId, groupId, groupRole: groupId ? "leader" : null }) as SessionUser;
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ["users", "tasks", "assets", "asset_events", "usage_rollup_state"]) {
      result[table] = (await fixture.db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  };

  beforeAll(async () => {
    fixture = await createConversationPostgres();
    await fixture.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Department A','options-a'),($2,'Department B','options-b')", [departmentA, departmentB]);
    await fixture.db.query(`INSERT INTO designer_groups(id,department_id,name,code)
      VALUES($1,$4,'A1','options-a1'),($2,$4,'A2','options-a2'),($3,$5,'B1','options-b1')`, [groupA, groupA2, groupB, departmentA, departmentB]);
    for (const [id, departmentId, groupId, label, deleted] of [
      [activeA, departmentA, groupA, "张晓明", false],
      [activeA2, departmentA, groupA2, "李思琪", false],
      [activeB, departmentB, groupB, "陈雨桐", false],
      [deletedA, departmentA, groupA, "历史\uFFFD姓名", true],
      [randomUUID(), departmentA, groupA2, "Deleted A2", true],
      [randomUUID(), departmentB, groupB, "Deleted B", true],
    ] as const) {
      await fixture.db.query(`INSERT INTO users(id,username,display_name,role,department_id,deleted_at)
        VALUES($1::uuid,$1::text,$2,'designer',$3,CASE WHEN $4 THEN now() ELSE NULL END)`, [id, label, departmentId, deleted]);
      await fixture.db.query("INSERT INTO group_memberships(user_id,group_id,effective_at) VALUES($1,$2,'2020-01-01T00:00:00Z')", [id, groupId]);
    }
    await fixture.db.query("INSERT INTO users(username,display_name,role,department_id) VALUES('options-admin','Active admin','department_admin',$1)", [departmentA]);
    await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,status,credits,rmb_cost,queued_at,started_at,completed_at)
      VALUES($1::uuid,$1::text,$2,$3,'options-history','image_generation','success',7,0.5,$4,$4,$4::timestamptz+interval '1 minute')`, [taskId, deletedA, departmentA, occurredAt]);
    await fixture.db.query(`INSERT INTO assets(id,owner_user_id,department_id,task_id,object_key,filename,mime_type,kind,source,status,created_at)
      VALUES($1::uuid,$2,$3,$4,$1::text,'history.png','image/png','image','generation','ready',$5)`, [assetId, deletedA, departmentA, taskId, occurredAt]);
    await fixture.db.query(`INSERT INTO asset_events(asset_id,designer_user_id,actor_user_id,department_id,group_id,event_type,first_effective,occurred_at,idempotency_key)
      VALUES($1::uuid,$2,$2,$3,$4,'asset.generated',true,$5,$1::text)`, [assetId, deletedA, departmentA, groupA, occurredAt]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  for (const [role, departmentId, groupId, expectedIds] of [
    ["super_admin", null, null, [activeA, activeA2, activeB]],
    ["department_admin", departmentA, null, [activeA, activeA2]],
    ["designer", departmentA, groupA, [activeA]],
  ] as const) {
    test(`${role} only offers existing designers within its employee scope without changing historical metrics`, async () => {
      const before = await snapshot();
      fixture.statements.length = 0;
      const dashboard = await getPerformanceDashboard(fixture.db, actor(role, departmentId, groupId), range, now);
      expect(dashboard.options.users.map(user => user.value).sort()).toEqual([...expectedIds].sort());
      expect(dashboard.options.users.find(user => user.value === activeA)?.label).toBe("张晓明");
      expect(dashboard.options.users.some(user => user.label.includes("\uFFFD"))).toBe(false);
      expect(dashboard.tasks.map(task => task.id)).toEqual([taskId]);
      expect(dashboard.assets.map(asset => asset.id)).toEqual([assetId]);
      expect(dashboard.designers.map(designer => designer.userId)).toEqual([deletedA]);
      expect(dashboard.metrics).toMatchObject({ requestedOutputs: 1, validOutputs: 1, successCount: 1, totalCredits: 7, totalRmbCost: 0.5 });
      expect(dashboard.periodUsage).toMatchObject({ userDays: 1 });
      expect(fixture.statements.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
      expect(await snapshot()).toEqual(before);
    });
  }

  test("explicit historical employee filters retain deleted-account tasks, assets and usage", async () => {
    const before = await snapshot();
    fixture.statements.length = 0;
    const dashboard = await getPerformanceDashboard(fixture.db, actor("super_admin"), { ...range, userId: deletedA }, now);
    expect(dashboard.options.users.some(user => user.value === deletedA)).toBe(false);
    expect(dashboard.tasks.map(task => task.id)).toEqual([taskId]);
    expect(dashboard.assets.map(asset => asset.id)).toEqual([assetId]);
    expect(dashboard.metrics).toMatchObject({ requestedOutputs: 1, validOutputs: 1, successCount: 1, totalCredits: 7, totalRmbCost: 0.5 });
    expect(dashboard.periodUsage).toMatchObject({ userDays: 1 });
    expect(fixture.statements.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});
