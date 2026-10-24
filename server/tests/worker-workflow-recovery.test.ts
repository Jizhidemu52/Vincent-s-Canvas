import { expect, test } from "bun:test";
import ts from "typescript";
import { assertWorkflowTaskContext, workflowTaskContext, WorkflowTaskPending } from "../src/workflow-task-context";
import { normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate } from "../src/workflow-runtime";
import { TaskExecutionLost } from "../src/model-concurrency";
import { VideoSubmissionClaimLost } from "../src/media-runtime";

const source = ts.createSourceFile("worker.ts", await Bun.file(new URL("../src/worker.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true);
const names = ["executeWorkflow", "isImageWorkflowTask", "isBuiltinSingleImageWorkflow", "singleImageWorkflowRequestBody"];
const code = ts.transpileModule(source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""))
  .map(node => node.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function task(overrides: Record<string, unknown> = {}): any {
  return { id: "task", model_config_id: "model", provider_id: "provider", workflow_config_id: "workflow", workflow_id: "flow-1",
    model_id: "model", protocol: "custom", base_url: "https://provider.invalid", submit_path: "/submit", status_path: "/status/{taskId}",
    request_template: { n: 1, prompt: "$prompt" }, external_task_path: "job.id", status_value_path: "state", success_values: ["DONE"],
    failure_values: ["FAILED"], output_path: "outputs", poll_interval_ms: 500, timeout_seconds: 30, operation_type: "image_generation",
    parameters: {}, prompt: "shirt", source_urls: [], user_id: "owner", execution_token: "token",
    upstream_task_id: null, upstream_submission_started_at: null, upstream_workflow_context: null,
    poll_deadline_at: null, ...overrides };
}

function harness(response: (url: string, init?: RequestInit) => Promise<Response>, options: { persist?: boolean } = {}) {
  const calls: string[] = [], statements: Array<{ sql: string; values: unknown[] }> = [];
  const deps = { assertWorkflowTaskContext, workflowTaskContext, WorkflowTaskPending, TaskExecutionLost, VideoSubmissionClaimLost,
    normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate,
    loadSourceAssets: async () => { calls.push("sources"); return []; },
    fetch: async (url: string, init?: RequestInit) => { calls.push(init?.method ?? "GET"); return response(url, init); },
    fetchProviderResult: async (url: string) => { calls.push("result"); return { url }; },
    claimProviderSubmission: async (input: any, context: unknown) => { calls.push("claim"); input.upstream_submission_started_at = new Date().toISOString(); input.upstream_workflow_context = context; },
    assertProviderSubmissionResponse: async (value: Response) => { if (!value.ok) throw new Error(`HTTP ${value.status}`); },
    joinUrl: (base: string, path: string) => base + path,
    db: { query: async (sql: string, values: unknown[]) => {
      calls.push("persist"); statements.push({ sql, values });
      return { rows: options.persist === false ? [] : [{ poll_deadline_at: new Date(Date.now() + 30_000).toISOString() }] };
    } },
  };
  return { calls, statements, execute: new Function(...Object.keys(deps), `${code};return executeWorkflow`)(...Object.values(deps)) as (input: any, credentials: Record<string, string>) => Promise<unknown> };
}

test.each([500, 60_000])("async workflow submission persists the original ID then yields at the configured legal interval %d", async interval => {
  const h = harness(async () => Response.json({ job: { id: "original/job 1" } }));
  const input = task({ poll_interval_ms: interval });
  const error = await h.execute(input, { apiKey: "credential-not-persisted" }).catch(error => error);
  expect(error).toBeInstanceOf(WorkflowTaskPending);
  if (!(error instanceof WorkflowTaskPending)) throw error;
  expect(error.nextPollMs).toBe(interval);
  expect(h.calls).toEqual(["sources", "claim", "POST", "persist"]);
  expect(input.upstream_task_id).toBe("original/job 1");
  expect(h.statements[0]!.sql).toContain("upstream_workflow_context=$4::jsonb");
  expect(h.statements[0]!.sql).toContain("upstream_task_id IS NULL OR upstream_task_id=$1");
  expect(JSON.stringify(h.statements)).not.toContain("credential-not-persisted");
});

test("a fresh invocation only queries the saved ID and does not reload references, claim, POST, or extend its deadline", async () => {
  const input = task({ upstream_task_id: "original/job 1", upstream_submission_started_at: "started", poll_deadline_at: new Date(Date.now() + 30_000).toISOString() });
  input.upstream_workflow_context = workflowTaskContext(input) as any;
  const deadline = input.poll_deadline_at;
  const h = harness(async (url, init) => { expect(url).toBe("https://provider.invalid/status/original%2Fjob%201"); expect(init?.method).toBeUndefined(); return Response.json({ state: "running" }); });
  await expect(h.execute(input, {})).rejects.toBeInstanceOf(WorkflowTaskPending);
  expect(h.calls).toEqual(["GET"]); expect(input.poll_deadline_at).toBe(deadline);
});

test.each([
  ["base_url", "https://different.invalid"], ["provider_id", "other-provider"], ["workflow_config_id", "other-workflow"],
  ["status_path", "/other/{taskId}"], ["output_path", "other"], ["poll_interval_ms", 2_000], ["timeout_seconds", 600],
])("changed %s pauses recovery before any provider or source request", async (key, value) => {
  const input = task({ upstream_task_id: "original", upstream_submission_started_at: "started" });
  input.upstream_workflow_context = workflowTaskContext(input) as any;
  (input as any)[key] = value;
  const h = harness(async () => { throw new Error("must not request"); });
  await expect(h.execute(input, {})).rejects.toThrow("已变更"); expect(h.calls).toEqual([]);
});

test.each(["FAILED", "DONE"])("terminal workflow state %s without outputs retains the existing uncertain-result failure semantics", async state => {
  const input = task({ upstream_task_id: "original", upstream_submission_started_at: "started", poll_deadline_at: new Date(Date.now() + 30_000).toISOString() });
  input.upstream_workflow_context = workflowTaskContext(input) as any;
  const h = harness(async () => Response.json({ state }));
  const error = await h.execute(input, {}).catch(error => error);
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(WorkflowTaskPending);
  expect(h.calls).toEqual(["GET"]);
});

test("synchronous workflows still return their direct output without touching polling state", async () => {
  const h = harness(async () => Response.json({ outputs: ["https://result.invalid/image.png"] }));
  expect(await h.execute(task({ status_path: null, external_task_path: null }), {})).toEqual([{ url: "https://result.invalid/image.png" }]);
  expect(h.calls).toEqual(["sources", "claim", "POST", "result"]);
});

test("an accepted workflow whose original ID cannot be recorded never silently starts polling or another POST", async () => {
  const h = harness(async () => Response.json({ job: { id: "original" } }), { persist: false });
  await expect(h.execute(task(), {})).rejects.toBeInstanceOf(VideoSubmissionClaimLost);
  expect(h.calls.filter(value => value === "POST")).toHaveLength(1); expect(h.calls).not.toContain("GET");
});

test("unknown submission, missing context, and expired deadline cannot create a fresh paid attempt", async () => {
  for (const input of [task({ upstream_submission_started_at: "started" }), task({ upstream_task_id: "legacy-id" }), task({ upstream_task_id: "expired", poll_deadline_at: "2020-01-01" })]) {
    if (input.upstream_task_id === "expired") input.upstream_workflow_context = workflowTaskContext(input) as any;
    const h = harness(async () => { throw new Error("must not request"); });
    await expect(h.execute(input, {})).rejects.toBeInstanceOf(Error); expect(h.calls).toEqual([]);
  }
});

test("protocol context is stable across JSON key order and contains no raw URLs, templates or credentials", () => {
  const input = task({ base_url: "https://provider.invalid/?signed=secret", request_template: { prompt: "$prompt", n: 1, secret: "template-secret" } });
  const saved = workflowTaskContext(input);
  expect(assertWorkflowTaskContext({ ...input, request_template: { secret: "template-secret", n: 1, prompt: "$prompt" } }, saved)).toEqual(saved);
  const serialized = JSON.stringify(saved);
  expect(serialized).not.toContain("secret"); expect(serialized).not.toContain("https://"); expect(serialized).not.toContain("prompt");
});
