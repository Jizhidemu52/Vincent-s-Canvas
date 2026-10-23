import { expect, test } from "bun:test";
import { ApiMartImageProviderFailure, runApiMartImageTask, stepApiMartImageTask } from "../src/apimart-image";

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
