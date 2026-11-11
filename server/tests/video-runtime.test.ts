import { describe, expect, test } from "bun:test";
import { runApiMartVideoTask, VideoProviderFailure } from "../src/media-runtime";

const baseInput = { baseUrl: "https://provider.example/v1", apiKey: "test-only", modelId: "wan2.7", prompt: "产品旋转", parameters: { seconds: 6, size: "16:9", resolution: "720P" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("APIMart video runtime safety", () => {
  test("all APIMart video models preserve owned public references without provider uploads", async () => {
    for (const modelId of ["MiniMax-H3", "doubao-seedance-2.5", "gemini-omni-1.2-flash", "wan2.7", "happyhorse-1.1"]) {
      const events: string[] = [];
      const result = await runApiMartVideoTask({ ...baseInput, modelId,
        sources: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), publicUrl: "http://owned.example/api/provider-images/fixture" }],
        beforeSubmit: async () => { events.push("claimed"); return true; },
        onSubmitted: async (id) => { events.push(`persist:${id}`); },
      }, { sleep: async () => undefined, fetch: async (url, init) => {
        events.push(`${init?.method || "GET"}:${url}`);
        expect(url).not.toContain("/uploads/");
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          expect(body.model).toBe(modelId === "doubao-seedance-2.5" ? "seedance-2.5" : modelId);
          expect(body).toMatchObject(["MiniMax-H3", "happyhorse-1.1", "gemini-omni-1.2-flash"].includes(modelId) ? { first_frame_image: "http://owned.example/api/provider-images/fixture" } : { image_urls: ["http://owned.example/api/provider-images/fixture"] });
          expect(String(init.body)).not.toContain("private-s3");
          expect(String(init.body)).not.toContain("base64");
          return json({ data: [{ task_id: "upstream-image" }] });
        }
        return json({ data: { status: "completed", result: { videos: ["https://cdn.example/video.mp4"] } } });
      } });
      expect(result).toBe("https://cdn.example/video.mp4");
      expect(events).toEqual(["claimed", "POST:https://provider.example/v1/videos/generations", "persist:upstream-image", "GET:https://provider.example/v1/tasks/upstream-image"]);
    }
  });

  test("missing owned URLs fail before claiming and never fall back to provider uploads", async () => {
    let requests = 0;
    let claims = 0;
    const input = { ...baseInput, sources: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
      beforeSubmit: async () => { claims++; return true; }, onSubmitted: async () => undefined };
    const runtime = { fetch: async () => { requests++; return json({}); } };
    await expect(runApiMartVideoTask(input, runtime)).rejects.toThrow("公开 HTTP(S)");
    expect(claims).toBe(0);
    expect(requests).toBe(0);
  });

  test("reference order is preserved and every source is validated before the paid POST", async () => {
    const sources = [{ mimeType: "image/png", bytes: new Uint8Array([1]), publicUrl: "https://owned.example/frame-1.png" }, { mimeType: "image/webp", bytes: new Uint8Array([2]), publicUrl: "https://owned.example/frame-2.png" }];
    const callbacks = { beforeSubmit: async () => true, onSubmitted: async () => undefined };
    await runApiMartVideoTask({ ...baseInput, ...callbacks, sources }, { sleep: async () => undefined, fetch: async (url, init) => {
      expect(url).not.toContain("/uploads/");
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body)).image_urls).toEqual(sources.map(source => source.publicUrl));
        return json({ data: [{ task_id: "original" }] });
      }
      return json({ data: { status: "completed", result: { videos: ["https://cdn.example/video.mp4"] } } });
    } });
    let requests = 0;
    await expect(runApiMartVideoTask({ ...baseInput, ...callbacks, sources: [sources[0]!, { mimeType: "image/svg+xml", bytes: new Uint8Array([2]) }] }, { fetch: async () => { requests++; return json({}); } })).rejects.toThrow("格式");
    expect(requests).toBe(0);
  });

  test("submits the video protocol once and persists its ID before polling", async () => {
    const events: string[] = [];
    const result = await runApiMartVideoTask({ ...baseInput,
      beforeSubmit: async () => { events.push("claimed"); return true; },
      onSubmitted: async (id) => { events.push(`persist:${id}`); },
    }, { sleep: async () => undefined, fetch: (async (url, init) => {
      events.push(`${init?.method || "GET"}:${url}`);
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ model: "wan2.7", duration: 6, resolution: "720P", size: "16:9" });
        return json({ data: [{ task_id: "upstream-1" }] });
      }
      return json({ data: { status: "completed", result: { videos: [{ url: "https://cdn.example/video.mp4" }] } } });
    }) });
    expect(result).toBe("https://cdn.example/video.mp4");
    expect(events).toEqual(["claimed", "POST:https://provider.example/v1/videos/generations", "persist:upstream-1", "GET:https://provider.example/v1/tasks/upstream-1"]);
  });

  test("a restarted task with a persisted upstream ID only queries that original ID", async () => {
    const requests: string[] = [];
    const result = await runApiMartVideoTask({ ...baseInput, upstreamTaskId: "original/id", submissionStarted: true,
      sources: [{ mimeType: "image/png", bytes: new Uint8Array(), publicUrl: "http://private-s3/source.png" }],
      beforeSubmit: async () => { throw new Error("must not submit"); }, onSubmitted: async () => { throw new Error("must not change ID"); },
    }, { sleep: async () => undefined, fetch: (async (url, init) => {
      requests.push(`${init?.method || "GET"}:${url}`);
      return json({ data: { status: "completed", result: { videos: ["https://cdn.example/video.mp4"] } } });
    }) });
    expect(result).toBe("https://cdn.example/video.mp4");
    expect(requests).toEqual(["GET:https://provider.example/v1/tasks/original%2Fid"]);
  });

  test("a submission with unknown outcome is never automatically submitted again", async () => {
    let requests = 0;
    await expect(runApiMartVideoTask({ ...baseInput, submissionStarted: true,
      sources: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
      beforeSubmit: async () => true, onSubmitted: async () => undefined,
    }, { fetch: (async () => { requests++; return json({}); }) })).rejects.toThrow("提交状态未知");
    expect(requests).toBe(0);
  });

  test("a lost submission claim or failure to persist the ID stops without a second POST", async () => {
    for (const claimed of [false, true]) {
      let requests = 0;
      await expect(runApiMartVideoTask({ ...baseInput,
        beforeSubmit: async () => claimed, onSubmitted: async () => { throw new Error("database unavailable"); },
      }, { fetch: (async () => { requests++; return json({ data: [{ task_id: "original-id" }] }); }) })).rejects.toThrow();
      expect(requests).toBe(claimed ? 1 : 0);
    }
  });

  test("provider terminal failures and temporary query failures remain distinguishable", async () => {
    const input = { ...baseInput, upstreamTaskId: "original", beforeSubmit: async () => true, onSubmitted: async () => undefined };
    await expect(runApiMartVideoTask(input, { sleep: async () => undefined, fetch: (async () => json({ data: { status: "failed", error: { message: "upstream rejected" } } })) })).rejects.toBeInstanceOf(VideoProviderFailure);
    try {
      await runApiMartVideoTask(input, { sleep: async () => undefined, fetch: (async () => json({}, 502)) });
      throw new Error("Expected query failure");
    } catch (error) {
      expect(error).not.toBeInstanceOf(VideoProviderFailure);
      expect(String(error)).toContain("502");
    }
  });

  test("unconfigured providers, unknown models and bad references cannot create upstream work", async () => {
    for (const extra of [{ apiKey: "" }, { modelId: "unknown" }, { sources: [{ mimeType: "image/png", bytes: new Uint8Array() }] }]) {
      let requests = 0;
      await expect(runApiMartVideoTask({ ...baseInput, ...extra, beforeSubmit: async () => true, onSubmitted: async () => undefined }, {
        fetch: (async () => { requests++; return json({}); }),
      })).rejects.toThrow();
      expect(requests).toBe(0);
    }
  });

  test("retains the actual 400 rejection reason without replaying the paid POST", async () => {
    let submissions = 0;
    const input = { ...baseInput, beforeSubmit: async () => true, onSubmitted: async () => { throw new Error("must not store an ID"); } };
    try {
      await runApiMartVideoTask(input, { fetch: async () => {
        submissions++;
        return json({ error: { message: "First frame image validation failed" } }, 400);
      } });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(VideoProviderFailure);
      expect(String(error)).toContain("400）：First frame image validation failed");
    }
    expect(submissions).toBe(1);
  });

  test("keeps definite failure classification if the error body is absent, invalid or oversized", async () => {
    for (const body of ["", "<html>gateway error</html>", JSON.stringify({ error: { message: "x".repeat(20_000) } })]) {
      await expect(runApiMartVideoTask({ ...baseInput, beforeSubmit: async () => true, onSubmitted: async () => undefined }, {
        fetch: async () => new Response(body, { status: 400 }),
      })).rejects.toBeInstanceOf(VideoProviderFailure);
    }
  });

  test("bounded error text never repeats credentials or source URLs", async () => {
    const input = { ...baseInput, upstreamTaskId: "original", beforeSubmit: async () => true, onSubmitted: async () => undefined };
    try {
      await runApiMartVideoTask(input, { sleep: async () => undefined, fetch: async () => json({ message: `Bad ${baseInput.apiKey} Bearer secret-token https://cdn.example/private.png?signature=secret ${"x".repeat(600)}` }, 400) });
      throw new Error("Expected query failure");
    } catch (error) {
      expect(error).not.toBeInstanceOf(VideoProviderFailure);
      const message = String(error);
      expect(message).toContain("状态查询失败（400）");
      expect(message).not.toContain(baseInput.apiKey);
      expect(message).not.toContain("secret-token");
      expect(message).not.toContain("signature=");
      expect(message.length).toBeLessThan(550);
    }
  });
});
