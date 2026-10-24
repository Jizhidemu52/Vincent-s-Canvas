import { describe, expect, test } from "bun:test";
import { runApiMartVideoTask, VideoProviderFailure } from "../src/media-runtime";

const baseInput = { baseUrl: "https://provider.example/v1", apiKey: "test-only", modelId: "wan2.7", prompt: "产品旋转", parameters: { seconds: 6, size: "16:9", resolution: "720P" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("APIMart video runtime safety", () => {
  test("all four video models upload local references before claiming and submitting video work", async () => {
    for (const modelId of ["MiniMax-H3", "doubao-seedance-2.5", "wan2.7", "happyhorse-1.1"]) {
      const events: string[] = [];
      const result = await runApiMartVideoTask({ ...baseInput, modelId,
        sources: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), publicUrl: "http://private-s3:9000/source.png" }],
        beforeSubmit: async () => { events.push("claimed"); return true; },
        onSubmitted: async (id) => { events.push(`persist:${id}`); },
      }, { sleep: async () => undefined, fetch: async (url, init) => {
        events.push(`${init?.method || "GET"}:${url}`);
        if (url.endsWith("/uploads/images")) {
          expect(init?.body).toBeInstanceOf(FormData);
          return json({ url: "https://cdn.example/uploaded.png" });
        }
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          expect(body.model).toBe(modelId === "doubao-seedance-2.5" ? "seedance-2.5" : modelId);
          expect(body).toMatchObject(["MiniMax-H3", "happyhorse-1.1"].includes(modelId) ? { first_frame_image: "https://cdn.example/uploaded.png" } : { image_urls: ["https://cdn.example/uploaded.png"] });
          expect(String(init.body)).not.toContain("private-s3");
          expect(String(init.body)).not.toContain("base64");
          return json({ data: [{ task_id: "upstream-image" }] });
        }
        return json({ data: { status: "completed", result: { videos: ["https://cdn.example/video.mp4"] } } });
      } });
      expect(result).toBe("https://cdn.example/video.mp4");
      expect(events).toEqual(["POST:https://provider.example/v1/uploads/images", "claimed", "POST:https://provider.example/v1/videos/generations", "persist:upstream-image", "GET:https://provider.example/v1/tasks/upstream-image"]);
    }
  });

  test("an upload failure can be retried without ever claiming or duplicating video submission", async () => {
    let uploads = 0;
    let claims = 0;
    let videoPosts = 0;
    const input = { ...baseInput, sources: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
      beforeSubmit: async () => { claims++; return true; }, onSubmitted: async () => undefined };
    const runtime = { sleep: async () => undefined, fetch: async (url: string, init?: RequestInit) => {
      if (url.endsWith("/uploads/images")) {
        uploads++;
        return uploads === 1 ? json({}, 503) : json({ url: "https://cdn.example/uploaded.png" });
      }
      if (init?.method === "POST") { videoPosts++; return json({ data: [{ task_id: "original" }] }); }
      return json({ data: { status: "completed", result: { videos: ["https://cdn.example/video.mp4"] } } });
    } };
    await expect(runApiMartVideoTask(input, runtime)).rejects.toThrow("上传失败");
    expect(claims).toBe(0);
    expect(videoPosts).toBe(0);
    expect(await runApiMartVideoTask(input, runtime)).toBe("https://cdn.example/video.mp4");
    expect(uploads).toBe(2);
    expect(claims).toBe(1);
    expect(videoPosts).toBe(1);
  });

  test("reference order is preserved and every source is validated before the first upload", async () => {
    const sources = [{ mimeType: "image/png", bytes: new Uint8Array([1]) }, { mimeType: "image/webp", bytes: new Uint8Array([2]) }];
    let uploads = 0;
    const callbacks = { beforeSubmit: async () => true, onSubmitted: async () => undefined };
    await runApiMartVideoTask({ ...baseInput, ...callbacks, sources }, { sleep: async () => undefined, fetch: async (url, init) => {
      if (url.endsWith("/uploads/images")) {
        const index = ++uploads;
        const file = (init?.body as FormData).get("file") as File;
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([index]));
        return json({ url: `https://cdn.example/frame-${index}.png` });
      }
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body)).image_urls).toEqual(["https://cdn.example/frame-1.png", "https://cdn.example/frame-2.png"]);
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
