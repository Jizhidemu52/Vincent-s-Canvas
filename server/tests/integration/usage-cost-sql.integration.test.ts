import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import type { PoolClient } from "pg";
import type { AppConfig } from "../../src/config";
import type { Database } from "../../src/db";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";
import { usageBreakdowns, usageCoverage, usagePeople, usageRecords, usageSummary } from "../../src/usage-analytics";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

sqlTest("usage costs and real image outputs share the searched population and Beijing period without pagination loss", async () => {
  const fixture = await createIsolatedPostgres(); const db = fixture.db;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const alpha = randomUUID(), alpha2 = randomUUID(), beta = randomUUID(), guest = randomUUID(), idle = randomUUID();
    for (const [id, username, name, isGuest] of [[alpha, "alpha_one", "Alice", false], [alpha2, "Alpha_two", "Alicia", false], [beta, "beta", "Bob", false], [guest, "alpha_guest", "Guest", true], [idle, "literal%_person", "Idle", false]]) {
      await db.query("INSERT INTO users(id,username,display_name,role,is_guest,must_change_password) VALUES($1,$2,$3,'designer',$4,false)", [id, username, name, isGuest]);
    }
    const provider = randomUUID(), model = randomUUID(), videoAsset = randomUUID();
    await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Usage fixture','openai','https://never-called.invalid/v1','unused')", [provider]);
    await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,'Usage model','fixture',ARRAY['generate'],999)", [model, provider]);
    await db.query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$1::uuid::text,'unexpected.mp4','video/mp4',123,'video','ready')", [videoAsset, alpha]);
    const task = async (userId: string, at: string, cost: number, urls: unknown[], options: { operation?: string; status?: string; history?: boolean; taskCost?: number; prompt?: string } = {}) => {
      const id = randomUUID();
      await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,rmb_cost,result_urls,queued_at) VALUES($1::uuid,$1::uuid::text,$2,'usage-fixture',$3,$4,$5,'{\"n\":99}', 'image',$6,$7,$8,$9)",
        [id, userId, options.operation ?? "image_generation", model, options.prompt ?? "设计毛衣", options.status ?? "success", options.taskCost ?? cost, JSON.stringify(urls), at]);
      if (options.history !== false) await db.query("INSERT INTO generation_history(task_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,$3 FROM tasks WHERE id=$1", [id, cost, options.status === "failed" ? "failed" : "success"]);
      return id;
    };
    await task(alpha, "2026-10-29T15:59:59Z", .2, ["before"]);
    const multi = await task(alpha, "2026-10-29T16:00:00Z", .16104, ["image-a", "image-b", "image-c", "image-c", "", null, { ignored: true }, `/api/assets/${videoAsset}/content`], { taskCost: 999 });
    await task(alpha, "2026-10-30T15:59:59Z", .4, ["image-d"]);
    await task(alpha, "2026-10-30T16:00:00Z", .7, ["after"]);
    await task(alpha, "2026-10-30T01:00:00Z", 0, ["failed-image"], { status: "failed", taskCost: 900 });
    await task(alpha, "2026-10-30T02:00:00Z", 800, ["pending-image"], { status: "processing", history: false });
    await task(alpha, "2026-10-30T03:00:00Z", 5, ["video-a", "video-b"], { operation: "video_generation" });
    await task(alpha, "2026-10-30T04:00:00Z", 2, ["audio-a", "audio-b"], { operation: "audio_generation" });
    await task(alpha, "2026-10-30T05:00:00Z", 600, ["saved-image-without-history"], { history: false });
    await task(beta, "2026-10-30T06:00:00Z", 90, ["other-a", "other-b"], { prompt: "外部人员提示词不可导出" });
    await task(alpha2, "2026-10-30T07:00:00Z", .25, ["second-a", "second-b"]);
    await task(guest, "2026-10-30T08:00:00Z", 80, ["guest-image"]);
    await db.query("INSERT INTO usage_chat_requests(id,user_id,model_config_id,board_key,prompt,status,created_at) VALUES($1,$2,$3,'gpt-chat','针织对话','success','2026-10-30T09:00:00Z')", [randomUUID(), alpha, model]);
    for (const [user, amount] of [[alpha, 3], [alpha2, 4], [beta, 100]]) await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,control_key,parameters,occurred_at) VALUES($1,$2,'image','gap','collection-gap',$3,'2026-10-30T10:00:00Z')", [randomUUID(), user, JSON.stringify({ droppedEventCount: amount })]);

    const filters = { search: "aLpHa", from: "2026-10-30T00:00:00+08:00", to: "2026-10-31T00:00:00+08:00" };
    const summary = await usageSummary(db, filters);
    expect(summary).toMatchObject({ totalRmbCost: 7.81104, generatedImages: 7, generationRequests: 8, chatRequests: 1, succeeded: 7, failed: 1, pending: 1 });
    const page1 = await usagePeople(db, filters, { page: 1, pageSize: 1 });
    const page2 = await usagePeople(db, filters, { page: 2, pageSize: 1 });
    expect(page1.pagination.total).toBe(2); expect(page2.pagination.total).toBe(2);
    expect(new Set([...page1.people, ...page2.people].map(person => person.userId))).toEqual(new Set([alpha, alpha2]));
    expect([...page1.people, ...page2.people].find(person => person.userId === alpha)?.summary).toMatchObject({ totalRmbCost: 7.56104, generatedImages: 5 });
    expect(await usageSummary(db, filters)).toEqual(summary);
    expect((await usageBreakdowns(db, filters)).daily).toEqual([{ day: "2026-10-30", ...summary }]);
    const days = (await usageBreakdowns(db, { userIds: [alpha], from: "2026-10-29T00:00:00+08:00", to: "2026-11-01T00:00:00+08:00" })).daily;
    expect(days.map(day => ({ day: day.day, cost: day.totalRmbCost, images: day.generatedImages }))).toEqual([
      { day: "2026-10-29", cost: .2, images: 1 }, { day: "2026-10-30", cost: 7.56104, images: 5 }, { day: "2026-10-31", cost: .7, images: 1 },
    ]);
    const coverage = await usageCoverage(db, filters);
    expect(coverage.droppedEventCount).toBe(7);
    expect(coverage.missingHistoryCount).toBe(1);
    expect(coverage.notes.some(note => note.includes("1") && note.includes("缺少") && note.includes("费用"))).toBe(true);
    const records = await usageRecords(db, filters, { page: 1, pageSize: 200 });
    expect(records.records.find(record => record.id === `task:${multi}`)).toMatchObject({ totalRmbCost: .16104, generatedImages: 3 });
    expect(records.records.filter(record => record.kind !== "generation").every(record => record.totalRmbCost === 0 && record.generatedImages === 0)).toBe(true);
    expect(records.records.every(record => record.userId === alpha || record.userId === alpha2)).toBe(true);
    expect((await usageSummary(db, { ...filters, userIds: [beta] }))).toMatchObject({ totalRmbCost: 0, generatedImages: 0, generationRequests: 0 });
    expect(await usageSummary(db, { ...filters, search: "nonexistent" })).toMatchObject({ totalRmbCost: 0, generatedImages: 0, generationRequests: 0 });
    expect((await usageCoverage(db, { ...filters, search: "nonexistent" })).droppedEventCount).toBe(0);
    expect((await usagePeople(db, { search: "%_" }, { page: 1, pageSize: 50 })).people.map(person => person.userId)).toEqual([idle]);
    expect((await usagePeople(db, { search: "Alice" }, { page: 1, pageSize: 50 })).people.map(person => person.userId)).toEqual([alpha]);

    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: alpha, role: "super_admin", departmentId: null } }); next(); });
    // The export writes its completion audit through the pool after COMMIT but before
    // releasing its cursor client. Share PGlite's single SQL connection for that audit.
    let exportClient: PoolClient | undefined;
    const exportDb = {
      query: (sql: string, values?: unknown[]) => (exportClient ?? db).query(sql, values),
      connect: async () => {
        const client = await db.connect(); exportClient = client;
        return { query: client.query.bind(client), release: () => { exportClient = undefined; client.release(); } };
      },
    } as Database;
    app.use("/usage", createAdminUsageRouter(exportDb, {} as AppConfig));
    app.use(((error, _request, response, _next) => response.status(500).json({ message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server!.once("listening", done));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`;
    const response = await fetch(`${base}/people?${new URLSearchParams({ ...filters, page: "2", pageSize: "1" })}`);
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.summary).toEqual(summary); expect(data.pagination.total).toBe(2); expect(data.people).toHaveLength(1); expect(data.coverage.droppedEventCount).toBe(7);
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const exported = await post("/export", filters); expect(exported.status).toBe(200);
    const lines = (await exported.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ type: "complete", recordCount: records.pagination.total });
    const outputRecords = lines.filter(line => line.type === "record").map(line => line.record);
    expect(outputRecords.every(record => record.userId === alpha || record.userId === alpha2)).toBe(true);
    expect(outputRecords.find(record => record.id === `task:${multi}`)).toMatchObject({ totalRmbCost: .16104, generatedImages: 3 });
    const preview = await post("/analysis-preview", { ...filters, includePromptSamples: true }); expect(preview.status).toBe(200);
    const previewData = (await preview.json()).data; const content = JSON.parse(previewData.content);
    expect(content.summary).toEqual(summary); expect(content.limits.dailyTimezone).toBe("Asia/Shanghai");
    for (const privateValue of ["aLpHa", "Alice", "Alicia", "外部人员提示词不可导出", alpha, beta]) expect(previewData.content).not.toContain(privateValue);
    // Reading analytics must neither reprice historical records nor change the stored task estimate.
    expect(Number((await db.query("SELECT rmb_cost FROM tasks WHERE id=$1", [multi])).rows[0].rmb_cost)).toBe(999);
    expect(Number((await db.query("SELECT rmb_cost FROM generation_history WHERE task_id=$1", [multi])).rows[0].rmb_cost)).toBe(.16104);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await fixture.close();
  }
}, 60_000);

sqlTest("usage model/board filters preserve zero-record people, kind-specific daily totals and stable server sorting before pagination", async () => {
  const fixture = await createIsolatedPostgres(); const db = fixture.db;
  try {
    const alpha = randomUUID(), beta = randomUUID(), gamma = randomUUID(), idle = randomUUID(), guest = randomUUID();
    for (const [id, name, isGuest] of [[alpha, "Alpha", false], [beta, "Beta", false], [gamma, "Gamma", false], [idle, "Idle", false], [guest, "Guest", true]]) await db.query("INSERT INTO users(id,username,display_name,role,is_guest,must_change_password) VALUES($1,$2,$3,'designer',$4,false)", [id, name, name, isGuest]);
    const provider = randomUUID(), imageModel = randomUUID(), otherModel = randomUUID();
    await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Usage sorting fixture','openai','https://never-called.invalid/v1','unused')", [provider]);
    for (const [id, name] of [[imageModel, "Image fixture"], [otherModel, "Other fixture"]]) await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,$3,$3,ARRAY['generate'],999)", [id, provider, name]);
    const task = async (user: string, status: string, cost: number, urls: string[], options: { model?: string; board?: string; history?: boolean } = {}) => {
      const id = randomUUID();
      await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,rmb_cost,result_urls,queued_at) VALUES($1::uuid,$1::uuid::text,$2,'usage-sorting','image_generation',$3,'fixture','{}',$4,$5,999,$6,'2026-11-02T01:00:00Z')", [id, user, options.model ?? imageModel, options.board ?? "image", status, JSON.stringify(urls)]);
      if (status === "success" && options.history !== false) await db.query("INSERT INTO generation_history(task_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1", [id, cost]);
    };
    await task(alpha, "success", 1.25, ["alpha-a", "alpha-b"]);
    await task(alpha, "success", 99, ["alpha-missing-history"], { history: false });
    await task(beta, "failed", 0, []);
    await task(gamma, "success", 1.25, ["gamma-a"]);
    await task(gamma, "cancelled", 0, []);
    await task(gamma, "success", 40, ["other-board"], { board: "canvas-image" });
    await task(gamma, "success", 50, ["other-model"], { model: otherModel });
    await task(guest, "success", 100, ["guest"]);
    await db.query("INSERT INTO usage_chat_requests(id,user_id,model_config_id,board_key,prompt,status,created_at) VALUES($1,$2,$3,'image','fixture','success','2026-11-02T02:00:00Z')", [randomUUID(), alpha, imageModel]);
    for (const [action, control, parameters] of [["visit", null, {}], ["change", "quality", { modelConfigId: imageModel, quality: "high" }], ["gap", "collection-gap", { droppedEventCount: 8 }]]) await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,control_key,parameters,occurred_at) VALUES($1,$2,'image',$3,$4,$5,'2026-11-02T03:00:00Z')", [randomUUID(), alpha, action, control, JSON.stringify(parameters)]);
    const filters = { from: "2026-11-02T00:00:00+08:00", to: "2026-11-03T00:00:00+08:00", modelConfigId: imageModel, boardKey: "image" };
    const summary = await usageSummary(db, filters);
    expect(summary).toEqual({ visits: 0, interactions: 1, generationRequests: 5, chatRequests: 1, succeeded: 4, failed: 2, pending: 0, totalRmbCost: 2.5, generatedImages: 4 });
    expect((await usageBreakdowns(db, filters)).daily).toEqual([{ day: "2026-11-02", ...summary }]);
    const withoutModel = { ...filters, modelConfigId: undefined };
    expect(await usageSummary(db, withoutModel)).toMatchObject({ visits: 1, interactions: 1, generationRequests: 6, chatRequests: 1 });
    expect(await usageCoverage(db, filters)).toMatchObject({ missingHistoryCount: 1, droppedEventCount: 0 });
    expect(await usageCoverage(db, withoutModel)).toMatchObject({ missingHistoryCount: 1, droppedEventCount: 8 });
    const all = await usagePeople(db, filters, { page: 1, pageSize: 200 });
    expect(all.pagination.total).toBe(4);
    expect(all.people.find(person => person.userId === idle)).toMatchObject({ lastActivityAt: null, summary: { generationRequests: 0, totalRmbCost: 0 } });
    expect(all.people.some(person => person.userId === guest)).toBe(false);
    const value = (person: typeof all.people[number], sort: string) => sort === "cost" ? person.summary.totalRmbCost : sort === "images" ? person.summary.generatedImages : sort === "requests" ? person.summary.generationRequests + person.summary.chatRequests : sort === "failed" ? person.summary.failed : person.lastActivityAt ? Date.parse(person.lastActivityAt) : null;
    for (const sort of ["cost", "images", "requests", "failed", "lastActivity"] as const) for (const order of ["asc", "desc"] as const) {
      const expected = [...all.people].sort((a, b) => { const av = value(a, sort), bv = value(b, sort); return av === null && bv !== null ? 1 : bv === null && av !== null ? -1 : ((av ?? 0) - (bv ?? 0)) * (order === "asc" ? 1 : -1) || a.userId.localeCompare(b.userId); }).map(person => person.userId);
      const first = await usagePeople(db, filters, { page: 1, pageSize: 2, sort, order });
      const second = await usagePeople(db, filters, { page: 2, pageSize: 2, sort, order });
      expect([...first.people, ...second.people].map(person => person.userId)).toEqual(expected);
      expect(first.pagination.total).toBe(4); expect(second.pagination.total).toBe(4);
    }
    expect(await usageSummary(db, filters)).toEqual(summary);
    const records = await usageRecords(db, filters, { page: 1, pageSize: 200 });
    expect(records.records).toHaveLength(7);
    expect(records.records.every(record => record.modelConfigId === imageModel && record.boardKey === "image" && record.userId !== guest)).toBe(true);
  } finally { await fixture.close(); }
}, 60_000);
