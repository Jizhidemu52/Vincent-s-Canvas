import { expect, test } from "bun:test";
import ts from "typescript";
import { assertImageEditMaskSupport, prepareImageEditInput } from "../src/image-edit-input";
import { ApiMartImageQueryRetryable, ApiMartImageTaskPending } from "../src/apimart-image";
import { validateQuickImageSource } from "../src/image-result-processing";
import { prepareQuickImageTask } from "../src/quick-image-tools";

const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const assets = ["original.png", "mask.png", "texture.png"].map(filename => ({ filename, bytes, mimeType: "image/png" }));
const file = await Bun.file(new URL("../src/worker.ts", import.meta.url)).text();
const source = ts.createSourceFile("worker.ts", file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "executeApiMartImage")!;
const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const newTask = () => ({ id: "image-task", execution_token: "execution-one", user_id: "owner", model_id: "gpt-image-2.5-flare", base_url: "https://example.test/v1", operation_type: "inpaint",
  prompt: "edit", parameters: { inputArchive: { maskReferenceIndex: 1 }, quality: "xhigh", resolution: "4k" }, source_urls: ["original", "mask", "texture"], upstream_task_id: null as string | null, upstream_submission_started_at: null as string | null,
  poll_deadline_at: null as string | null });

function harness(claim = true, failQuery?: () => unknown, sourceAssets = assets) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const calls: Record<string, any>[] = [];
  let loaded = 0;
  let downloaded = 0;
  const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
  const dependencies = {
    loadSourceAssets: async () => { loaded++; return sourceAssets; }, prepareImageEditInput, validateQuickImageSource,
    db: { query: async (sql: string, values: unknown[]) => { statements.push({ sql, values }); return { rows: claim ? [{ id: "image-task", poll_deadline_at: deadline }] : [] }; } },
    VideoSubmissionClaimLost: class extends Error {}, ApiMartImageTaskPending, ApiMartImageQueryRetryable,
    stepApiMartImageTask: async (input: Record<string, any>) => {
      calls.push(input);
      if (!input.upstreamTaskId) {
        if (input.submissionStarted) throw new Error("unknown submission; do not replay");
        await input.beforeSubmit();
        await input.onSubmitted("provider-image-task");
        // Persistence must finish before polling starts.
        expect(statements.at(-1)?.values).toEqual(["provider-image-task", "image-task"]);
        return { status: "pending", upstreamTaskId: "provider-image-task", nextPollMs: 3_000 };
      }
      if (failQuery) throw failQuery();
      return { status: "completed", upstreamTaskId: input.upstreamTaskId, urls: ["https://example.test/result-1.png", "https://example.test/result-2.png"] };
    },
    fetchProviderResult: async (url: string) => { downloaded++; return { url, bytes, mimeType: "image/png" }; },
  };
  const executeApiMartImage = new Function(...Object.keys(dependencies), `${code};return executeApiMartImage`)(...Object.values(dependencies));
  const execute = (input: { prompt: string }, credentials: Record<string, string>) => executeApiMartImage(input, credentials, input.prompt);
  return { execute, statements, calls, deadline, loaded: () => loaded, downloaded: () => downloaded };
}

test("Worker isolates PNG mask, persists Mark upstream ID and deadline, then yields without downloading", async () => {
  const h = harness(), task = newTask();
  await expect(h.execute(task, { apiKey: "fixture-only" })).rejects.toMatchObject({ nextPollMs: 3_000 });
  expect(h.loaded()).toBe(1);
  expect(h.calls[0]!.sourceImages).toHaveLength(2);
  expect(h.calls[0]!.sourceImages[0].bytes).toBe(bytes);
  expect(h.calls[0]!.maskImage.bytes).toBe(bytes);
  expect(h.calls[0]!.sourceDataUrls).toBeUndefined();
  expect(h.calls[0]!.parameters).toMatchObject({ quality: "xhigh", resolution: "4k" });
  expect(h.calls[0]!.prompt).toBe(task.prompt);
  expect(task.upstream_task_id).toBe("provider-image-task");
  expect(task.upstream_submission_started_at).not.toBeNull();
  expect(h.downloaded()).toBe(0);
  expect(h.statements[0]!.sql).toContain("upstream_submission_started_at IS NULL");
  expect(h.statements[0]!.sql).toContain("execution_token=$2");
  expect(h.statements[0]!.sql).toContain("lease_expires_at>now()");
  expect(h.statements[0]!.values).toEqual(["image-task", "execution-one"]);
  expect(h.statements[1]!.sql).toContain("poll_deadline_at=COALESCE(poll_deadline_at,now()+interval '15 minutes')");
});

test("quick image validates original bytes before the single submission and recovers by the same upstream ID", async () => {
  const prepared = prepareQuickImageTask({ operationType: "inpaint", toolKey: "canvas-edit", prompt: "", sourceUrls: ["owned-image"], parameters: { quickImageAction: "remove-background" } as Record<string, unknown> });
  const task = { ...newTask(), model_id: "mai-image-2.6-flash", prompt: prepared.prompt!, parameters: prepared.parameters!, source_urls: prepared.sourceUrls };
  const valid = harness(true, undefined, [assets[0]!]);
  await expect(valid.execute(task, { apiKey: "fixture-only" })).rejects.toMatchObject({ nextPollMs: 3_000 });
  expect(valid.calls).toHaveLength(1); expect(valid.calls[0]!.sourceImages).toHaveLength(1);
  expect(valid.calls[0]!.parameters).toMatchObject({ quickImageAction: "remove-background", n: 1 });
  expect(valid.calls[0]!.parameters).not.toHaveProperty("size"); expect(valid.calls[0]!.parameters).not.toHaveProperty("resolution");
  const loadedOnce = valid.loaded();
  expect(await valid.execute(task, { apiKey: "fixture-only" })).toHaveLength(2);
  expect(valid.loaded()).toBe(loadedOnce); expect(valid.calls[1]!.upstreamTaskId).toBe("provider-image-task");
  const invalid = harness(true, undefined, [{ filename: "broken.png", mimeType: "image/png", bytes: Buffer.from("broken") }]);
  const invalidTask = { ...task, upstream_task_id: null, upstream_submission_started_at: null };
  await expect(invalid.execute(invalidTask, { apiKey: "fixture-only" })).rejects.toThrow();
  expect(invalid.calls).toHaveLength(0); expect(invalid.statements).toHaveLength(0);
});

test("Worker resumes original upstream image without loading or uploading reference assets again", async () => {
  const h = harness(), task = { ...newTask(), upstream_task_id: "existing-task", upstream_submission_started_at: "started", poll_deadline_at: h.deadline };
  expect(await h.execute(task, { apiKey: "fixture-only" })).toHaveLength(2);
  expect(h.loaded()).toBe(0);
  expect(h.statements).toHaveLength(0);
  expect(h.calls[0]!.upstreamTaskId).toBe("existing-task");
  expect(h.calls[0]!.pollDeadlineAt).toBe(h.deadline);
  expect(h.calls[0]!.sourceImages).toHaveLength(0);
  expect(h.downloaded()).toBe(2);
});

test("Worker backfills a pre-upgrade image polling deadline once without reloading its sources", async () => {
  const h = harness(), task = { ...newTask(), upstream_task_id: "existing-task", upstream_submission_started_at: "started" };
  expect(await h.execute(task, { apiKey: "fixture-only" })).toHaveLength(2);
  expect(task.poll_deadline_at).toBe(h.deadline);
  expect(h.statements).toHaveLength(1);
  expect(h.statements[0]!.sql).toContain("poll_deadline_at=COALESCE");
  expect(h.statements[0]!.sql).toContain("execution_token=$2");
  expect(h.loaded()).toBe(0);
  expect(await h.execute(task, { apiKey: "fixture-only" })).toHaveLength(2);
  expect(h.statements).toHaveLength(1);
});

test("Worker expires an existing image polling deadline without any provider request", async () => {
  const h = harness(), task = { ...newTask(), upstream_task_id: "existing-task", upstream_submission_started_at: "started", poll_deadline_at: new Date(Date.now() - 1).toISOString() };
  await expect(h.execute(task, { apiKey: "fixture-only" })).rejects.toThrow("状态查询超时");
  expect(h.calls).toHaveLength(0);
  expect(h.statements).toHaveLength(0);
  expect(h.loaded()).toBe(0);
});

test("Worker defers an inconclusive original-ID query only within its unchanged deadline", async () => {
  const h = harness(true, () => new ApiMartImageQueryRetryable("unknown", "PROVIDER_STATUS_INVALID", 30_000));
  const deadline = new Date(Date.now() + 5_000).toISOString();
  const task = { ...newTask(), upstream_task_id: "existing-task", upstream_submission_started_at: "started", poll_deadline_at: deadline };
  let caught: unknown;
  try { await h.execute(task, { apiKey: "fixture-only" }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ApiMartImageTaskPending);
  expect((caught as ApiMartImageTaskPending).nextPollMs).toBeGreaterThan(0);
  expect((caught as ApiMartImageTaskPending).nextPollMs).toBeLessThanOrEqual(5_000);
  expect((caught as ApiMartImageTaskPending).queryFailure).toEqual({ code: "PROVIDER_STATUS_INVALID", httpStatus: undefined });
  expect(task.poll_deadline_at).toBe(deadline);
  expect(h.statements).toHaveLength(0);
  expect(h.loaded()).toBe(0);
  expect(h.downloaded()).toBe(0);
});

test("Worker stops retrying if an original-ID query exhausts its deadline", async () => {
  const task = { ...newTask(), upstream_task_id: "existing-task", upstream_submission_started_at: "started", poll_deadline_at: new Date(Date.now() + 60_000).toISOString() };
  const h = harness(true, () => {
    task.poll_deadline_at = new Date(Date.now() - 1).toISOString();
    return new ApiMartImageQueryRetryable("network interrupted", "PROVIDER_POLL_NETWORK_ERROR", 10_000);
  });
  await expect(h.execute(task, { apiKey: "fixture-only" })).rejects.toThrow("状态查询超时");
  expect(h.calls).toHaveLength(1);
  expect(h.statements).toHaveLength(0);
});

test("Worker does not turn a permanent original-ID query error into automatic retries", async () => {
  const failure = Object.assign(new Error("Task not found or has expired."), { code: "PROVIDER_POLL_HTTP_ERROR", httpStatus: 400 });
  const h = harness(true, () => failure);
  const task = { ...newTask(), upstream_task_id: "existing-task", upstream_submission_started_at: "started", poll_deadline_at: h.deadline };
  await expect(h.execute(task, { apiKey: "fixture-only" })).rejects.toBe(failure);
  expect(h.calls).toHaveLength(1);
  expect(h.statements).toHaveLength(0);
});

test("Worker does not replay image submissions whose upstream ID is still unknown", async () => {
  const h = harness(), task = { ...newTask(), upstream_submission_started_at: "started" };
  await expect(h.execute(task, { apiKey: "fixture-only" })).rejects.toThrow("do not replay");
  expect(h.loaded()).toBe(0);
  expect(h.statements).toHaveLength(0);
});

test("lost task submission claim stops before recording a new upstream task", async () => {
  const h = harness(false);
  await expect(h.execute(newTask(), { apiKey: "fixture-only" })).rejects.toThrow();
  expect(h.statements).toHaveLength(1);
});

test("both Mark GPT2.5 variants support archived masks, Nano2.1 and old APIMart GPT2 do not", () => {
  for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    expect(() => assertImageEditMaskSupport(newTask().parameters, { protocol: "apimart", modelId, operationType: "inpaint" }, 3)).not.toThrow();
  }
  for (const modelId of ["gemini-nano-banana-2.1", "gpt-image-2"]) {
    expect(() => assertImageEditMaskSupport(newTask().parameters, { protocol: "apimart", modelId, operationType: "inpaint" }, 3)).toThrow("蒙版");
  }
});
