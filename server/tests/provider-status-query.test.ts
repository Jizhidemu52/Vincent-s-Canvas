import { expect, test } from "bun:test";
import { queryProviderTaskStatus } from "../src/provider-status-query";
import { runApiMartImageTask } from "../src/apimart-image";
import { stepApiMartVideoTask } from "../src/media-runtime";

test("GET retries network/503 interruptions with bounded exponential delays", async () => {
  const delays: number[] = [];
  let calls = 0;
  const response = await queryProviderTaskStatus("https://provider.invalid/tasks/existing", {}, {
    fetch: async (_url, init) => {
      expect(init?.method).toBe("GET");
      if (++calls === 1) throw new TypeError("socket lost");
      return new Response("{}", { status: calls === 2 ? 503 : 200 });
    }, sleep: async milliseconds => { delays.push(milliseconds); },
  });
  expect(response.status).toBe(200);
  expect(calls).toBe(3);
  expect(delays).toEqual([1000, 2000]);
});

test("status queries stop at three attempts; authorization failures are not retried", async () => {
  for (const status of [503, 429, 401]) {
    let calls = 0;
    const result = await queryProviderTaskStatus("https://provider.invalid/tasks/existing", {}, {
      fetch: async () => { calls++; return new Response("{}", { status }); }, sleep: async () => {},
    });
    expect(result.status).toBe(status);
    expect(calls).toBe(status === 401 ? 1 : 3);
  }
});

test("recovered image status queries only GET the original ID, never repeat a paid POST", async () => {
  let calls = 0;
  const result = await runApiMartImageTask({ baseUrl: "https://provider.invalid/v1", apiKey: "test", modelId: "gpt-image-2", prompt: "test", parameters: {}, upstreamTaskId: "original", submissionStarted: true }, {
    sleep: async () => {}, fetch: async (url, init) => {
      expect(url).toEndWith("/tasks/original"); expect(init?.method).toBe("GET");
      if (++calls < 3) return Response.json({}, { status: 502 });
      return Response.json({ data: { status: "completed", result: { images: [{ url: "https://image.invalid/result.png" }] } } });
    },
  });
  expect(result).toEqual(["https://image.invalid/result.png"]);
  expect(calls).toBe(3);
});

test("recovered video queries only GET its saved upstream ID after transient failure", async () => {
  let calls = 0;
  const result = await stepApiMartVideoTask({ baseUrl: "https://provider.invalid/v1", apiKey: "test", modelId: "wan2.7", prompt: "test", parameters: {}, upstreamTaskId: "original", submissionStarted: true,
    beforeSubmit: async () => { throw new Error("must not submit"); }, onSubmitted: async () => { throw new Error("must not replace ID"); },
  }, { sleep: async () => {}, fetch: async (url, init) => {
    expect(url).toEndWith("/tasks/original"); expect(init?.method).toBe("GET");
    if (++calls === 1) throw new Error("network interrupted");
    return Response.json({ data: { status: "completed", result: { videos: ["https://video.invalid/output.mp4"] } } });
  } });
  expect(result.status).toBe("completed");
  expect(calls).toBe(2);
});
