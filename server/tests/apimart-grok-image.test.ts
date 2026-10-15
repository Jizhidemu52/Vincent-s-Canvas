import { describe, expect, test } from "bun:test";
import { apiMartImageModel, buildApiMartImageRequest, runApiMartImageTask } from "../src/apimart-image";

const modelId = "grok-imagine-image-2.0";
const source = "data:image/png;base64,AQID";
const publicSource = "https://images.example/reference.png";
const submissionKey = "68cfb4aa-9028-4aca-a727-9bb2e4e19868";
const base = { modelId, prompt: "A complex cable-knit cardigan", parameters: {}, baseUrl: "https://mark.example/v1", apiKey: "fixture-only-mark-key", submissionKey };
const completed = { code: 200, data: { id: "grok_task", status: "completed", result: { images: [{ url: ["https://images.example/result.png"] }] } } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const sleep = async () => {};

describe("APIMart Grok Imagine Image 2.0 official", () => {
  test("recognizes only the verified official model and uses its text-to-image defaults", () => {
    expect(apiMartImageModel(modelId)).toBe(modelId);
    expect(apiMartImageModel("grok-imagine-2.0-ext")).toBeNull();
    const request = buildApiMartImageRequest({ ...base, prompt: "  Cotton knit  ", parameters: { count: 6 } });
    expect(request.path).toBe("/images/generations");
    expect(request.payload).toEqual({ model: modelId, prompt: "Cotton knit", n: 1, aspect_ratio: "auto", resolution: "1k", quality: "medium" });
  });

  test.each(["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "auto"])("maps application size %s to aspect_ratio rather than a pixel size", size => {
    const request = buildApiMartImageRequest({ ...base, parameters: { size, resolution: "2k", quality: "low", nsfw_check: true } });
    expect(request.payload).toEqual({ model: modelId, prompt: base.prompt, n: 1, aspect_ratio: size, resolution: "2k", quality: "low", nsfw_check: true });
  });

  test("native aspect_ratio is supported and referenced edits omit stale quality", () => {
    const request = buildApiMartImageRequest({ ...base, parameters: { aspect_ratio: "9:19.5", resolution: "2k", quality: "high", nsfw_check: false }, sourceDataUrls: Array(3).fill(publicSource) });
    expect(request.payload).toEqual({ model: modelId, prompt: base.prompt, n: 1, aspect_ratio: "9:19.5", resolution: "2k", image_urls: Array(3).fill(publicSource), nsfw_check: false });
  });

  test.each([{ resolution: "4k" }, { resolution: "0.5k" }, { quality: "high" }, { size: "1024x1024" }, { size: "21:9" }, { size: null }, { aspect_ratio: "7:5" }, { aspect_ratio: null }, { nsfw_check: "false" }, { n: 2 }])("rejects incompatible parameter before uploading any input: %j", async parameters => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, parameters }, { sleep, fetch: async () => { calls++; return json({}); } })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test.each(["", " ", "a".repeat(8001)])("rejects empty or overlong prompts before submission", async prompt => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, prompt }, { sleep, fetch: async () => { calls++; return json({}); } })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("references are URL-only at the wire builder and limited to three", () => {
    expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: [source] })).toThrow("URL");
    expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: Array(4).fill(publicSource) })).toThrow("3");
    expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: ["http://127.0.0.1/private"] })).toThrow("URL");
  });

  test("all references are validated before the first upload, including 10 MiB and MIME limits", async () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64")}`;
    for (const invalid of [oversized, "data:image/gif;base64,AQID", "data:image/webp;base64,bad%%", "/api/assets/private/content"]) {
      let calls = 0;
      await expect(runApiMartImageTask({ ...base, sourceDataUrls: [source, invalid] }, {
        sleep, fetch: async () => { calls++; return json({}); },
      })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test("uploads then submits once with the persistent task UUID and pinned response version", async () => {
    const events: string[] = [];
    const result = await runApiMartImageTask({ ...base, parameters: { quality: "medium", size: "4:3", resolution: "2k" }, sourceDataUrls: [source, "http://images.example/second.jpg"],
      beforeSubmit: () => { events.push("intent"); }, onSubmitted: id => { expect(id).toBe("grok_task"); events.push("persist"); },
    }, { sleep, fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fixture-only-mark-key");
      if (url.endsWith("/uploads/images")) { events.push("upload"); return json({ url: publicSource }); }
      expect(headers.get("x-apimart-response-version")).toBe("2026-07-27");
      expect(headers.get("accept")).toBe("application/json");
      if (url.endsWith("/images/generations")) {
        events.push("submit"); expect(events).toEqual(["upload", "intent", "submit"]);
        expect(init?.method).toBe("POST"); expect(headers.get("idempotency-key")).toBe(submissionKey);
        expect(JSON.parse(String(init?.body))).toEqual({ model: modelId, prompt: base.prompt, n: 1, aspect_ratio: "4:3", resolution: "2k", image_urls: [publicSource, "http://images.example/second.jpg"] });
        return json({ code: 202, data: { id: "grok_task", object: "generation.task", type: "image", status: "pending", progress: 0, poll_url: "/v1/tasks/grok_task" } }, 202);
      }
      expect(url).toBe("https://mark.example/v1/tasks/grok_task"); expect(init?.method).not.toBe("POST");
      events.push("poll"); expect(events).toEqual(["upload", "intent", "submit", "persist", "poll"]);
      return json(completed);
    } });
    expect(result).toEqual(["https://images.example/result.png"]);
  });

  test("accepts a JPEG exactly at the 10 MiB upload boundary", async () => {
    const atLimit = `data:image/jpeg;base64,${Buffer.alloc(10 * 1024 * 1024, 1).toString("base64")}`;
    let uploads = 0, submits = 0;
    await runApiMartImageTask({ ...base, sourceDataUrls: [atLimit] }, { sleep, fetch: async (url, init) => {
      if (url.endsWith("/uploads/images")) {
        const file = (init?.body as FormData).get("file") as File;
        expect(file.type).toBe("image/jpeg"); expect(file.size).toBe(10 * 1024 * 1024); uploads++;
        return json({ url: publicSource });
      }
      if (url.endsWith("/images/generations")) { submits++; return json({ code: 202, data: { id: "grok_task" } }, 202); }
      return json(completed);
    } });
    expect(uploads).toBe(1); expect(submits).toBe(1);
  });

  test.each([undefined, "", "new-key-every-attempt"])("missing or invalid durable submission key fails before upload: %s", async key => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, submissionKey: key, sourceDataUrls: [source] }, {
      sleep, fetch: async () => { calls++; return json({}); },
    })).rejects.toThrow("submissionKey");
    expect(calls).toBe(0);
  });

  test("known task recovery requires no key and cannot upload or submit again", async () => {
    const methods: string[] = [];
    await runApiMartImageTask({ ...base, submissionKey: undefined, upstreamTaskId: "grok_saved", submissionStarted: true, sourceDataUrls: ["expired"], parameters: { resolution: "old" } }, {
      sleep, fetch: async (url, init) => { expect(url).toEndWith("/tasks/grok_saved"); methods.push(init?.method || "GET"); return json(completed); },
    });
    expect(methods).toEqual(["GET"]);
  });

  test.each([409, 503])("HTTP %i is never retried with the same or a new key", async status => {
    let calls = 0;
    await expect(runApiMartImageTask(base, { sleep, fetch: async (_url, init) => {
      calls++; expect(init?.method).toBe("POST"); expect(new Headers(init?.headers).get("idempotency-key")).toBe(submissionKey);
      return json({ error: { message: "Indeterminate", code: "idempotency_result_indeterminate" } }, status);
    } })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("mask input cannot silently turn into a whole-image edit", async () => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, sourceDataUrls: [source], maskDataUrl: source }, {
      sleep, fetch: async () => { calls++; return json({}); },
    })).rejects.toThrow("蒙版");
    expect(calls).toBe(0);
  });
});

describe("ordinary GPT2 stays on its existing distinct contract", () => {
  test("uses Mark credentials but keeps GPT2 URL/base64 references and resolution without GPT2.5 quality", async () => {
    const requests: string[] = [];
    await runApiMartImageTask({ ...base, modelId: "gpt-image-2", parameters: { size: "1881x836", resolution: "4k", quality: "max" }, sourceDataUrls: [source, publicSource] }, {
      sleep, fetch: async (url, init) => {
        requests.push(url);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-only-mark-key");
        if (url.endsWith("/images/generations")) {
          expect(JSON.parse(String(init?.body))).toEqual({ model: "gpt-image-2", prompt: base.prompt, n: 1, size: "1881x836", resolution: "4k", image_urls: [source, publicSource] });
          return json({ code: 200, data: [{ status: "submitted", task_id: "gpt2_saved" }] });
        }
        expect(url).toEndWith("/tasks/gpt2_saved"); return json(completed);
      },
    });
    expect(requests).toHaveLength(2);
  });

  test("ordinary GPT2 allows fifteen references and rejects a sixteenth before a paid request", async () => {
    expect(buildApiMartImageRequest({ ...base, modelId: "gpt-image-2", sourceDataUrls: Array(15).fill(publicSource) }).payload.image_urls).toHaveLength(15);
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, modelId: "gpt-image-2", sourceDataUrls: Array(16).fill(publicSource) }, {
      sleep, fetch: async () => { calls++; return json({}); },
    })).rejects.toThrow("15");
    expect(calls).toBe(0);
  });
});
