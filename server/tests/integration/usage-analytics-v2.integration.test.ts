import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";
import {
  usageV2Overview,
  usageV2Boards,
  usageV2Quality,
  usageV2Models,
  usageV2People,
  usageV2Profile,
  usageV2Flows,
  usageV2QuerySchema,
  usageV2FactsCte,
} from "../../src/usage-analytics-v2";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { queueUsageRollup, processUsageRollups } from "../../src/usage-rollups";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const scope: UsageV2Scope = {
  from: "2026-10-30T00:00:00+08:00",
  to: "2026-11-01T00:00:00+08:00",
  timezone: "Asia/Shanghai",
  compare: "previous_period",
  departmentBasis: "at_event",
};

sqlTest("v2 budgets decompressed PostgreSQL facts and never fetches irrelevant large task parameters", async () => {
  const fixture = await createIsolatedPostgres(), db = fixture.db;
  try {
    const user = randomUUID();
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'toast-user','Toast fixture','designer',false)", [user]);
    await db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,parameters,status,queued_at,tool_key)
      SELECT id,id::text,$1,'fixture','image_generation',jsonb_build_object('quality','high','privateExtra',repeat('x',100000)),'failed','2026-10-30T01:00:00Z','image'
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,350)) fixture`, [user]);
    const storage = (await db.query("SELECT sum(pg_column_size(parameters)) AS compressed,sum(octet_length(parameters::text)) AS expanded FROM tasks WHERE user_id=$1", [user])).rows[0];
    expect(Number(storage.compressed)).toBeLessThan(32 * 1024 * 1024);
    expect(Number(storage.expanded)).toBeGreaterThan(32 * 1024 * 1024);
    const projected = (await db.query(`${usageV2FactsCte} SELECT parameters FROM facts WHERE user_id=$1`, [user])).rows;
    expect(projected).toHaveLength(350);
    expect(projected.every((row) => JSON.stringify(row.parameters) === '{"quality":"high"}')).toBe(true);
    const selected = { ...scope, compare: "none" as const, userIds: [user] };
    expect((await usageV2Overview(db, selected)).metrics.failed.value).toBe(350);
    // A required, highly compressible result URL must still hit the real byte
    // budget before it is fetched, not pass because its TOAST storage is small.
    await db.query("UPDATE tasks SET result_urls=jsonb_build_array('https://synthetic.invalid/'||repeat('x',100000)) WHERE user_id=$1", [user]);
    await expect(usageV2Overview(db, selected)).rejects.toMatchObject({ code: "USAGE_SCOPE_TOO_LARGE", status: 422 });
  } finally { await fixture.close(); }
}, 120000);

sqlTest(
  "v2 formal SQL: cohort results, exact booked costs, full percentiles, department snapshots, compound filters and private-safe HTTP",
  async () => {
    const fixture = await createIsolatedPostgres({ usageRollupsEnabled: true }),
      db = fixture.db;
    let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
    try {
      const alice = randomUUID(),
        bob = randomUUID(),
        idle = randomUUID(),
        guest = randomUUID(),
        oldDepartment = randomUUID(),
        newDepartment = randomUUID();
      await db.query(
        "INSERT INTO departments(id,name,code) VALUES($1,'Old department','old'),($2,'New department','new')",
        [oldDepartment, newDepartment],
      );
      for (const [id, name, isGuest] of [
        [alice, "Alice private", false],
        [bob, "Bob", false],
        [idle, "literal%_employee", false],
        [guest, "Guest", true],
      ])
        await db.query(
          "INSERT INTO users(id,username,display_name,role,is_guest,must_change_password,department_id) VALUES($1,$2::text,$2::text,'designer',$3,false,$4)",
          [id, name, isGuest, newDepartment],
        );
      const provider = randomUUID(),
        model = randomUUID(),
        otherModel = randomUUID();
      await db.query(
        "INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Fixture','openai','https://never-called.invalid','unused')",
        [provider],
      );
      for (const id of [model, otherModel])
        await db.query(
          "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,$1::uuid::text,$1::uuid::text,ARRAY['generate'],999)",
          [id, provider],
        );
      const task = async (
        options: {
          user?: string;
          at?: string;
          duration?: number;
          history?: boolean;
          status?: string;
          operation?: string;
          model?: string;
          board?: string;
          reason?: string;
          cost?: number;
          urls?: unknown[];
          attempts?: number;
        } = {},
      ) => {
        const id = randomUUID(),
          at = options.at ?? "2026-10-30T02:00:00Z",
          status = options.status ?? "success",
          duration = options.duration ?? 100;
        await db.query(
          "INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,rmb_cost,result_urls,queued_at,started_at,completed_at,failure_reason,attempts) VALUES($1,$1::uuid::text,$2,$3,'fixture',$4,$5,'SECRET raw prompt','{\"quality\":\"high\",\"n\":99}',$6,$7,999,$8,$9,$10,$11,$12,$13)",
          [
            id,
            options.user ?? alice,
            oldDepartment,
            options.operation ?? "image_generation",
            options.model ?? model,
            options.board ?? "image",
            status,
            JSON.stringify(
              options.urls ?? ["https://private.invalid/SECRET.png"],
            ),
            at,
            new Date(Date.parse(at) + Math.min(5, duration)).toISOString(),
            status === "success"
              ? new Date(Date.parse(at) + duration).toISOString()
              : null,
            options.reason ?? null,
            options.attempts ?? 1,
          ],
        );
        if (options.history !== false && status === "success")
          await db.query(
            "INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1",
            [id, options.cost ?? 0.1],
          );
        return id;
      };
      const first = await task({
          at: "2026-10-29T16:00:00Z",
          duration: 10,
          cost: 0.16104,
        }),
        second = await task({ duration: 20, cost: 0.2 }),
        third = await task({ duration: 30, cost: 0.3 }),
        fourth = await task({
          at: "2026-10-31T01:00:00Z",
          duration: 1000,
          history: false,
        });
      const primary = randomUUID(),
        original = randomUUID(),
        exported = randomUUID(),
        secondAsset = randomUUID(),
        videoAsset = randomUUID();
      for (const [id, taskId, role, kind, mime] of [
        [primary, first, "primary", "image", "image/png"],
        [original, first, "provider-original", "image", "image/png"],
        [exported, first, "export", "image", "image/png"],
        [secondAsset, second, "primary", "image", "image/png"],
        [videoAsset, first, "primary", "video", "video/mp4"],
      ]) {
        const metadata = {
          imageResult: {
            version: 1,
            role,
            resultIndex: 0,
            original: {
              assetId: taskId === first ? original : secondAsset,
              mimeType: "image/png",
              filename: "private.png",
            },
            export: {
              assetId: taskId === first ? exported : secondAsset,
              mimeType: "image/png",
              filename: "private.png",
            },
            maskComposited: false,
          },
        };
        await db.query(
          "INSERT INTO assets(id,owner_user_id,department_id,task_id,object_key,filename,mime_type,kind,status,metadata) VALUES($1,$2,$3,$4,$1::uuid::text,'SECRET.png',$5,$6,'ready',$7)",
          [
            id,
            alice,
            oldDepartment,
            taskId,
            mime,
            kind,
            JSON.stringify(metadata),
          ],
        );
      }
      const resultUrls = [
        `/api/assets/${primary}/content`,
        `/api/assets/${original}/content`,
        `/api/assets/${exported}/content`,
        `/api/assets/${primary}/content`,
        `/api/assets/${videoAsset}/content`,
        "",
        null,
        { ignored: true },
      ];
      for (const [id, urls] of [
        [first, resultUrls],
        [second, [`/api/assets/${secondAsset}/content`]],
      ]) {
        await db.query("UPDATE tasks SET result_urls=$2 WHERE id=$1", [
          id,
          JSON.stringify(urls),
        ]);
        await db.query(
          "UPDATE generation_history SET result_urls=$2 WHERE task_id=$1",
          [id, JSON.stringify(urls)],
        );
      }
      const event = async (
        asset: string,
        taskId: string,
        type: string,
        source?: string,
      ) => {
        const id = randomUUID();
        await db.query(
          "INSERT INTO asset_events(id,asset_id,designer_user_id,actor_user_id,task_id,event_type,idempotency_key,source_event_id,occurred_at) VALUES($1,$2,$3,$3,$4,$5,$1::uuid::text,$6,'2026-10-31T10:00:00Z')",
          [id, asset, alice, taskId, type, source ?? null],
        );
        return id;
      };
      await event(primary, first, "asset.downloaded");
      await event(primary, first, "asset.downloaded");
      await event(exported, first, "asset.exported");
      await event(primary, first, "asset.project_added");
      const adopted = await event(original, first, "asset.adopted");
      await event(original, first, "asset.event_reversed", adopted);
      await event(secondAsset, second, "asset.adopted");
      await task({ operation: "video_generation", cost: 5 });
      await task({ operation: "audio_generation", cost: 2 });
      await task({
        status: "failed",
        reason: "provider timeout Authorization Bearer SECRET",
        attempts: 3,
      });
      await task({
        status: "failed",
        reason: "upstream result uncertain SECRET",
      });
      await task({ status: "cancelled" });
      await task({ status: "paused" });
      await task({ status: "waiting" });
      await task({ status: "processing" });
      await task({
        user: bob,
        cost: 99,
        model: otherModel,
        board: "canvas-image",
      });
      await task({ user: guest, cost: 90 });
      await task({ at: "2026-10-29T15:59:59Z", status: "failed", urls: [] });
      await task({ at: "2026-10-31T16:00:00Z", cost: 77 });
      for (const [status, at] of [
        ["success", "2026-10-30T03:00:00Z"],
        ["interrupted", "2026-10-30T04:00:00Z"],
      ])
        await db.query(
          "INSERT INTO usage_chat_requests(id,user_id,model_config_id,board_key,prompt,status,created_at) VALUES($1,$2,$3,'image','SECRET chat',$4,$5)",
          [randomUUID(), alice, model, status, at],
        );
      for (const [action, control, parameters] of [
        ["visit", null, {}],
        ["change", "quality", { quality: "high" }],
        ["gap", "collection-gap", { droppedEventCount: 7 }],
      ])
        await db.query(
          "INSERT INTO usage_events(event_id,user_id,board_key,action,control_key,parameters,occurred_at) VALUES($1,$2,'image',$3,$4,$5,'2026-10-30T05:00:00Z')",
          [randomUUID(), alice, action, control, JSON.stringify(parameters)],
        );
      await db.query(
        "INSERT INTO prompt_recipes(key,settings,updated_at) VALUES('fixture','{}','2026-10-01')",
      );
      await db.query(
        "INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at) VALUES('version','fixture',1,'hash','{}','fixture','2026-10-01')",
      );
      await db.query(
        "INSERT INTO prompt_compilations(id,user_id,request_id,input_hash,recipe_key,recipe_version_id,status,details,created_at) VALUES('original',$1,'compile-original','hash','fixture','version','success','{\"actualCost\":0.123456,\"currency\":\"USD\",\"inputTokens\":100,\"outputTokens\":20,\"rawResponse\":\"SECRET\"}','2026-10-30')",
        [alice],
      );
      await db.query(
        "INSERT INTO prompt_compilations(id,user_id,request_id,input_hash,recipe_key,recipe_version_id,status,reused_from_id,details,created_at) VALUES('reused',$1,'compile-reuse','hash','fixture','version','success','original','{\"actualCost\":9,\"currency\":\"USD\",\"inputTokens\":999}','2026-10-30')",
        [alice],
      );
      await db.query(
        "UPDATE tasks SET prompt_compilation_id=CASE WHEN id=$1 THEN 'original' ELSE 'reused' END,prompt_optimized=true WHERE id=ANY($2::uuid[])",
        [first, [first, second, third]],
      );

      const selected = { ...scope, userIds: [alice] };
      const overview = await usageV2Overview(db, selected);
      expect(overview.metrics.generationRequests.value).toBe(12);
      expect(overview.metrics.generatedImages.value).toBe(4);
      expect(overview.metrics.generationBookedCny).toMatchObject({
        value: 7.66104,
        amount: "7.661040",
        state: "partial",
        availableCount: 5,
        missingCount: 1,
        basis: "booked",
      });
      expect(overview.metrics.imageBookedCny).toMatchObject({
        value: 0.66104,
        amount: "0.661040",
        missingCount: 1,
      });
      expect(overview.metrics.costPerImage.value).toBeCloseTo(0.66104 / 4, 9);
      expect(overview.metrics.succeeded.value).toBe(7);
      expect(overview.metrics.failed.value).toBe(1);
      expect(overview.metrics.uncertain.value).toBe(1);
      expect(overview.metrics.cancelled.value).toBe(1);
      expect(overview.metrics.paused.value).toBe(1);
      expect(overview.metrics.interrupted.value).toBe(1);
      expect(overview.metrics.pending.value).toBe(2);
      expect(overview.metrics.successRate.value).toBe(0.875);
      expect(overview.metrics.activeDays.value).toBe(2);
      expect(overview.metrics.activePeople.value).toBe(1);
      expect(overview.metrics.activeSeconds).toMatchObject({
        value: null,
        state: "unavailable",
      });
      expect(overview.daily.map((d) => d.day)).toEqual([
        "2026-10-30",
        "2026-10-31",
      ]);
      expect(overview.metrics.generatedImages.comparison).toMatchObject({
        value: 0,
        relativeDelta: null,
        reason: "zero_baseline",
      });
      expect(overview.metrics.successRate.comparison).toMatchObject({
        value: 0,
        absoluteDelta: 87.5,
        unit: "percentage_points",
      });
      expect(overview.metrics.successRate.comparison?.reason).toBeUndefined();
      expect(
        overview.meta.coverage.find(
          (c) => c.metric === "reportedCollectionGaps",
        ),
      ).toMatchObject({ unknown: 7, state: "partial" });
      expect(overview.departments.map((d) => d.key).sort()).toEqual(
        [oldDepartment, "unknown"].sort(),
      );
      const imageOnly = await usageV2Overview(db, {
        ...selected,
        operationTypes: ["image_generation"],
      });
      expect(imageOnly.metrics.totalMsP50).toMatchObject({
        value: 25,
        availableCount: 4,
        missingCount: 0,
      });
      expect(imageOnly.metrics.totalMsP90.value).toBeCloseTo(709, 8);
      const compound = await usageV2Overview(db, {
        ...selected,
        departmentIds: [oldDepartment],
        boardKeys: ["image"],
        modelConfigIds: [model],
        operationTypes: ["image_generation"],
      });
      expect(compound.metrics.generatedImages.value).toBe(4);
      expect(compound.metrics.visits.value).toBe(0);
      expect(compound.metrics.chatRequests.value).toBe(0);
      const wrongDepartment = await usageV2Overview(db, {
        ...selected,
        departmentIds: [newDepartment],
      });
      expect(wrongDepartment.metrics.generationRequests.value).toBe(0);
      expect(wrongDepartment.metrics.successRate.value).toBeNull();
      const current = await usageV2Overview(db, {
        ...selected,
        departmentBasis: "current",
        departmentIds: [newDepartment],
      });
      expect(current.metrics.visits.value).toBe(1);
      expect(current.metrics.generationRequests.value).toBe(12);

      const quality = await usageV2Quality(db, selected);
      expect(quality.resultUse).toMatchObject({
        generatedImages: 4,
        linkedImages: 2,
        unlinkedImages: 2,
        usedImages: 2,
        formallyAdoptedImages: 1,
      });
      expect(quality.metrics.resultUseRate).toMatchObject({
        value: 0.5,
        state: "partial",
        numerator: 2,
        denominator: 4,
      });
      expect(quality.metrics.formalAdoptionRate).toMatchObject({
        value: 0.25,
        state: "partial",
      });
      expect(quality.failures.map((f) => f.category).sort()).toEqual(
        [
          "paused",
          "provider_timeout",
          "uncertain",
          "user_cancelled",
          "interrupted",
        ].sort(),
      );
      expect(quality.retries).toContainEqual({ attempts: 3, tasks: 1 });
      expect(JSON.stringify(quality)).not.toContain("SECRET");
      expect(JSON.stringify(quality)).not.toContain("private.invalid");
      const models = await usageV2Models(db, selected);
      expect(models.optimizationCosts).toMatchObject({
        executions: 1,
        cacheHits: 1,
        inputTokens: { value: 100 },
        outputTokens: { value: 20 },
        costs: [
          {
            currency: "USD",
            providerReportedAmount: "0.123456",
            estimatedAmount: "0.000000",
            knownCount: 1,
          },
        ],
      });
      expect(models.models.every((row) => !!row.operationType)).toBe(true);
      expect(
        models.models.filter(
          (row) => row.operationType === "image_generation",
        )[0]?.metrics.totalMsP50.value,
      ).toBe(25);
      const boards = await usageV2Boards(db, selected);
      expect(boards.controlUsage[0]).toMatchObject({
        controlKey: "quality",
        users: 1,
        eligibleUsers: 1,
        rate: { value: 1 },
      });
      expect(boards.conversion.value).toBeNull();
      const flows = await usageV2Flows(db, selected);
      expect(flows.paths).toEqual([]);
      expect(flows.pathCoverage.state).toBe("unavailable");
      expect(flows.funnels[0]?.mode).toBe("stage_coverage");
      const people = await usageV2People(
        db,
        scope,
        usageV2QuerySchema.parse({
          sort: "generationBookedCny",
          order: "desc",
          pageSize: "1",
        }),
      );
      expect(people.people[0]?.userId).toBe(bob);
      expect(people.pagination.total).toBe(3);
      const lastPage = await usageV2People(
        db,
        scope,
        usageV2QuerySchema.parse({
          sort: "generationBookedCny",
          order: "desc",
          pageSize: "1",
          page: "3",
        }),
      );
      expect(lastPage.people[0]?.userId).toBe(idle);
      const profile = await usageV2Profile(
        db,
        selected,
        alice,
        usageV2QuerySchema.parse({ pageSize: "2" }),
      );
      expect(profile.activityPage.records).toHaveLength(2);
      expect(profile.person.departmentId).toBe(newDepartment);
      expect(JSON.stringify(profile)).not.toContain("SECRET");
      expect(profile.activityPage.pagination.total).toBe(16);

      // Production HTTP readers now require durable daily projections; the
      // direct calls above intentionally remain the live shadow baseline.
      await queueUsageRollup(db, { fromDay: "2026-10-30", toDay: "2026-10-31", idempotencyKey: randomUUID() }, alice);
      expect((await processUsageRollups(db, 2)).every(step => step.status === "processed")).toBe(true);

      let role = "super_admin";
      const app = express();
      app.use(express.json());
      app.use((request, _response, next) => {
        Object.assign(request, {
          auth: { id: alice, role, departmentId: newDepartment },
        });
        next();
      });
      app.use("/usage", createAdminUsageRouter(db, {} as AppConfig));
      app.use(((error, _request, response, _next) =>
        response
          .status(500)
          .json({ message: error.message })) as ErrorRequestHandler);
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`;
      const search = new URLSearchParams({
        from: scope.from,
        to: scope.to,
        compare: "none",
        userIds: alice,
      });
      for (const endpoint of [
        "overview",
        "boards",
        "boards/image",
        "models",
        "quality",
        "flows",
        "people-v2",
        `people/${alice}/profile`,
        "options",
      ]) {
        const response = await fetch(`${base}/${endpoint}?${search}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json();
        expect(body.code).toBe(0);
        expect(JSON.stringify(body)).not.toContain("SECRET");
      }
      const invalid = await fetch(`${base}/overview?from=bad&search=SECRET`);
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).not.toContain("SECRET");
      for (const denied of ["designer", "department_admin"]) {
        role = denied;
        const response = await fetch(`${base}/overview?${search}`);
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      role = "super_admin";
      const exactSearch = await fetch(
        `${base}/options?search=${encodeURIComponent("%_")}`,
      );
      expect(
        (await exactSearch.json()).data.people.map((p: { id: string }) => p.id),
      ).toEqual([idle]);
      const legacy = await fetch(
        `${base}/people?from=${encodeURIComponent(scope.from)}&to=${encodeURIComponent(scope.to)}`,
      );
      expect(legacy.status).toBe(200);
      expect((await legacy.json()).data.summary).toBeDefined();
      // Analysis reads may write scoped audits, never generation results or financial data.
      expect(
        Number(
          (await db.query("SELECT rmb_cost FROM tasks WHERE id=$1", [first]))
            .rows[0].rmb_cost,
        ),
      ).toBe(999);
      expect(
        Number(
          (
            await db.query(
              "SELECT rmb_cost FROM generation_history WHERE task_id=$1",
              [first],
            )
          ).rows[0].rmb_cost,
        ),
      ).toBe(0.16104);
      expect(
        JSON.stringify(
          (
            await db.query(
              "SELECT detail FROM audit_logs WHERE action LIKE 'usage.v2.%'",
            )
          ).rows,
        ),
      ).not.toContain("SECRET");
      expect([third, fourth]).toHaveLength(2);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await fixture.close();
    }
  },
  120000,
);

sqlTest(
  "v2 missing history, unknown models, bad timestamps and unlinked outputs remain unavailable/partial rather than invented zero costs or durations",
  async () => {
    const fixture = await createIsolatedPostgres(),
      db = fixture.db;
    try {
      const user = randomUUID();
      await db.query(
        "INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'missing-user','Missing','designer',false)",
        [user],
      );
      for (const [urls, completed] of [
        [[], null],
        [["https://unlinked.invalid/image.png"], "2026-10-29T12:00:00Z"],
      ]) {
        const id = randomUUID();
        await db.query(
          "INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,parameters,status,result_urls,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,'fixture','image_generation','{\"tool\":\"image\"}','success',$3,'2026-10-30T01:00:00Z','2026-10-30T01:00:05Z',$4)",
          [id, user, JSON.stringify(urls), completed],
        );
      }
      const selected = { ...scope, compare: "none" as const, userIds: [user] };
      const overview = await usageV2Overview(db, selected);
      expect(overview.metrics.generationBookedCny).toMatchObject({
        value: null,
        state: "unavailable",
        availableCount: 0,
        missingCount: 2,
      });
      expect(overview.metrics.generatedImages).toMatchObject({
        value: 1,
        state: "partial",
        availableCount: 1,
        missingCount: 1,
      });
      for (const key of [
        "totalMsP50",
        "totalMsP90",
        "waitMsP50",
        "runMsP50",
        "costPerImage",
        "costPerUsedImage",
        "resultUseRate",
        "formalAdoptionRate",
      ] as const)
        expect(overview.metrics[key]).toMatchObject({
          value: null,
          state: "unavailable",
        });
      const models = await usageV2Models(db, selected);
      expect(models.models[0]?.modelConfigId).toBeNull();
      expect(models.models[0]?.boardKey).toBe("image");
      const empty = await usageV2Overview(db, {
        ...selected,
        modelConfigIds: [randomUUID()],
      });
      expect(empty.metrics.generatedImages.value).toBe(0);
      expect(empty.metrics.successRate.value).toBeNull();
      expect(empty.metrics.totalMsP50.value).toBeNull();
      await expect(
        usageV2Profile(
          db,
          { ...selected, userIds: [randomUUID()] },
          user,
          usageV2QuerySchema.parse({}),
        ),
      ).rejects.toMatchObject({ code: "USAGE_PERSON_NOT_FOUND", status: 404 });
    } finally {
      await fixture.close();
    }
  },
  60000,
);
