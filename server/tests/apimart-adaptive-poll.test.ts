import { expect, test } from "bun:test";
import ts from "typescript";
import { ApiMartImageTaskPending, stepApiMartImageTask } from "../src/apimart-image";
import { stepApiMartVideoTask, VideoTaskPending } from "../src/media-runtime";

const now = Date.parse("2026-10-24T00:00:00.000Z");
const image = { baseUrl: "https://provider.example/v1", apiKey: "fixture-only", modelId: "gpt-image-2.5-flare", prompt: "product", parameters: {}, upstreamTaskId: "original", submissionStarted: true };
const video = { ...image, modelId: "wan2.7", beforeSubmit: async () => { throw new Error("Cannot submit again"); }, onSubmitted: async () => { throw new Error("Cannot replace ID"); } };
const boundaries = [[0, 2_000], [29_999, 2_000], [30_000, 5_000], [119_999, 5_000], [120_000, 10_000], [299_999, 10_000], [300_000, 30_000], [900_000, 30_000]] as const;

for (const [ageMs, expectedMs] of boundaries) test(`pending image/video age ${ageMs}ms schedules ${expectedMs}ms without resubmission`, async () => {
  for (const modelId of ["gpt-image-2.5-flare", "gemini-nano-banana-2.1", "wan2.7"]) {
    const calls: string[] = [];
    const runtime = { now: () => now, sleep: async () => { throw new Error("Worker step cannot sleep on pending"); }, fetch: async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method}:${url}`);
      return Response.json({ data: { status: "processing" } });
    } };
    const started = new Date(now - ageMs).toISOString();
    const result = modelId === "wan2.7"
      ? await stepApiMartVideoTask({ ...video, submissionStartedAt: started }, runtime)
      : await stepApiMartImageTask({ ...image, modelId, submissionStartedAt: started }, runtime);
    expect(result).toEqual({ status: "pending", upstreamTaskId: "original", nextPollMs: modelId === "gemini-nano-banana-2.1" && ageMs < 30_000 ? 3_000 : expectedMs });
    expect(calls).toEqual(["GET:https://provider.example/v1/tasks/original"]);
  }
});

test("missing, invalid or future timestamps retain the model's initial interval", async () => {
  for (const submissionStartedAt of [undefined, null, "not-a-date", new Date(NaN), new Date(now + 100_000).toISOString()]) {
    const runtime = { now: () => now, fetch: async () => Response.json({ data: { status: "pending" } }) };
    expect(await stepApiMartImageTask({ ...image, modelId: "gemini-nano-banana-2.1", submissionStartedAt }, runtime)).toMatchObject({ nextPollMs: 3_000 });
    expect(await stepApiMartVideoTask({ ...video, submissionStartedAt }, runtime)).toMatchObject({ nextPollMs: 2_000 });
  }
});

test("persisted timestamp survives fresh invocations and Date or JSON representations", async () => {
  for (const submissionStartedAt of [new Date(now - 360_000), new Date(now - 360_000).toISOString()]) {
    const runtime = { now: () => now, fetch: async () => Response.json({ data: { status: "processing" } }) };
    const saved = { ...image, submissionStartedAt };
    expect(await stepApiMartImageTask(saved, runtime)).toMatchObject({ nextPollMs: 30_000 });
    expect(await stepApiMartImageTask(JSON.parse(JSON.stringify(saved)), { ...runtime })).toMatchObject({ nextPollMs: 30_000 });
  }
});

test("first successful submission keeps the initial delay even when upload or POST was slow", async () => {
  for (const modelId of ["gpt-image-2.5-flare", "gemini-nano-banana-2.1", "wan2.7"]) {
    let clock = now, posts = 0, persisted = 0;
    const runtime = { now: () => clock, fetch: async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST"); posts++; clock += 360_000;
      return Response.json({ data: [{ task_id: "new-task" }] });
    } };
    const input = { ...image, modelId, upstreamTaskId: null, submissionStarted: false, submissionStartedAt: null,
      beforeSubmit: async () => true, onSubmitted: async () => { persisted++; } };
    const result = modelId === "wan2.7" ? await stepApiMartVideoTask(input, runtime)
      : await stepApiMartImageTask({ ...input, beforeSubmit: async () => {} }, runtime);
    expect(result).toEqual({ status: "pending", upstreamTaskId: "new-task", nextPollMs: modelId === "gemini-nano-banana-2.1" ? 3_000 : 2_000 });
    expect(posts).toBe(1); expect(persisted).toBe(1);
  }
});

const workerFile = await Bun.file(new URL("../src/worker.ts", import.meta.url)).text();
const workerSource = ts.createSourceFile("worker.ts", workerFile, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const workerCode = ts.transpileModule(["executeApiMartImage", "executeApiMartVideo"].map(name => {
  const node = workerSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  return node.getText(workerSource);
}).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

test.each(["image", "video"])("%s worker forwards persisted age on recovery without resetting deadline or ownership", async kind => {
  const requests: string[] = [];
  const dependencies = {
    storage: { configured: true }, ApiMartImageTaskPending, VideoTaskPending,
    db: { query: async () => { throw new Error("A resumed task's valid deadline must not be rewritten"); } },
    loadSourceAssets: async () => { throw new Error("Old references cannot be loaded again"); },
    stepApiMartImageTask: (input: Parameters<typeof stepApiMartImageTask>[0]) => stepApiMartImageTask(input, { now: () => now, fetch: query }),
    stepApiMartVideoTask: (input: Parameters<typeof stepApiMartVideoTask>[0]) => stepApiMartVideoTask(input, { now: () => now, fetch: query }),
  };
  async function query(url: string, init?: RequestInit) { requests.push(`${init?.method}:${url}`); return Response.json({ data: { status: "processing" } }); }
  const task = { id: "persisted-task", execution_token: "first-owner", user_id: "user", base_url: image.baseUrl,
    model_id: kind === "image" ? image.modelId : video.modelId, prompt: "product", parameters: {}, source_urls: [],
    upstream_task_id: "original", upstream_submission_started_at: new Date(now - 360_000).toISOString(),
    started_at: new Date(now).toISOString(), poll_deadline_at: new Date(Date.now() + 20 * 60_000).toISOString(), attempts: 1 };
  const snapshot = { ...task };
  for (const execution_token of ["first-owner", "restarted-owner"]) {
    const execute = new Function(...Object.keys(dependencies), `${workerCode}; return executeApiMart${kind === "image" ? "Image" : "Video"};`)(...Object.values(dependencies));
    await expect(execute({ ...task, execution_token }, { apiKey: "fixture-only" })).rejects.toMatchObject({ nextPollMs: 30_000 });
  }
  const executeLegacy = new Function(...Object.keys(dependencies), `${workerCode}; return executeApiMart${kind === "image" ? "Image" : "Video"};`)(...Object.values(dependencies));
  await expect(executeLegacy({ ...task, upstream_submission_started_at: null, started_at: task.upstream_submission_started_at }, { apiKey: "fixture-only" })).rejects.toMatchObject({ nextPollMs: 30_000 });
  expect(task).toEqual(snapshot);
  expect(requests).toEqual(["GET:https://provider.example/v1/tasks/original", "GET:https://provider.example/v1/tasks/original", "GET:https://provider.example/v1/tasks/original"]);
});
