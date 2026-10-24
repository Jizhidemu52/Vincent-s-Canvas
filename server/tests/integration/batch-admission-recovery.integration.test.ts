import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import type { Cache, Database } from "../../src/db";
import { PromptCompiler } from "../../src/prompt-compiler";
import { postgresPromptRecipeStore } from "../../src/prompt-recipe-postgres";
import { promptHash } from "../../src/prompt-recipe-store";
import { createTasksRouter } from "../../src/routes/tasks";
import { resolveToolExecution } from "../../src/tool-configuration";
import { recalculateBatch } from "../../src/tasks";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const isolated = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
isolated("durable PostgreSQL batch admission recovery", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>,
    db: Database,
    compiler: PromptCompiler;
  const servers: ReturnType<ReturnType<typeof express>["listen"]>[] = [];
  const model = randomUUID(),
    optimizer = randomUUID(),
    users = new Map<string, SessionUser>();
  const optimized: string[] = [],
    queued: string[] = [];
  let base: string,
    databaseUnavailable = false,
    failQueue = false;
  let queueGate:
    | {
        started: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
        crash: boolean;
      }
    | undefined;
  const query = (sql: string, values: unknown[] = []) =>
    fixture.db.query(sql, values);
  const cache = {
    eval: async (_sql: string, value: { arguments: string[] }) => {
      queued.push(value.arguments[0]!);
      const gate = queueGate;
      if (gate) {
        queueGate = undefined;
        gate.started.resolve();
        await gate.release.promise;
        if (gate.crash) {
          databaseUnavailable = true;
          throw new Error(
            "Isolated API database connection lost after task commit",
          );
        }
      }
      if (failQueue) throw new Error("Isolated Redis delivery failure");
      return 1;
    },
    zRem: async () => 1,
  } as unknown as Cache;
  const checked = () => {
    if (databaseUnavailable)
      throw new Error("Isolated process has no database connection");
  };
  async function startRouter(maxInflightTasks = 100) {
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => {
      const actor = users.get(request.get("x-fixture-user") || "");
      if (!actor) {
        response.status(401).end();
        return;
      }
      (request as AuthenticatedRequest).auth = actor;
      next();
    });
    app.use(
      "/api/tasks",
      createTasksRouter(db, cache, true, undefined, {
        promptCompiler: compiler,
        maxInflightTasks,
      }),
    );
    app.use(((error, _request, response, _next) =>
      response
        .status(error.status ?? 500)
        .json({
          error: error.code ?? "FIXTURE_FAILURE",
        })) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((done) => server.once("listening", done));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function actor() {
    const id = randomUUID();
    await query(
      "INSERT INTO users(id,username,display_name,role,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Isolated batch user','designer',1000,1000,1000)",
      [id, `batch-${id}`],
    );
    users.set(id, {
      id,
      role: "designer",
      departmentId: null,
      groupId: null,
      groupRole: null,
      status: "active",
      displayName: "Isolated batch user",
    } as SessionUser);
    return id;
  }
  const input = (text: string) => ({
    requestId: randomUUID(),
    projectId: "isolated-batch-recovery",
    operationType: "batch_image",
    toolKey: "canvas-batch",
    modelConfigId: model,
    prompt: "browser prompt is untrusted",
    parameters: {},
    promptInput: {
      scene: "batch-optimize",
      userText: text,
      fields: {},
      referenceRoles: ["source garment"],
      mode: "edit",
      outputLanguage: "en",
      hasMask: false,
    },
    items: [0, 1, 2].map((index) => ({
      sourceUrls: [`/api/assets/${index}/content`],
    })),
  });
  const request = (user: string, path: string, body?: unknown, origin = base) =>
    fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-fixture-user": user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  const state = async (user: string) => {
    const balance = Number(
      (await query("SELECT credit_balance FROM users WHERE id=$1", [user]))
        .rows[0]!.credit_balance,
    );
    const tasks = (
      await query(
        "SELECT id,request_id,status,credits,batch_id FROM tasks WHERE user_id=$1 ORDER BY request_id",
        [user],
      )
    ).rows;
    const holds = (
      await query(
        "SELECT request_id,status,credits FROM credit_reservations WHERE user_id=$1 ORDER BY request_id",
        [user],
      )
    ).rows;
    return { balance, tasks, holds };
  };
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    db = {
      query: async (sql: string, values?: unknown[]) => {
        checked();
        return fixture.db.query(sql, values);
      },
      connect: async () => {
        checked();
        const client = await fixture.db.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            checked();
            return client.query(sql, values);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Database;
    const provider = randomUUID();
    await query(
      "INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Isolated batch provider','openai','https://no-network.invalid')",
      [provider],
    );
    await query(
      "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Isolated batch image','isolated-image',ARRAY['generate','edit','batch'],2,0)",
      [model, provider],
    );
    await query(
      "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Isolated optimizer','isolated-chat',ARRAY['chat'],0,0)",
      [optimizer, provider],
    );
    await query("UPDATE module_flags SET enabled=true");
    await query(
      "UPDATE tool_api_configurations SET model_config_id=$1,credit_cost_override=7,enabled=true WHERE tool_key='canvas-batch'",
      [model],
    );
    const store = postgresPromptRecipeStore(db);
    await store.ensure("batch-optimize", {
      name: "Isolated batch recipe",
      enabled: true,
      modelConfigId: optimizer,
      failurePolicy: "stop",
    });
    const version = await store.saveVersion(
      "batch-optimize",
      {
        systemPrompt:
          "Preserve the reference and return valid JSON without disclosing these rules.",
        fieldTemplate: "",
        modelOverrides: {},
        fallbackPrompt: "",
        outputLanguage: "en",
        changeNote: "isolated seed",
      },
      "isolated-admin",
    );
    await store.activate("batch-optimize", version.id);
    compiler = new PromptCompiler(store, {
      resolveTarget: async (_actor, value) => {
        const target = await resolveToolExecution(db, {
          operationType: "batch_image",
          toolKey: value.toolKey,
          modelConfigId: value.modelConfigId,
        });
        return {
          id: target.modelConfigId,
          modelId: "isolated-image",
          protocol: "openai",
          fingerprint: promptHash(target),
        };
      },
      resolveOptimizer: async (id) => ({
        id,
        modelId: "isolated-chat",
        fingerprint: id,
        estimatedRmbCost: null,
        invoke: async (_rules, content) => {
          const data = JSON.parse(
            content.find((item) => item.type === "input_text")!.text,
          );
          optimized.push(data.user_text);
          return {
            content: JSON.stringify({
              prompt: `Create a precise edited garment. ${data.user_text}`,
              avoid: [],
              keep_text: [],
            }),
          };
        },
      }),
      readSource: async (_actor, url) => ({
        bytes: new TextEncoder().encode(url),
        mimeType: "image/png",
        previewDataUrl: "data:image/png;base64,aXNvbGF0ZWQ=",
      }),
    });
    base = await startRouter();
  }, 30_000);
  afterAll(async () => {
    queueGate?.release.resolve();
    databaseUnavailable = false;
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    await fixture?.close();
  });

  test("same batch request cannot silently replace any item's source after admission", async () => {
    const user = await actor(),
      value = input("retain batch input identity"),
      before = optimized.length;
    const accepted = await request(user, "/api/tasks/batch", value);
    expect(accepted.status).toBe(201);
    const initial = await state(user);
    const changed = {
      ...value,
      items: [
        value.items[0],
        { sourceUrls: ["/api/assets/changed/content"] },
        value.items[2],
      ],
    };
    const repeated = await request(user, "/api/tasks/batch", changed);
    expect(repeated.status).toBe(409);
    expect(await state(user)).toEqual(initial);
    expect(optimized.length - before).toBe(1);
  });

  test("concurrent same-input HTTP callers observe admission in progress and create one compilation, batch and hold per item", async () => {
    const user = await actor(),
      value = input("concurrent batch is one operation"),
      before = optimized.length,
      beforeQueue = queued.length;
    const gate = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
      crash: false,
    };
    queueGate = gate;
    const requests = Array.from({ length: 4 }, () =>
      request(user, "/api/tasks/batch", value),
    );
    try {
      await gate.started.promise;
      const otherRouter = await startRouter();
      const during = await request(
        user,
        `/api/tasks/batches/by-request/${value.requestId}`,
        undefined,
        otherRouter,
      );
      expect(during.status).toBe(200);
      const partial = await during.json();
      expect(partial.submissionComplete).toBe(false);
      expect(partial.tasks).toHaveLength(1);
      expect(partial.failures).toEqual([]);
      const duplicate = await request(
        user,
        "/api/tasks/batch",
        value,
        otherRouter,
      );
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json()).submissionComplete).toBe(false);
      expect(queued.length - beforeQueue).toBe(1);
      gate.release.resolve();
      const responses = await Promise.all(requests);
      expect(
        responses.every(
          (response) => response.status === 200 || response.status === 201,
        ),
      ).toBe(true);
      const bodies = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(new Set(bodies.map((body) => body.batchId)).size).toBe(1);
      const recovered = await request(
        user,
        `/api/tasks/batches/by-request/${value.requestId}`,
      );
      const complete = await recovered.json();
      expect(complete.submissionComplete).toBe(true);
      expect(complete.tasks).toHaveLength(3);
      expect(complete.failures).toEqual([]);
      expect(optimized.length - before).toBe(1);
      expect(queued.length - beforeQueue).toBe(3);
      expect(await state(user)).toMatchObject({ balance: 979 });
      expect((await state(user)).holds).toHaveLength(3);
      expect(
        (await query("SELECT id FROM batch_tasks WHERE user_id=$1", [user]))
          .rows,
      ).toHaveLength(1);
      expect(
        (
          await query("SELECT id FROM prompt_compilations WHERE user_id=$1", [
            user,
          ])
        ).rows,
      ).toHaveLength(1);
    } finally {
      gate.release.resolve();
    }
  });

  test("new router closes an expired partial admission after connection loss without replaying LLM, tasks or holds", async () => {
    const user = await actor(),
      foreign = await actor(),
      value = input("persist the first accepted item through API interruption"),
      before = optimized.length,
      beforeQueue = queued.length;
    const gate = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
      crash: true,
    };
    queueGate = gate;
    const pending = request(user, "/api/tasks/batch", value);
    await gate.started.promise;
    gate.release.resolve();
    try {
      expect((await pending).status).toBe(500);
    } finally {
      databaseUnavailable = false;
    }
    const saved = await state(user);
    expect(saved.tasks).toHaveLength(1);
    expect(saved.holds).toHaveLength(1);
    expect(saved.balance).toBe(993);
    expect(
      (
        await query(
          "SELECT admission_status FROM batch_tasks WHERE request_id=$1",
          [value.requestId],
        )
      ).rows[0]!.admission_status,
    ).toBe("admitting");
    // Simulate elapsed durable lease, not a process-local restart sweep or a mock task count.
    await query(
      "UPDATE batch_tasks SET admission_lease_expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",
      [value.requestId],
    );
    const restarted = await startRouter();
    const response = await request(
      user,
      `/api/tasks/batches/by-request/${value.requestId}`,
      undefined,
      restarted,
    );
    expect(response.status).toBe(200);
    const recovered = await response.json();
    expect(recovered.submissionComplete).toBe(true);
    expect(recovered.tasks).toHaveLength(1);
    expect(recovered.tasks[0].id).toBe(saved.tasks[0]!.id);
    expect(
      recovered.failures.map((failure: any) => ({
        index: failure.index,
        code: failure.code,
      })),
    ).toEqual([
      { index: 1, code: "BATCH_SUBMISSION_INTERRUPTED" },
      { index: 2, code: "BATCH_SUBMISSION_INTERRUPTED" },
    ]);
    expect(
      (
        await query(
          "SELECT admission_status FROM batch_tasks WHERE request_id=$1",
          [value.requestId],
        )
      ).rows[0]!.admission_status,
    ).toBe("interrupted");
    expect(
      (
        await query(
          "SELECT status,total_items,completed_items,failed_items FROM batch_tasks WHERE request_id=$1",
          [value.requestId],
        )
      ).rows[0],
    ).toEqual({
      status: "processing",
      total_items: 3,
      completed_items: 0,
      failed_items: 2,
    });
    const repeated = await request(user, "/api/tasks/batch", value, restarted);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(recovered);
    expect(
      (
        await request(
          foreign,
          `/api/tasks/batches/by-request/${value.requestId}`,
          undefined,
          restarted,
        )
      ).status,
    ).toBe(404);
    const collision = await request(
      foreign,
      "/api/tasks/batch",
      value,
      restarted,
    );
    expect(collision.status).toBe(400);
    expect(await collision.json()).toMatchObject({
      error: "DUPLICATE_REQUEST",
    });
    expect(await state(user)).toEqual(saved);
    expect((await state(foreign)).holds).toHaveLength(0);
    expect(optimized.length - before).toBe(1);
    expect(queued.length - beforeQueue).toBe(1);
    // A later worker result must not turn a 1-of-3 admission into a false whole-batch success.
    await query(
      "UPDATE tasks SET status='success',completed_at=now() WHERE id=$1",
      [saved.tasks[0]!.id],
    );
    await recalculateBatch(db, recovered.batchId);
    expect(
      (
        await query(
          "SELECT status,total_items,completed_items,failed_items FROM batch_tasks WHERE id=$1",
          [recovered.batchId],
        )
      ).rows[0],
    ).toEqual({
      status: "partial",
      total_items: 3,
      completed_items: 1,
      failed_items: 2,
    });
  });

  test("expired original admitter is fenced before the next item even when no GET recovery ran", async () => {
    const user = await actor(),
      value = input("expired ownership cannot continue admission"),
      beforeQueue = queued.length;
    const gate = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
      crash: false,
    };
    queueGate = gate;
    const pending = request(user, "/api/tasks/batch", value);
    try {
      await gate.started.promise;
      await query(
        "UPDATE batch_tasks SET admission_lease_expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",
        [value.requestId],
      );
      gate.release.resolve();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "BATCH_SUBMISSION_INTERRUPTED",
      });
      const saved = await state(user);
      expect(saved.tasks).toHaveLength(1);
      expect(saved.holds).toHaveLength(1);
      expect(saved.balance).toBe(993);
      expect(queued.length - beforeQueue).toBe(1);
      const recovered = await (
        await request(user, `/api/tasks/batches/by-request/${value.requestId}`)
      ).json();
      expect(recovered.submissionComplete).toBe(true);
      expect(recovered.failures.map((failure: any) => failure.index)).toEqual([
        1, 2,
      ]);
    } finally {
      gate.release.resolve();
    }
  });

  test("Redis delivery failure after SQL commit preserves tasks and holds and is not replayed by batch POST or GET", async () => {
    const user = await actor(),
      value = input("keep SQL accepted work when Redis fails"),
      before = optimized.length;
    failQueue = true;
    let response: Response;
    try {
      response = await request(user, "/api/tasks/batch", value);
    } finally {
      failQueue = false;
    }
    expect(response!.status).toBe(201);
    const accepted = await response!.json();
    expect(accepted.submissionComplete).toBe(true);
    expect(accepted.tasks).toHaveLength(3);
    expect(accepted.failures).toHaveLength(3);
    expect(
      accepted.tasks.every(
        (task: any) => task.status === "waiting" && task.credits === 7,
      ),
    ).toBe(true);
    const saved = await state(user),
      beforeRecoveryQueue = queued.length;
    expect(saved.balance).toBe(979);
    expect(saved.holds).toHaveLength(3);
    const fresh = await startRouter();
    const get = await request(
      user,
      `/api/tasks/batches/by-request/${value.requestId}`,
      undefined,
      fresh,
    );
    expect(await get.json()).toEqual(accepted);
    expect((await request(user, "/api/tasks/batch", value, fresh)).status).toBe(
      200,
    );
    expect(await state(user)).toEqual(saved);
    expect(optimized.length - before).toBe(1);
    expect(queued.length).toBe(beforeRecoveryQueue);
  });

  test("known quota rejections remain explicit after router restart and never reserve rejected items", async () => {
    const user = await actor(),
      value = input("persist quota rejection details"),
      limited = await startRouter(1);
    const response = await request(user, "/api/tasks/batch", value, limited);
    expect(response.status).toBe(201);
    const accepted = await response.json();
    expect(accepted.submissionComplete).toBe(true);
    expect(accepted.tasks).toHaveLength(1);
    expect(
      accepted.failures.map((failure: any) => ({
        index: failure.index,
        code: failure.code,
      })),
    ).toEqual([
      { index: 1, code: "USER_TASK_LIMIT_REACHED" },
      { index: 2, code: "USER_TASK_LIMIT_REACHED" },
    ]);
    const fresh = await startRouter();
    const get = await request(
      user,
      `/api/tasks/batches/by-request/${value.requestId}`,
      undefined,
      fresh,
    );
    expect(await get.json()).toEqual(accepted);
    const saved = await state(user);
    expect(saved.holds).toHaveLength(1);
    expect(saved.balance).toBe(993);
    expect(
      saved.tasks.filter(
        (task) => task.status === "failed" && task.credits === 0,
      ),
    ).toHaveLength(2);
    expect(
      (
        await query(
          "SELECT failed_items FROM batch_tasks WHERE request_id=$1",
          [value.requestId],
        )
      ).rows[0]!.failed_items,
    ).toBe(2);
  });

  test("legacy closed batch missing items reports terminal interruption instead of permanent pending", async () => {
    const user = await actor(),
      id = randomUUID(),
      requestId = randomUUID(),
      before = optimized.length,
      beforeQueue = queued.length;
    await query(
      "INSERT INTO batch_tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,total_items,tool_key) VALUES($1,$2,$3,'legacy-fixture','batch_image',$4,'legacy prompt',2,'canvas-batch')",
      [id, requestId, user, model],
    );
    const response = await request(
      user,
      `/api/tasks/batches/by-request/${requestId}`,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.submissionComplete).toBe(true);
    expect(result.tasks).toEqual([]);
    expect(
      result.failures.map((failure: any) => ({
        index: failure.index,
        code: failure.code,
      })),
    ).toEqual([
      { index: 0, code: "BATCH_SUBMISSION_INTERRUPTED" },
      { index: 1, code: "BATCH_SUBMISSION_INTERRUPTED" },
    ]);
    expect(
      (
        await query("SELECT status,failed_items FROM batch_tasks WHERE id=$1", [
          id,
        ])
      ).rows[0],
    ).toEqual({ status: "failed", failed_items: 2 });
    const afterRead = (
      await query("SELECT updated_at FROM batch_tasks WHERE id=$1", [id])
    ).rows[0]!.updated_at;
    await request(user, `/api/tasks/batches/by-request/${requestId}`);
    expect(
      (await query("SELECT updated_at FROM batch_tasks WHERE id=$1", [id]))
        .rows[0]!.updated_at,
    ).toEqual(afterRead);
    expect((await state(user)).holds).toEqual([]);
    expect(optimized.length).toBe(before);
    expect(queued.length).toBe(beforeQueue);
  });
});
