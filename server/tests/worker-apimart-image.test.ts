import { expect, test } from "bun:test";
import ts from "typescript";
import { assertImageEditMaskSupport, prepareImageEditInput } from "../src/image-edit-input";

const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const assets = ["original.png", "mask.png", "texture.png"].map(filename => ({ filename, bytes, mimeType: "image/png" }));
const file = await Bun.file(new URL("../src/worker.ts", import.meta.url)).text();
const source = ts.createSourceFile("worker.ts", file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "executeApiMartImage")!;
const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const newTask = () => ({ id: "image-task", execution_token: "execution-one", user_id: "owner", model_id: "gpt-image-2.5-flare", base_url: "https://example.test/v1", operation_type: "inpaint",
  prompt: "edit", parameters: { inputArchive: { maskReferenceIndex: 1 }, quality: "xhigh", resolution: "4k" }, source_urls: ["original", "mask", "texture"], upstream_task_id: null as string | null, upstream_submission_started_at: null as string | null });

function harness(claim = true) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const calls: Record<string, any>[] = [];
  let loaded = 0;
  const dependencies = {
    loadSourceAssets: async () => { loaded++; return assets; }, prepareImageEditInput,
    db: { query: async (sql: string, values: unknown[]) => { statements.push({ sql, values }); return { rows: claim ? [{ id: "image-task" }] : [] }; } },
    VideoSubmissionClaimLost: class extends Error {},
    runApiMartImageTask: async (input: Record<string, any>) => {
      calls.push(input);
      if (!input.upstreamTaskId) {
        if (input.submissionStarted) throw new Error("unknown submission; do not replay");
        await input.beforeSubmit();
        await input.onSubmitted("provider-image-task");
        // Persistence must finish before polling starts.
        expect(statements.at(-1)?.values).toEqual(["provider-image-task", "image-task"]);
      }
      return ["https://example.test/result-1.png", "https://example.test/result-2.png"];
    },
    downloadApiMartImageResult: async (url: string, timeoutMs: number) => { expect(timeoutMs).toBe(60_000); return { url, bytes, mimeType: "image/png" }; },
  };
  const execute = new Function(...Object.keys(dependencies), `${code};return executeApiMartImage`)(...Object.values(dependencies));
  return { execute, statements, calls, loaded: () => loaded };
}

test("Worker isolates PNG mask and persists Mark upstream ID before polling; all result URLs are materialized", async () => {
  const h = harness(), task = newTask();
  const results = await h.execute(task, { apiKey: "fixture-only" });
  expect(h.loaded()).toBe(1);
  expect(h.calls[0]!.sourceDataUrls).toHaveLength(2);
  expect(h.calls[0]!.maskDataUrl).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  expect(h.calls[0]!.parameters).toMatchObject({ quality: "xhigh", resolution: "4k" });
  expect(task.upstream_task_id).toBe("provider-image-task");
  expect(task.upstream_submission_started_at).not.toBeNull();
  expect(results).toHaveLength(2);
  expect(h.statements[0]!.sql).toContain("upstream_submission_started_at IS NULL");
  expect(h.statements[0]!.sql).toContain("execution_token=$2");
  expect(h.statements[0]!.sql).toContain("lease_expires_at>now()");
  expect(h.statements[0]!.values).toEqual(["image-task", "execution-one"]);
});

test("Worker resumes original upstream image without loading or uploading reference assets again", async () => {
  const h = harness(), task = { ...newTask(), upstream_task_id: "existing-task", upstream_submission_started_at: "started" };
  expect(await h.execute(task, { apiKey: "fixture-only" })).toHaveLength(2);
  expect(h.loaded()).toBe(0);
  expect(h.statements).toHaveLength(0);
  expect(h.calls[0]!.upstreamTaskId).toBe("existing-task");
  expect(h.calls[0]!.sourceDataUrls).toHaveLength(0);
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
