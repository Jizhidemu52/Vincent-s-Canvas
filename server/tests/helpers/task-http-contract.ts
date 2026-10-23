import assert from "node:assert/strict";
import { taskResponseSchema, taskSubmissionSchema } from "../../../shared/task-contracts";

/** Pure shared helper: importing it never registers or launches another test. */
export async function verifyTaskHttpContract(input: {
  base: string;
  headers?: HeadersInit;
  submission: Record<string, unknown>;
  expected: { id?: string; requestId: string; status: string };
}) {
  const headers = new Headers(input.headers); headers.set("content-type", "application/json");
  const post = (body: unknown) => fetch(`${input.base}/api/tasks`, { method: "POST", headers, body: JSON.stringify(body) });
  for (const malformed of [null, {}, { ...input.submission, requestId: "x" }, { ...input.submission, modelConfigId: "not-a-uuid" },
    { ...input.submission, sourceUrls: [null] }, { ...input.submission, parameters: null },
    { ...input.submission, priority: "highest" }, { ...input.submission, prompt: "a".repeat(20_001) }]) {
    assert.equal(taskSubmissionSchema.safeParse(malformed).success, false);
    const response = await post(malformed);
    const diagnostic = await response.text();
    assert.equal(response.status, 400, `Malformed task submission returned ${response.status}: ${diagnostic.slice(0, 500)}`);
  }
  assert.equal(taskSubmissionSchema.safeParse(input.submission).success, true);
  const response = await post(input.submission);
  assert.ok(response.status >= 200 && response.status < 300, `Valid task submission returned ${response.status}: ${(await response.clone().text()).slice(0, 500)}`);
  const result = taskResponseSchema.parse(await response.json());
  for (const [key, value] of Object.entries(input.expected)) assert.equal(result.task[key], value);
  const read = await fetch(`${input.base}/api/tasks/${result.task.id}`, { headers: input.headers });
  assert.equal(read.status, 200);
  const restored = taskResponseSchema.parse(await read.json());
  for (const [key, value] of Object.entries(input.expected)) assert.equal(restored.task[key], value);
  return result.task;
}
