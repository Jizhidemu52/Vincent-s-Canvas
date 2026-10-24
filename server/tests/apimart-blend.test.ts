import { describe, expect, test } from "bun:test";
import { buildApiMartImageRequest, runApiMartImageTask } from "../src/apimart-image";

const urls = ["https://images.example/a.png", "https://images.example/b.webp", "https://images.example/c.jpg", "https://images.example/d.png"];
const inline = "data:image/png;base64,AQID";
const base = { modelId: "midjourney-blend", prompt: "This must never reach Blend", parameters: {}, sourceDataUrls: urls.slice(0, 2), baseUrl: "https://provider.example/v1", apiKey: "fixture-only-key" };
const completed = { code: 200, data: { status: "completed", result: { images: [{ url: ["https://images.example/result.png"] }] } } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = async () => {};

describe("MJ Blend fixed-provider request contract", () => {
  test.each([2, 4])("accepts %i references without forwarding prompt, version or Imagine-only fields", count => {
    const request = buildApiMartImageRequest({ ...base, sourceDataUrls: urls.slice(0, count), parameters: { version: "7", midjourneyVersion: "7", seed: 9, stylize: 500, n: 1 } });
    expect(request.path).toBe("/midjourney/generations/blend");
    expect(request.payload).toEqual({ image_urls: urls.slice(0, count), dimensions: "SQUARE", speed: "relax" });
  });

  test("free aspect ratio overrides the dimensions preset and accepts the documented speed key", () => {
    const request = buildApiMartImageRequest({ ...base, parameters: { size: "21:9", dimensions: "PORTRAIT", speed: "turbo", nsfw_check: true, metadata: { job: "sample", stage: 2 } } });
    expect(request.payload).toEqual({ image_urls: urls.slice(0, 2), size: "21:9", speed: "turbo", nsfw_check: true, metadata: { job: "sample", stage: 2 } });
  });

  test("retains the existing application speed alias and all three preset dimensions", () => {
    for (const dimensions of ["SQUARE", "PORTRAIT", "LANDSCAPE"]) {
      const request = buildApiMartImageRequest({ ...base, parameters: { dimensions, midjourneySpeed: "fast", nsfw_check: false } });
      expect(request.payload).toEqual({ image_urls: urls.slice(0, 2), dimensions, speed: "fast", nsfw_check: false });
    }
  });

  test.each([
    { speed: "instant" }, { midjourneySpeed: "instant" }, { speed: 1 }, { speed: null }, { dimensions: "square" },
    { size: "1024x1024" }, { size: "auto" }, { size: "0:3" }, { size: "" }, { size: null },
    { nsfw_check: "false" }, { metadata: [] }, { metadata: null }, { n: 2 },
  ])("rejects malformed Blend parameters before upload or paid submission: %j", async parameters => {
    let calls = 0, claims = 0;
    await expect(runApiMartImageTask({ ...base, parameters, sourceDataUrls: [inline, inline], beforeSubmit: () => { claims++; } }, {
      sleep, fetch: async () => { calls++; return json({ data: [{ task_id: "unexpected" }] }); },
    })).rejects.toThrow();
    expect(calls).toBe(0); expect(claims).toBe(0);
  });

  test.each([0, 1, 5])("rejects %i references before upload or paid submission", async count => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, sourceDataUrls: Array(count).fill(inline) }, {
      sleep, fetch: async () => { calls++; return json({}); },
    })).rejects.toThrow("2 to 4");
    expect(calls).toBe(0);
  });

  test.each(["/api/assets/private/content", "http://127.0.0.1/a.png", "https://user:secret@images.example/a.png", "file:///private/a.png", "https://intranet.local/a.png", "data:image/svg+xml;base64,AQID", "data:image/png;base64,not-valid%%", "data:image/png;base64,"])("rejects unsafe or malformed reference before uploading any image: %s", async reference => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, sourceDataUrls: [inline, reference] }, {
      sleep, fetch: async () => { calls++; return json({}); },
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("enforces the inclusive 12 MiB limit before uploading any reference", async () => {
    const atLimit = `data:image/png;base64,${Buffer.alloc(12 * 1024 * 1024, 1).toString("base64")}`;
    expect(buildApiMartImageRequest({ ...base, sourceDataUrls: [atLimit, inline] }).payload.image_urls).toHaveLength(2);
    const aboveLimit = `data:image/png;base64,${Buffer.alloc(12 * 1024 * 1024 + 1, 1).toString("base64")}`;
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, sourceDataUrls: [inline, aboveLimit] }, {
      sleep, fetch: async () => { calls++; return json({}); },
    })).rejects.toThrow("12");
    expect(calls).toBe(0);
  });

  test("preserves inline reference order, persists intent and task ID, then only polls", async () => {
    const events: string[] = [];
    const result = await runApiMartImageTask({ ...base, sourceDataUrls: [inline, urls[1]!, "data:image/webp;base64,BAUG"], parameters: { size: "13:7", speed: "fast" },
      beforeSubmit: () => { events.push("intent"); }, onSubmitted: id => { expect(id).toBe("blend_saved"); events.push("persist"); },
    }, { sleep, fetch: async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-only-key");
      if (url.endsWith("/uploads/images")) {
        const file = (init?.body as FormData).get("file") as File;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const first = bytes[0] === 1;
        expect(file.type).toBe(first ? "image/png" : "image/webp");
        expect(bytes).toEqual(new Uint8Array(first ? [1, 2, 3] : [4, 5, 6]));
        events.push("upload");
        return json({ url: first ? urls[0] : urls[2] });
      }
      if (url.endsWith("/midjourney/generations/blend")) {
        events.push("submit");
        expect(init?.method).toBe("POST");
        expect(events).toEqual(["upload", "upload", "intent", "submit"]);
        expect(JSON.parse(String(init?.body))).toEqual({ image_urls: [urls[0], urls[1], urls[2]], size: "13:7", speed: "fast" });
        return json({ code: 200, data: [{ status: "submitted", task_id: "blend_saved" }] });
      }
      expect(url).toBe("https://provider.example/v1/tasks/blend_saved"); expect(init?.method).not.toBe("POST");
      events.push("poll"); expect(events).toEqual(["upload", "upload", "intent", "submit", "persist", "poll"]);
      return json(completed);
    } });
    expect(result).toEqual(["https://images.example/result.png"]);
  });

  test.each([json({}, 503), json({ url: "http://127.0.0.1/private.png" }), json({ url: "data:image/png;base64,AQID" })])("upload failure or nonpublic URL cannot start a paid Blend task", async response => {
    const requests: string[] = [];
    await expect(runApiMartImageTask({ ...base, sourceDataUrls: [inline, inline], beforeSubmit: () => { throw new Error("Claim must not run"); } }, {
      sleep, fetch: async url => { requests.push(url); return response.clone(); },
    })).rejects.toThrow();
    expect(requests).toEqual(["https://provider.example/v1/uploads/images", "https://provider.example/v1/uploads/images"]);
  });

  test("known upstream ID ignores expired inputs and performs no upload, claim or POST", async () => {
    const methods: string[] = [];
    const result = await runApiMartImageTask({ ...base, sourceDataUrls: ["gone"], parameters: { size: "invalid" }, upstreamTaskId: "blend_saved", submissionStarted: true,
      beforeSubmit: () => { throw new Error("must not claim"); }, onSubmitted: () => { throw new Error("must not persist again"); },
    }, { sleep, fetch: async (url, init) => { expect(url).toEndWith("/tasks/blend_saved"); methods.push(init?.method || "GET"); return json(completed); } });
    expect(methods).toEqual(["GET"]); expect(result).toEqual(["https://images.example/result.png"]);
  });

  test("submission intent without an upstream ID cannot upload or resubmit", async () => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, submissionStarted: true }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("不会");
    expect(calls).toBe(0);
  });

  test("task-ID persistence failure stops after a single paid POST and before polling", async () => {
    const requests: string[] = [];
    await expect(runApiMartImageTask({ ...base, onSubmitted: () => { throw new Error("disk unavailable"); } }, {
      sleep, fetch: async url => { requests.push(url); return json({ data: [{ task_id: "blend_saved" }] }); },
    })).rejects.toThrow("disk unavailable");
    expect(requests).toEqual(["https://provider.example/v1/midjourney/generations/blend"]);
  });

  test("a separate mask is rejected before upload rather than silently ignored", async () => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, maskDataUrl: inline }, {
      sleep, fetch: async () => { calls++; return json({}); },
    })).rejects.toThrow("蒙版");
    expect(calls).toBe(0);
  });

  test("a completed task with a private result URL stays recoverable without a new POST", async () => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, upstreamTaskId: "blend_saved" }, {
      sleep, fetch: async (_url, init) => {
        calls++; expect(init?.method).not.toBe("POST");
        return json({ data: { status: "completed", result: { images: [{ url: ["http://127.0.0.1/private.png"] }] } } });
      },
    })).rejects.toThrow("可恢复");
    expect(calls).toBe(1);
  });
});
