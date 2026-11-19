import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getPerformanceDashboard, getPerformanceUsage } from "../../src/performance";
import { resolveRange } from "../../src/routes/performance";
import type { SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const now = new Date("2026-11-12T08:00:00.000Z");
const todayStart = "2026-11-11T16:00:00.000Z";
const todayEnd = "2026-11-12T16:00:00.000Z";
const activityAt = "2026-11-12T08:00:00.000Z";
const actor = (role: SessionUser["role"] = "super_admin", departmentId: string | null = null, groupId: string | null = null) =>
  ({ id: randomUUID(), role, departmentId, groupId, groupRole: groupId ? "leader" : null }) as SessionUser;
const todayUsage = (db: Awaited<ReturnType<typeof createFixture>>["db"], auth: SessionUser, filters = {}, at = now) =>
  getPerformanceUsage(db, auth, { ...resolveRange("today", undefined, undefined, at), ...filters }, at);

async function createFixture() {
  const fixture = await createIsolatedPostgres();
  const departmentA = randomUUID();
  const departmentB = randomUUID();
  const groupA = randomUUID();
  const groupA2 = randomUUID();
  const groupB = randomUUID();
  const provider = randomUUID();
  const model = randomUUID();
  await fixture.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Today A','today-a'),($2,'Today B','today-b')", [departmentA, departmentB]);
  await fixture.db.query("INSERT INTO designer_groups(id,department_id,name,code) VALUES($1,$4,'A1','a1'),($2,$4,'A2','a2'),($3,$5,'B1','b1')", [groupA, groupA2, groupB, departmentA, departmentB]);
  await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Isolated today usage','openai','https://invalid.example')", [provider]);
  await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id) VALUES($1,$2,'Isolated chat','isolated-chat')", [model, provider]);
  async function user(options: { departmentId?: string; groupId?: string; guest?: boolean } = {}) {
    const id = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name,department_id,is_guest,must_change_password) VALUES($1,$4,'Today user',$2,$3,false)", [id, options.departmentId ?? departmentA, options.guest ?? false, id]);
    if (options.groupId) await fixture.db.query("INSERT INTO group_memberships(user_id,group_id,effective_at) VALUES($1,$2,'2020-01-01T00:00:00Z')", [id, options.groupId]);
    return id;
  }
  async function task(userId: string, at = activityAt, options: { departmentId?: string; operation?: string; status?: string } = {}) {
    const id = randomUUID();
    await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,status,queued_at,prompt)
      VALUES($1,$7,$2,$3,'today-usage-fixture',$4,$5,$6,'Private content must not be selected by today usage')`,
    [id, userId, options.departmentId ?? departmentA, options.operation ?? "image_generation", options.status ?? "success", at, id]);
  }
  async function chat(userId: string, at = activityAt) {
    await fixture.db.query("INSERT INTO usage_chat_requests(id,user_id,model_config_id,board_key,prompt,status,created_at) VALUES($1,$2,$3,'gpt-chat','Private chat content','failed',$4)", [randomUUID(), userId, model, at]);
  }
  async function event(userId: string, at = activityAt, action = "click") {
    await fixture.db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,control_key,occurred_at) VALUES($1,$2,'canvas',$3,$4,$5)", [randomUUID(), userId, action, action === "gap" ? "collection-gap" : "canvas-tool", at]);
  }
  return { ...fixture, departmentA, departmentB, groupA, groupA2, groupB, user, task, chat, event };
}

sqlTest("today usage returns zero with no actual activity and never changes rollup state", async () => {
  const fixture = await createFixture();
  try {
    const idle = await fixture.user();
    await fixture.db.query("UPDATE users SET last_login_at=$2 WHERE id=$1", [idle, activityAt]);
    await fixture.event(idle, activityAt, "visit");
    await fixture.event(idle, activityAt, "gap");
    await fixture.user(); // An account with no telemetry is not inferred to have used a feature.
    const before = (await fixture.db.query("SELECT processing_enabled FROM usage_rollup_state")).rows;
    expect(before).toEqual([{ processing_enabled: false }]);
    fixture.statements.length = 0;
    expect(await todayUsage(fixture.db, actor())).toEqual({ from: todayStart, to: todayEnd, timeZone: "Asia/Shanghai", days: 1, userDays: 0, dailyAverage: 0 });
    expect(fixture.statements).toHaveLength(1);
    expect(fixture.statements.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect(fixture.statements[0]).not.toMatch(/prompt|usage_daily_facts|rollup/i);
    expect((await fixture.db.query("SELECT processing_enabled FROM usage_rollup_state")).rows).toEqual(before);
  } finally { await fixture.close(); }
}, 60_000);

sqlTest("today usage respects Shanghai half-open midnight boundaries for every source and deduplicates users", async () => {
  const fixture = await createFixture();
  try {
    for (const source of [fixture.task, fixture.chat, fixture.event]) {
      for (const time of ["2026-11-11T15:59:59.999Z", todayStart, "2026-11-12T15:59:59.999Z", todayEnd]) {
        await source(await fixture.user(), time);
      }
    }
    const repeated = await fixture.user();
    await fixture.task(repeated, activityAt, { operation: "video_generation", status: "failed" });
    await fixture.task(repeated, activityAt, { operation: "audio_generation", status: "cancelled" });
    await fixture.chat(repeated);
    await fixture.event(repeated);
    await fixture.event(repeated);
    const guest = await fixture.user({ guest: true });
    await fixture.task(guest);
    await fixture.chat(guest);
    await fixture.event(guest);
    const visitsOnly = await fixture.user();
    await fixture.event(visitsOnly, activityAt, "visit");
    await fixture.event(visitsOnly, activityAt, "gap");
    await fixture.user();
    expect((await todayUsage(fixture.db, actor())).dailyAverage).toBe(7);
    expect(await todayUsage(fixture.db, actor(), {}, new Date(todayEnd))).toMatchObject({ from: todayEnd, days: 1, userDays: 3, dailyAverage: 3 });
    expect((await todayUsage(fixture.db, actor(), {}, new Date("2026-11-11T15:59:59.999Z"))).dailyAverage).toBe(3);
    expect((await todayUsage(fixture.db, actor(), { userId: guest })).dailyAverage).toBe(0);
    expect((await todayUsage(fixture.db, actor(), { userId: randomUUID() })).dailyAverage).toBe(0);
  } finally { await fixture.close(); }
}, 60_000);

sqlTest("today usage includes non-image tasks and chat-only or local-interaction-only accounts", async () => {
  const fixture = await createFixture();
  try {
    const video = await fixture.user();
    const audio = await fixture.user();
    const chat = await fixture.user();
    const local = await fixture.user();
    await fixture.task(video, activityAt, { operation: "video_generation", status: "failed" });
    await fixture.task(audio, activityAt, { operation: "audio_generation", status: "waiting" });
    await fixture.chat(chat);
    await fixture.event(local, activityAt, "export");
    expect((await todayUsage(fixture.db, actor())).dailyAverage).toBe(4);
  } finally { await fixture.close(); }
}, 60_000);

sqlTest("today usage intersects department, group and individual permissions with event-time membership", async () => {
  const fixture = await createFixture();
  try {
    const a1 = await fixture.user({ groupId: fixture.groupA });
    const a2 = await fixture.user({ groupId: fixture.groupA2 });
    const b1 = await fixture.user({ departmentId: fixture.departmentB, groupId: fixture.groupB });
    const moved = await fixture.user();
    await fixture.db.query(`INSERT INTO group_memberships(user_id,group_id,effective_at,ended_at)
      VALUES($1,$2,'2020-01-01T00:00:00Z','2026-11-12T10:00:00Z'),($1,$3,'2026-11-12T10:00:00Z',NULL)`, [moved, fixture.groupA, fixture.groupA2]);
    await fixture.task(a1);
    await fixture.chat(a1);
    await fixture.event(a1);
    await fixture.chat(a2);
    await fixture.event(b1);
    await fixture.task(moved, "2026-11-12T09:59:59.999Z");
    await fixture.chat(moved, "2026-11-12T10:00:00.000Z");
    await fixture.event(moved, "2026-11-12T10:00:00.000Z");
    const adminA = actor("department_admin", fixture.departmentA);
    const leaderA = actor("designer", fixture.departmentA, fixture.groupA);
    const count = async (auth: SessionUser, filters = {}) => (await todayUsage(fixture.db, auth, filters)).dailyAverage;
    expect(await count(actor())).toBe(4);
    expect(await count(actor(), { departmentId: fixture.departmentA })).toBe(3);
    expect(await count(actor(), { groupId: fixture.groupA })).toBe(2);
    expect(await count(actor(), { groupId: fixture.groupA2 })).toBe(2);
    expect(await count(actor(), { groupId: fixture.groupA, userId: moved })).toBe(1);
    expect(await count(actor(), { groupId: fixture.groupA2, userId: moved })).toBe(1);
    expect(await count(adminA)).toBe(3);
    expect(await count(adminA, { departmentId: fixture.departmentB })).toBe(0);
    expect(await count(adminA, { groupId: fixture.groupB })).toBe(0);
    expect(await count(adminA, { userId: b1 })).toBe(0);
    expect(await count(adminA, { userId: a2 })).toBe(1);
    expect(await count(leaderA)).toBe(2);
    expect(await count(leaderA, { departmentId: fixture.departmentB, groupId: fixture.groupB })).toBe(2);
    expect(await count(leaderA, { userId: a2 })).toBe(0);
    expect(await count(leaderA, { userId: b1 })).toBe(0);
    expect(await count(leaderA, { userId: a1 })).toBe(1);
    expect(await count(actor("designer", fixture.departmentA, null))).toBe(0);

    // A task retains its recorded department even if the user's current department differs.
    const transferred = await fixture.user({ departmentId: fixture.departmentB });
    await fixture.task(transferred, activityAt, { departmentId: fixture.departmentA });
    expect(await count(adminA, { userId: transferred })).toBe(1);
    expect(await count(actor("department_admin", fixture.departmentB), { userId: transferred })).toBe(0);
  } finally { await fixture.close(); }
}, 60_000);

sqlTest("historical performance filters change usage and comparisons do not repeat its query", async () => {
  const fixture = await createFixture();
  try {
    const designer = await fixture.user({ groupId: fixture.groupA });
    await fixture.event(designer, now.toISOString());
    await fixture.event(designer, "2020-01-02T00:00:00.000Z");
    const before = (await fixture.db.query("SELECT processing_enabled FROM usage_rollup_state")).rows;
    fixture.statements.length = 0;
    const dashboard = await getPerformanceDashboard(fixture.db, actor(), {
      from: "2019-12-31T16:00:00.000Z", to: "2020-01-31T16:00:00.000Z", userId: designer,
    }, now);
    expect(dashboard.periodUsage).toMatchObject({ timeZone: "Asia/Shanghai", days: 31, userDays: 1, dailyAverage: 0.03 });
    expect(dashboard.metrics.validOutputs).toBe(0);
    expect(dashboard.tasks).toEqual([]);
    expect(dashboard.comparisons).not.toBeNull();
    expect(fixture.statements.filter(sql => sql.includes("count(DISTINCT r.user_id)"))).toHaveLength(1);
    expect(fixture.statements.every(sql => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect((await fixture.db.query("SELECT processing_enabled FROM usage_rollup_state")).rows).toEqual(before);
  } finally { await fixture.close(); }
}, 60_000);

sqlTest("week and month usage average daily distinct accounts including zero days, not period unique accounts", async () => {
  const fixture = await createFixture();
  try {
    const repeated = await fixture.user();
    const second = await fixture.user();
    await fixture.task(repeated, "2026-11-09T00:00:00Z");
    await fixture.chat(repeated, "2026-11-09T00:00:00Z");
    await fixture.event(repeated, "2026-11-09T00:00:00Z");
    await fixture.event(second, "2026-11-09T00:00:00Z");
    await fixture.event(repeated, "2026-11-10T00:00:00Z");
    await fixture.event(repeated, activityAt);
    await fixture.event(second, "2026-11-01T00:00:00Z");
    await fixture.event(second, "2026-11-13T00:00:00Z");
    const week = await getPerformanceUsage(fixture.db, actor(), resolveRange("week", undefined, undefined, now), now);
    const month = await getPerformanceUsage(fixture.db, actor(), resolveRange("month", undefined, undefined, now), now);
    expect(week).toMatchObject({ days: 4, userDays: 4, dailyAverage: 1 });
    expect(month).toMatchObject({ days: 12, userDays: 5, dailyAverage: 0.42 });
    expect((await getPerformanceUsage(fixture.db, actor(), { ...resolveRange("week", undefined, undefined, now), userId: repeated }, now)).dailyAverage).toBe(0.75);
  } finally { await fixture.close(); }
}, 60_000);

sqlTest("custom periods count touched Beijing calendar days and respect exclusive end times", async () => {
  const fixture = await createFixture();
  try {
    const designer = await fixture.user();
    await fixture.event(designer, "2026-11-09T15:59:59.999Z");
    await fixture.chat(designer, "2026-11-09T16:00:00.000Z");
    await fixture.task(designer, "2026-11-09T16:01:00.000Z");
    const range = { from: "2026-11-09T15:59:00Z", to: "2026-11-09T16:01:00Z" };
    expect(await getPerformanceUsage(fixture.db, actor(), range, now)).toMatchObject({ days: 2, userDays: 2, dailyAverage: 1 });
    expect(await getPerformanceUsage(fixture.db, actor(), { ...range, to: "2026-11-09T16:00:00Z" }, now)).toMatchObject({ days: 1, userDays: 1, dailyAverage: 1 });
    expect(await getPerformanceUsage(fixture.db, actor(), { from: "2026-11-10T16:00:00Z", to: "2026-11-11T16:00:00Z" }, now)).toMatchObject({ days: 1, userDays: 0, dailyAverage: 0 });
  } finally { await fixture.close(); }
}, 60_000);

sqlTest("future calendar days and their activity never enter a selected period average", async () => {
  const fixture = await createFixture();
  try {
    const designer = await fixture.user();
    await fixture.event(designer, activityAt);
    await fixture.event(designer, todayEnd);
    const range = { from: todayStart, to: "2026-12-01T16:00:00.000Z" };
    expect(await getPerformanceUsage(fixture.db, actor(), range, now)).toMatchObject({ to: todayEnd, days: 1, userDays: 1, dailyAverage: 1 });
    fixture.statements.length = 0;
    expect(await getPerformanceUsage(fixture.db, actor(), { ...range, from: todayEnd }, now)).toMatchObject({ days: 0, userDays: 0, dailyAverage: null });
    expect(fixture.statements).toHaveLength(0);
  } finally { await fixture.close(); }
}, 60_000);
