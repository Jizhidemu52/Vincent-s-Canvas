import { expect, test } from "bun:test";
import { ApiMartImageProviderFailure, ApiMartImageQueryRetryable, runApiMartImageTask, stepApiMartImageTask } from "../src/apimart-image";

const input = {
  baseUrl: "https://provider.example/v1", apiKey: "fixture-only", modelId: "gpt-image-2.5-flare",
  prompt: "A product photograph", parameters: {},
};
const completed = { data: { status: "completed", result: { images: [{ url: ["https://images.example/one.png", "https://images.example/two.png"] }] } } };

test("image step submits and persists once, then returns without polling or sleeping", async () => {
  const events: string[] = [];
  const result = await stepApiMartImageTask({ ...input,
    beforeSubmit: async () => { events.push("claim"); },
    onSubmitted: async id => { events.push(`persist:${id}`); },
  }, { sleep: async () => { throw new Error("Submission step must not wait for generation"); }, fetch: async (url, init) => {
    events.push(init?.method || "GET");
    expect(url).toBe("https://provider.example/v1/images/generations");
    expect(init?.method).toBe("POST");
    return Response.json({ data: [{ task_id: "saved-task" }] });
  } });
  expect(result).toEqual({ status: "pending", upstreamTaskId: "saved-task", nextPollMs: 2_000 });
  expect(events).toEqual(["claim", "POST", "persist:saved-task"]);
});

test("image polling step queries only the original ID and ignores unavailable old references", async () => {
  const requests: string[] = [];
  const result = await stepApiMartImageTask({ ...input, upstreamTaskId: "saved/id", submissionStarted: true,
    sourceDataUrls: ["expired-reference"], parameters: { quality: "no-longer-valid" },
    beforeSubmit: () => { throw new Error("Cannot claim again"); }, onSubmitted: () => { throw new Error("Cannot replace ID"); },
  }, { sleep: async () => { throw new Error("Healthy polling step must not sleep"); }, fetch: async (url, init) => {
    requests.push(`${init?.method}:${url}`);
    return Response.json(completed);
  } });
  expect(result).toEqual({ status: "completed", upstreamTaskId: "saved/id", urls: ["https://images.example/one.png", "https://images.example/two.png"] });
  expect(requests).toEqual(["GET:https://provider.example/v1/tasks/saved%2Fid"]);
});

test.each(["pending", "submitted", "processing", "queued", "running"])("image status %s returns one delayed step without leaking unfinished outputs", async status => {
  let queries = 0;
  const result = await stepApiMartImageTask({ ...input, modelId: "gemini-nano-banana-2.1", upstreamTaskId: "saved" }, {
    fetch: async () => { queries++; return Response.json({ data: { ...completed.data, status } }); },
    sleep: async () => { throw new Error("Pending result must be deferred by caller"); },
  });
  expect(result).toEqual({ status: "pending", upstreamTaskId: "saved", nextPollMs: 3_000 });
  expect(queries).toBe(1);
});

test("image step keeps unknown submissions and failed persistence from creating another POST", async () => {
  let requests = 0;
  const runtime = { fetch: async () => { requests++; return Response.json({ data: [{ task_id: "saved" }] }); } };
  await expect(stepApiMartImageTask({ ...input, submissionStarted: true }, runtime)).rejects.toThrow("不会自动重新提交");
  expect(requests).toBe(0);
  await expect(stepApiMartImageTask({ ...input, onSubmitted: () => { throw new Error("Persistence unavailable"); } }, runtime)).rejects.toThrow("Persistence unavailable");
  expect(requests).toBe(1);
});

test("image step distinguishes definitive provider failure from an ambiguous result", async () => {
  await expect(stepApiMartImageTask({ ...input, upstreamTaskId: "saved" }, {
    fetch: async () => Response.json({ data: { ...completed.data, status: "failed" } }),
  })).rejects.toBeInstanceOf(ApiMartImageProviderFailure);
  await expect(stepApiMartImageTask({ ...input, upstreamTaskId: "saved" }, {
    fetch: async () => Response.json({ data: { status: "completed", result: { images: [] } } }),
  })).rejects.toMatchObject({ code: "PROVIDER_RESULT_MISSING" });
});

test.each(["unknown", "missing-status", "invalid-json", "missing-results"])("inconclusive %s image query can later complete by the same GET-only task", async mode => {
  const requests: string[] = [];
  const now = Date.now();
  const original = { ...input, upstreamTaskId: "original", submissionStarted: true,
    submissionStartedAt: new Date(now - 360_000).toISOString(), pollDeadlineAt: new Date(now + 60_000).toISOString(),
    beforeSubmit: () => { throw new Error("Cannot claim another generation"); },
    onSubmitted: () => { throw new Error("Cannot replace the original ID"); },
  };
  const runtime = { now: () => now, sleep: async () => { throw new Error("Durable polling must yield, not sleep"); }, fetch: async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method}:${url}`);
    if (requests.length > 1) return Response.json(completed);
    if (mode === "invalid-json") return new Response("upstream temporarily unavailable");
    return Response.json({ data: mode === "missing-status" ? {} : { status: mode === "missing-results" ? "completed" : "unknown" } });
  } };
  const error = await stepApiMartImageTask(original, runtime).catch(error => error);
  expect(error).toBeInstanceOf(ApiMartImageQueryRetryable);
  expect(error.nextPollMs).toBe(30_000);
  expect(await stepApiMartImageTask(original, runtime)).toMatchObject({ status: "completed", upstreamTaskId: "original" });
  expect(requests).toEqual(["GET:https://provider.example/v1/tasks/original", "GET:https://provider.example/v1/tasks/original"]);
});

test.each(["network", 408, 429, 500, 503])("durable image query %s yields after one GET and uses bounded retry cadence", async failure => {
  let requests = 0;
  const now = Date.now();
  const error = await stepApiMartImageTask({ ...input, upstreamTaskId: "original", submissionStarted: true,
    submissionStartedAt: new Date(now).toISOString(), pollDeadlineAt: new Date(now + 60_000).toISOString(),
  }, { now: () => now, sleep: async () => { throw new Error("No nested retry loop"); }, fetch: async (_url, init) => {
    requests++;
    expect(init?.method).toBe("GET");
    if (failure === "network") throw new TypeError("fixture-only credential must not leak");
    return Response.json({ error: { message: "temporary service failure" } }, { status: failure });
  } }).catch(error => error);
  expect(error).toBeInstanceOf(ApiMartImageQueryRetryable);
  expect(error.nextPollMs).toBe(10_000);
  expect(error.message).not.toContain(input.apiKey);
  expect(requests).toBe(1);
});

test.each([400, 401, 403, 404, 422])("permanent image status HTTP %s is not retried or classified as a terminal generation failure", async status => {
  let requests = 0;
  const error = await stepApiMartImageTask({ ...input, upstreamTaskId: "original", submissionStarted: true,
    pollDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }, { sleep: async () => { throw new Error("Cannot retry a permanent query failure"); }, fetch: async (_url, init) => {
    requests++;
    expect(init?.method).toBe("GET");
    return Response.json({ error: { code: "invalid_request_error", message: "Task not found or has expired." } }, { status });
  } }).catch(error => error);
  expect(error).not.toBeInstanceOf(ApiMartImageQueryRetryable);
  expect(error).not.toBeInstanceOf(ApiMartImageProviderFailure);
  expect(error).toMatchObject({ code: "PROVIDER_POLL_HTTP_ERROR", httpStatus: status });
  expect(requests).toBe(1);
});

test("an expired durable image query deadline permits no provider request", async () => {
  let requests = 0;
  await expect(stepApiMartImageTask({ ...input, upstreamTaskId: "original", pollDeadlineAt: new Date(Date.now() - 1).toISOString() }, {
    fetch: async () => { requests++; return Response.json(completed); },
  })).rejects.toMatchObject({ code: "PROVIDER_POLL_TIMEOUT" });
  expect(requests).toBe(0);
});

test("durable image GET timeout is capped by its remaining observation window", async () => {
  const now = Date.now();
  let querySignal: AbortSignal | undefined;
  await stepApiMartImageTask({ ...input, upstreamTaskId: "original", pollDeadlineAt: new Date(now + 40).toISOString() }, {
    now: () => now, fetch: async (_url, init) => { querySignal = init?.signal ?? undefined; return Response.json({ data: { status: "processing" } }); },
  });
  expect(querySignal?.aborted).toBe(false);
  await Bun.sleep(80);
  expect(querySignal?.aborted).toBe(true);
});

test("unrecognized image status never echoes arbitrary provider text or credentials", async () => {
  const apiKey = "PRIVATE-UPPERCASE-KEY";
  const error = await stepApiMartImageTask({ ...input, apiKey, upstreamTaskId: "original" }, {
    fetch: async () => Response.json({ data: { status: apiKey } }),
  }).catch(error => error);
  expect(error).toBeInstanceOf(ApiMartImageQueryRetryable);
  expect(error.message.toLowerCase()).not.toContain(apiKey.toLowerCase());
});

test("blocking image convenience wrapper still waits until the same task completes", async () => {
  const requests: string[] = [], delays: number[] = [];
  const result = await runApiMartImageTask(input, {
    sleep: async ms => { delays.push(ms); }, fetch: async (_url, init) => {
      requests.push(init?.method || "GET");
      if (init?.method === "POST") return Response.json({ data: [{ task_id: "saved" }] });
      return Response.json(requests.length === 2 ? { data: { status: "processing" } } : completed);
    },
  });
  expect(result).toHaveLength(2);
  expect(requests).toEqual(["POST", "GET", "GET"]);
  expect(delays).toEqual([2_000, 2_000]);
});
