import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareConfiguredQuickImageTask } from "../src/quick-image-configuration";
import express from "express";
import { createTasksRouter } from "../src/routes/tasks";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";
import type { Cache } from "../src/db";
import type { TaskPausedKind } from "../../shared/task-repair";

(process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip)("owner-scoped recovery HTTP", () => {
  let pg: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let server: ReturnType<ReturnType<typeof express>["listen"]>, base: string;
  const owner = randomUUID(), deliveries: string[] = [];
  const objects = new Map<string,Buffer>();
  beforeAll(async () => {
    pg = await createIsolatedPostgres();
    await pg.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'recover-fixture','recover-fixture')", [owner]);
    const app = express(); app.use(express.json());
    app.use((req,_res,next) => { Object.assign(req, { auth: { id: req.get("x-test-actor") } }); next(); });
    const unused = async (): Promise<never> => { throw Error("unexpected cache operation in recovery"); };
    const cache: Cache = { get: unused, set: unused, del: unused, ping: unused, quit: unused, zAdd: unused, zRem: unused, zPopMin: unused, incr: unused, decr: unused, expire: unused,
      eval: async (_s, options) => { deliveries.push(options.arguments[0]!); return 1; } };
    app.use("/tasks", createTasksRouter(pg.db, cache,true,undefined,{readOriginalSizeSource:async key => objects.get(key)!}));
    server = app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("expected isolated TCP listener");
    base = `http://127.0.0.1:${address.port}/tasks`;
  }, 30_000);
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await pg?.close();
  });
  test("verified original size, quote expiry and lost-response replay never charge or enqueue twice",async () => {
    const original=randomUUID(),asset=randomUUID(),model=randomUUID(),provider=randomUUID();
    const query=pg.db.query.bind(pg.db);
    const png=execFileSync(process.env.FFMPEG_PATH || "ffmpeg",["-v","error","-f","lavfi","-i","color=s=1024x896","-frames:v","1","-threads","1","-f","image2pipe","-c:v","png","pipe:1"]);
    objects.set(asset,png);
    await query("UPDATE users SET credit_balance=1000 WHERE id=$1",[owner]);
    await query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Reissue fixture','apimart','https://no-network.invalid')",[provider]);
    await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Original image model','gpt-image-2.6-flare',ARRAY['generate','edit'],2,0)",[model,provider]);
    await query("UPDATE module_flags SET enabled=true");
    await query("UPDATE tool_api_configurations SET enabled=true,model_config_id=$1,credit_cost_override=2,rmb_cost_override=0.5 WHERE tool_key='creative-garment-colorway'",[model]);
    const url=`/api/assets/${asset}/content`;
    const archive={version:1,ownerId:owner,modelConfigId:model,modelId:"gpt-image-2.6-flare",config:{size:"1:1"},parameters:{size:"1:1"},references:[{type:"image/png",url,bytes:png.length,sha256:createHash("sha256").update(png).digest("hex")}]};
    const params={size:"1:1",inputArchive:archive};
    await query("INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,source,status) VALUES($1,$2,$3,'source.png','image/png',$4,'image','upload','ready')",[asset,owner,asset,png.length]);
    await query(`INSERT INTO tasks(id,request_id,user_id,project_id,tool_key,model_config_id,operation_type,status,paused_kind,repair_error_code,prompt,parameters,source_urls)
      VALUES($1::uuid,($1::uuid)::text,$2,'isolation','creative-garment-colorway',$3,'inpaint','paused','needs_review','RESULT_OUTPUT_INVALID','keep knit',$4,$5)`,[original,owner,model,JSON.stringify(params),JSON.stringify([url])]);
    const api=`${base}/${original}/original-size-reissue`;
    const call=(body?:unknown, actor=owner)=>fetch(api,{method:body?"POST":"GET",headers:{"x-test-actor":actor,"content-type":"application/json"},body:body ? JSON.stringify(body) : undefined});
    const children=()=>query("SELECT id,parameters,source_urls,prompt,credits FROM tasks WHERE original_size_source_id=$1",[original]);
    expect((await call(undefined,randomUUID())).status).toBe(404);
    const quote=async()=>{ const r=await call(); const b=await r.json(); expect(b).toHaveProperty("quote");return b.quote; };
    const initial=await quote(); expect(initial).toMatchObject({width:1024,height:896,credits:2});
    expect((await children()).rows).toHaveLength(0);
    await query("UPDATE tool_api_configurations SET credit_cost_override=3 WHERE tool_key='creative-garment-colorway'");
    expect((await call({confirmation:initial.confirmation})).status).toBe(409);
    const approved=await quote(); expect(approved.credits).toBe(3);
    objects.set(asset,Buffer.alloc(png.length));
    expect((await call({confirmation:approved.confirmation})).status).toBe(409);
    objects.set(asset,png);
    const before=deliveries.length;
    const [first,concurrent]=await Promise.all([call({confirmation:approved.confirmation}),call({confirmation:approved.confirmation})]); const receipt=await first.json();
    expect(receipt).toHaveProperty("task.id"); expect([200,201]).toContain(first.status);
    expect((await concurrent.json()).task.id).toBe(receipt.task.id);
    expect((await (await call({confirmation:approved.confirmation})).json()).task.id).toBe(receipt.task.id);
    expect((await (await call()).json()).task.id).toBe(receipt.task.id);
    expect((await children()).rows).toEqual([expect.objectContaining({id:receipt.task.id,prompt:"keep knit",source_urls:[url],credits:3,parameters:expect.objectContaining({size:"1024x896",n:1})})]);
    expect((await query("SELECT status,parameters FROM tasks WHERE id=$1",[original])).rows[0]).toEqual({status:"paused",parameters:params});
    expect((await query("SELECT count(*)::int AS n FROM credit_reservations WHERE user_id=$1 AND request_id=$2",[owner,`review-size:${original}`])).rows[0].n).toBe(1);
    expect(deliveries.slice(before)).toEqual([receipt.task.id]);
    const quickId=randomUUID();
    await query("INSERT INTO quick_image_configurations(action,model_config_id,prompt,parameters) VALUES('remove-background',$1,'保留彩色主体，去掉背景',$2)",[model,JSON.stringify({size:"1:1"})]);
    const quick=await prepareConfiguredQuickImageTask(pg.db,{operationType:"inpaint",toolKey:"image-edit",prompt:"",sourceUrls:[url],parameters:{quickImageAction:"remove-background"}});
    await query("UPDATE assets SET content_sha256=$2 WHERE id=$1",[asset,archive.references[0]!.sha256]);
    await query(`INSERT INTO tasks(id,request_id,user_id,project_id,tool_key,model_config_id,operation_type,status,paused_kind,repair_error_code,prompt,parameters,source_urls)
      VALUES($1::uuid,($1::uuid)::text,$2,'isolation','image-edit',$3,'inpaint','paused','needs_review','IMAGE_RESULT_TRANSPARENCY_MISSING',$4,$5,$6)`,[quickId,owner,model,quick.prompt,JSON.stringify(quick.parameters),JSON.stringify([url])]);
    const quickUrl=`${base}/${quickId}/original-size-reissue`;
    const quickQuote=await (await fetch(quickUrl,{headers:{"x-test-actor":owner}})).json();
    expect(quickQuote.quote).toMatchObject({width:1024,height:896});
    await query("UPDATE tasks SET paused_kind='submission_unknown' WHERE id=$1",[quickId]);
    expect((await fetch(quickUrl,{method:"POST",headers:{"x-test-actor":owner,"content-type":"application/json"},body:JSON.stringify({confirmation:quickQuote.quote.confirmation})})).status).toBe(409);
    await query("UPDATE model_configs SET model_id='gemini-nano-banana-2.1' WHERE id=$1",[model]);
    const ratioOnly={...params,inputArchive:{...archive,modelId:"gemini-nano-banana-2.1"}};
    await query("UPDATE tasks SET paused_kind='needs_review',parameters=$1 WHERE id=$2",[JSON.stringify(ratioOnly),quickId]);
    const unsupported=await fetch(quickUrl,{headers:{"x-test-actor":owner}});
    expect(unsupported.status).toBe(409);
    expect((await unsupported.json()).message).toContain("1024x896");
    expect((await query("SELECT count(*)::int AS n FROM tasks WHERE original_size_source_id=$1",[quickId])).rows[0].n).toBe(0);
    expect(deliveries.slice(before)).toEqual([receipt.task.id]);
  });
  test("only the owner's persisted provider originals are offered, even before role metadata is written", async () => {
    const task = randomUUID(), other = randomUUID(), asset = randomUUID();
    await pg.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'other-reviewer','other-reviewer')", [other]);
    await pg.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,paused_kind)
      VALUES($1::uuid,($1::uuid)::text,$2,'test','inpaint','paused','needs_review')`, [task,owner]);
    const get = (user: string) => fetch(`${base}/${task}/review-originals`, {headers: {"x-test-actor": user}});
    const before = deliveries.length;
    expect(await (await get(owner)).json()).toEqual({taskId:task, originals:[]});
    const prefix = `users/${owner}/generated/${task}/task-${task}-`;
    for (const [id, user, suffix, source, deleted] of [
      [asset,owner,"2-provider-original.png","edit",false],
      [randomUUID(),owner,"1.png","edit",false],
      [randomUUID(),owner,"1-export.png","edit",false],
      [randomUUID(),other,"3-provider-original.png","edit",false],
      [randomUUID(),owner,"4-provider-original.png","upload",false],
      [randomUUID(),owner,"5-provider-original.png","edit",true],
      [randomUUID(),owner,"6-provider-original.jpg","edit",false],
    ] as const) {
      await pg.db.query(`INSERT INTO assets(id,owner_user_id,task_id,object_key,filename,mime_type,byte_size,source,status,deleted_at)
        VALUES($1,$2,$3,$4,'renamed-by-user','image/png',21,$5,'ready',CASE WHEN $6::boolean THEN now() END)`, [id,user,task,prefix+suffix,source,deleted]);
    }
    const response = await get(owner);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({taskId:task, originals:[{assetId:asset,resultIndex:1,mimeType:"image/png",bytes:21,filename:`task-${task}-2-provider-original.png`}]});
    expect((await get(other)).status).toBe(404);
    await pg.db.query("UPDATE tasks SET paused_kind='submission_unknown' WHERE id=$1",[task]);
    expect((await get(owner)).status).toBe(404);
    expect(deliveries.length).toBe(before);
  });
  test.each([
    ["result_repair",true,"重新保存"],["awaiting_query",true,"原任务查询"],["submission_unknown",false,"不会自动重发"],["needs_review",false,"管理员"],
  ] satisfies Array<[TaskPausedKind, boolean, string]>)("%s: recovery never creates another task or misreports a new charge", async (kind, allowed, message) => {
    const id = randomUUID();
    await pg.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,attempts,paused_kind,upstream_task_id,upstream_submission_started_at,failure_reason)
      VALUES ($1::uuid,($1::uuid)::text,$2,'test','inpaint','paused',1,$3,$4,now(),'private-internal-reason')`, [id,owner,kind,kind === "submission_unknown" ? null : "original-id"]);
    const url = `${base}/${id}/recover`;
    const post = (actor: string) => fetch(url, { method: "POST", headers: { "x-test-actor": actor } });
    expect((await post(randomUUID())).status).toBe(404);
    const before = deliveries.length;
    const response = await post(owner), body = await response.json();
    expect(response.status).toBe(200); expect(body.recovered).toBe(allowed);
    expect(body.message).toContain(message);
    expect(JSON.stringify(body)).not.toContain("private-internal-reason");
    expect(deliveries.slice(before)).toEqual(allowed ? [id] : []);
    expect(body.task).toMatchObject({ id, attempts: 1, repairAttempts: allowed ? 1 : 0, status: allowed ? "waiting" : "paused" });
  });
});
