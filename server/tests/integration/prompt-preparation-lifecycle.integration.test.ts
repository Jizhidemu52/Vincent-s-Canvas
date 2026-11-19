import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PromptCompilationRequest } from "../../../shared/prompt-contracts";
import { PromptCompiler, type PromptCompilerRuntime, type PromptOptimizer } from "../../src/prompt-compiler";
import { postgresPromptRecipeStore } from "../../src/prompt-recipe-postgres";
import { PromptRecipeStore, publicPromptCompilation, type CompilationClaim } from "../../src/prompt-recipe-store";
import { preparePromptTaskInput } from "../../src/prompt-task-input";
import { conversationDatabaseMode, createConversationPostgres } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() === "postgres" ? describe : describe.skip;
const good = JSON.stringify({ prompt: "A blue linen shirt on a clean white background.", avoid: [], keep_text: [] });
const deferred = <T>() => Promise.withResolvers<T>();

integration("prompt preparation terminal outcomes over native PostgreSQL 17", () => {
  let fixture: Awaited<ReturnType<typeof createConversationPostgres>>;
  let store: PromptRecipeStore;
  let now = Date.parse("2026-11-19T00:00:00.000Z");
  let versionId: string;

  beforeAll(async () => {
    fixture = await createConversationPostgres();
    expect(fixture.backend).toBe("postgres");
    store = new PromptRecipeStore(postgresPromptRecipeStore(fixture.db).database, () => new Date(now));
    await store.ensure("text-to-style", { name: "Preparation fixture", enabled: true, modelConfigId: "optimizer", failurePolicy: "fallback" });
    const version = await store.saveVersion("text-to-style", {
      systemPrompt: "Return the final visual description as strict JSON.", fieldTemplate: "", modelOverrides: {},
      fallbackPrompt: "A plain blue shirt.", outputLanguage: "en", changeNote: "Native database fixture",
    }, "fixture-admin");
    versionId = version.id;
    await store.activate("text-to-style", versionId);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];

  function request(): PromptCompilationRequest {
    return { requestId: randomUUID(), modelConfigId: "target", toolKey: "image", sourceUrls: [],
      promptInput: { scene: "text-to-style", fields: {}, userText: "A blue linen shirt", mode: "generate", hasMask: false, referenceRoles: [] } };
  }
  function claimInput(): CompilationClaim {
    const input = request();
    return { userId: randomUUID(), requestId: input.requestId, inputHash: randomUUID(), recipeKey: "text-to-style", recipeVersionId: versionId,
      details: { modelConfigId: "optimizer", targetModelConfigId: "target", inputSnapshot: { promptInput: input.promptInput, sourceUrls: [] },
        optimized: false, rawResponse: null, latencyMs: null, inputTokens: null, outputTokens: null, actualCost: null,
        estimatedCost: null, currency: "CNY", completedAt: null } };
  }
  function compilerFixture(invoke: PromptOptimizer["invoke"]) {
    const calls: string[] = [];
    const runtime: PromptCompilerRuntime = {
      resolveTarget: async () => ({ id: "target", modelId: "gpt-image-2", protocol: "openai", fingerprint: "target" }),
      resolveOptimizer: async () => ({ id: "optimizer", modelId: "optimizer", fingerprint: "optimizer", estimatedRmbCost: null,
        invoke: async (...args) => { calls.push(args[2].compilationId); return invoke(...args); } }),
      readSource: async () => { throw new Error("No source read expected"); },
    };
    return { compiler: new PromptCompiler(store, runtime), calls, actor: { id: randomUUID(), role: "designer", departmentId: null } };
  }

  test("expired preparation becomes a persisted failure and its alias cannot revive after late success", async () => {
    const input = claimInput(), started = now, claimed = await store.claim(input);
    const alias = await store.claim({ ...input, requestId: randomUUID() });
    now = started + 200_000;
    expect((await store.getCompilation(claimed.id))?.status).toBe("optimizing");
    now++;
    expect(await store.getCompilation(alias.id)).toMatchObject({ status: "failed", errorCode: "PROMPT_PREPARATION_TIMEOUT", upstreamOutcome: "unknown" });
    expect(await row("SELECT status,details->>'errorCode' code FROM prompt_compilations WHERE id=$1", [claimed.id]))
      .toEqual({ status: "failed", code: "PROMPT_PREPARATION_TIMEOUT" });
    await store.finish(claimed.id, "success", { prompt: "Late success must not start an image", optimized: true });
    const original = (await store.byRequest(input.userId, input.requestId))!;
    expect(original).toMatchObject({ status: "failed", optimized: false, errorCode: "PROMPT_PREPARATION_TIMEOUT" });
    expect(publicPromptCompilation(original)).not.toHaveProperty("upstreamOutcome");
    expect(await row("SELECT count(*)::int n FROM tasks")).toEqual({ n: 0 });
  });

  test("a result arriving after the deadline fails even when no observer polled first", async () => {
    const input = claimInput(), claimed = await store.claim(input);
    now += 200_001;
    await store.finish(claimed.id, "success", { prompt: "Too late", optimized: true });
    expect(await store.getCompilation(claimed.id)).toMatchObject({ status: "failed", errorCode: "PROMPT_PREPARATION_TIMEOUT" });
    expect(await row("SELECT status FROM prompt_compilations WHERE id=$1", [claimed.id])).toEqual({ status: "failed" });
  });

  test("a new request does not inherit expired preparation but the original request remains idempotent", async () => {
    const input = claimInput(), original = await store.claim(input);
    now += 200_001;
    const next = await store.claim({ ...input, requestId: randomUUID() });
    expect(next).toMatchObject({ execute: true });
    expect(next.id).not.toBe(original.id);
    expect(await store.getCompilation(next.id)).toMatchObject({ status: "optimizing", reusedFromId: null });
    expect(await store.claim(input)).toEqual({ id: original.id, execute: false });
    expect(await store.getCompilation(original.id)).toMatchObject({ status: "failed", errorCode: "PROMPT_PREPARATION_TIMEOUT" });
  });

  test("legacy uncertain records are publicly preparation failures without rewriting their stored evidence or reusing them", async () => {
    const input = claimInput(), original = await store.claim(input);
    await store.finish(original.id, "uncertain", { errorCode: "PROMPT_SUBMISSION_UNCERTAIN", message: "Legacy optimizer unknown" });
    const previous = await row("SELECT status,details FROM prompt_compilations WHERE id=$1", [original.id]);
    expect(await store.getCompilation(original.id)).toMatchObject({ status: "failed", errorCode: "PROMPT_PREPARATION_FAILED", upstreamOutcome: "unknown" });
    expect(await row("SELECT status,details FROM prompt_compilations WHERE id=$1", [original.id])).toEqual(previous);
    expect((await store.claim({ ...input, requestId: randomUUID() })).execute).toBe(true);
    expect(await store.claim(input)).toEqual({ id: original.id, execute: false });
  });

  test("unconfirmed optimizer calls fail preparation without fallback; only a new explicit request can invoke again", async () => {
    let attempt = 0;
    const f = compilerFixture(async () => { if (++attempt === 1) throw new TypeError("fixture lost transport"); return { content: good }; });
    const input = request(), first = await f.compiler.compile(f.actor, input);
    expect(first).toMatchObject({ status: "failed", optimized: false, errorCode: "PROMPT_PREPARATION_FAILED", upstreamOutcome: "unknown" });
    expect(first.prompt).toBeUndefined();
    expect((await f.compiler.compile(f.actor, input)).id).toBe(first.id);
    expect(f.calls).toHaveLength(1);
    const next = await f.compiler.compile(f.actor, { ...input, requestId: randomUUID() });
    expect(next).toMatchObject({ status: "success", cacheHit: false, optimized: true });
    expect(next.id).not.toBe(first.id);
    expect(f.calls).toHaveLength(2);
    expect(await f.compiler.compile(f.actor, input)).toMatchObject({ id: first.id, status: "failed" });
    expect(f.calls).toHaveLength(2);
    expect(publicPromptCompilation(next)).not.toHaveProperty("upstreamOutcome");
    expect(await row("SELECT count(*)::int n FROM tasks")).toEqual({ n: 0 });
  });

  test("a pending optimizer reply cannot authorize task preparation after timeout is persisted", async () => {
    const called = deferred<void>(), reply = deferred<{ content: string }>();
    const f = compilerFixture(async () => { called.resolve(); return reply.promise; });
    const input = request();
    const pending = preparePromptTaskInput(f.compiler, f.actor, { ...input, operationType: "image_generation", prompt: input.promptInput.userText, parameters: {} })
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await called.promise;
      now += 200_001;
      expect(await store.byRequest(f.actor.id, input.requestId)).toMatchObject({ status: "failed", errorCode: "PROMPT_PREPARATION_TIMEOUT" });
      reply.resolve({ content: good });
      const result = await pending;
      expect(result.value).toBeNull();
      expect(result.error).toMatchObject({ status: 422, code: "PROMPT_PREPARATION_TIMEOUT" });
      expect(f.calls).toHaveLength(1);
      expect(await row("SELECT count(*)::int n FROM tasks")).toEqual({ n: 0 });
    } finally { reply.resolve({ content: good }); await pending; }
  });

  test("claim, expiry and finish preserve native lock order without reviving an expired preparation", async () => {
    const input = claimInput(), original = await store.claim(input), nextRequestId = randomUUID(), blocker = await fixture.db.connect();
    let operations: Promise<unknown[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`prompt-result:${original.id}`]);
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      now += 200_001;
      operations = Promise.all([
        store.finish(original.id, "success", { prompt: "Cannot win after expiry", optimized: true }),
        store.getCompilation(original.id),
        store.claim({ ...input, requestId: nextRequestId }),
      ]);
      const deadline = Date.now() + 2_000;
      let blocked = 0;
      while (Date.now() < deadline) {
        blocked = (await fixture.db.query<{ n: number }>(`SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1
          AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))`, [fixture.schema, pid])).rows[0]!.n;
        if (blocked >= 3) break;
        await Bun.sleep(10);
      }
      expect(blocked).toBe(3);
      expect((await fixture.db.query<{ held: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid
        WHERE activity.application_name=$1 AND lock.locktype='advisory' AND lock.granted
          AND lock.objid=(hashtext($2)::bigint & 4294967295)::oid
          AND activity.wait_event_type='Lock' AND $3=ANY(pg_blocking_pids(activity.pid))
      ) AS held`, [fixture.schema, `prompt-compile:${input.userId}:${input.inputHash}`, pid])).rows[0]!.held).toBe(true);
      await blocker.query("COMMIT");
      await operations;
      expect(await store.getCompilation(original.id)).toMatchObject({ status: "failed", optimized: false, errorCode: "PROMPT_PREPARATION_TIMEOUT" });
      const next = await store.byRequest(input.userId, nextRequestId);
      expect(next).toMatchObject({ status: "optimizing", reusedFromId: null, cacheHit: false });
      expect(next?.id).not.toBe(original.id);
      expect(await store.claim({ ...input, requestId: nextRequestId })).toEqual({ id: next!.id, execute: false });
      expect(await row("SELECT count(*)::int n FROM prompt_compilations WHERE user_id=$1 AND reused_from_id IS NULL", [input.userId])).toEqual({ n: 2 });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await operations;
    }
  }, 10_000);

  test("a success committed before expiry and a confirmed failure are both immutable", async () => {
    const success = await store.claim(claimInput()), failure = await store.claim(claimInput());
    await store.finish(success.id, "success", { prompt: "On time", optimized: true });
    await store.finish(failure.id, "failed", { errorCode: "PROMPT_OUTPUT_REJECTED", message: "Invalid output" });
    now += 200_001;
    await Promise.all([store.finish(success.id, "failed", { errorCode: "LATE_FAILURE" }), store.finish(failure.id, "success", { prompt: "Late", optimized: true })]);
    expect(await store.getCompilation(success.id)).toMatchObject({ status: "success", prompt: "On time", optimized: true });
    expect(await store.getCompilation(failure.id)).toMatchObject({ status: "failed", errorCode: "PROMPT_OUTPUT_REJECTED" });
  });
});
