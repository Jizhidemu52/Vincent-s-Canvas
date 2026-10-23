import { describe, expect, test } from "bun:test";
import { ApiMartImageProviderFailure, apiMartImageModel, buildApiMartImageRequest, runApiMartImageTask } from "../src/apimart-image";
import { uploadApiMartImage } from "../src/apimart-upload";

const reference = "data:image/png;base64,AQID";
const publicReference = "https://images.example/reference.png";
const base = { baseUrl: "https://provider.example/v1/", apiKey: "server-secret", modelId: "gpt-image-2.5-flare", prompt: "Change the ribbon", parameters: {} };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const completed = { code: 200, data: { id: "task_saved", status: "completed", progress: 100, result: { images: [{ url: ["https://images.example/one.png", "https://images.example/two.jpg"], expires_at: 1799000000 }, { url: ["https://images.example/three.png"], expires_at: 1799000000 }] } } };

describe("Mark APIMart image contracts", () => {
  test.each(["submission", "status-http", "terminal"])("provider errors redact the known credential before worker persistence: %s", async (phase) => {
    const apiKey = "fixture-secret/+\"";
    const upstreamMessage = `quota denied: ${apiKey}, encoded=${encodeURIComponent(apiKey)}, json=${JSON.stringify(apiKey).slice(1, -1)}`;
    let calls = 0;
    const error = await runApiMartImageTask({ ...base, apiKey, ...(phase === "submission" ? {} : { upstreamTaskId: "existing", submissionStarted: true }) }, {
      sleep: async () => {}, fetch: async () => {
        calls++;
        return phase === "terminal" ? json({ data: { status: "failed", error: { message: upstreamMessage } } })
          : json({ error: { message: upstreamMessage } }, 401);
      },
    }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof ApiMartImageProviderFailure).toBe(phase !== "status-http");
    expect(error.message).toContain("quota denied");
    expect(error.message).not.toContain(apiKey);
    expect(error.message).not.toContain(encodeURIComponent(apiKey));
    expect(error.message).not.toContain(JSON.stringify(apiKey).slice(1, -1));
    expect(calls).toBe(1);
  });

  test("keeps all three model IDs independent and preserves old Nano mapping", () => {
    for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-nano-banana-2.1"] as const) {
      expect(apiMartImageModel(modelId)).toBe(modelId);
      expect(buildApiMartImageRequest({ ...base, modelId }).payload.model).toBe(modelId);
    }
    expect(apiMartImageModel("nano-banana-2")).toBe("gemini-3.1-flash-image-preview");
    expect(apiMartImageModel("gemini-nano-banana-2.1-ext")).toBeNull();
  });

  test("GPT forwards independent quality, resolution and supported output options, keeping each app task single-image", () => {
    expect(buildApiMartImageRequest({ ...base, modelId: "gpt-image-2.5-sunburst", parameters: {
      size: "16:9", resolution: "2K", quality: "xhigh", count: 4, tool: "canvas", inputArchive: {},
      background: "transparent", output_format: "webp", output_compression: 80, moderation: "auto",
    }, sourceDataUrls: [publicReference], maskDataUrl: reference }).payload).toEqual({
      model: "gpt-image-2.5-sunburst", prompt: base.prompt, n: 1, size: "16:9", resolution: "2k", quality: "xhigh",
      background: "transparent", output_format: "webp", output_compression: 80, moderation: "auto",
      image_urls: [publicReference], mask_url: reference,
    });
  });

  test("GPT supports sixteen public references and validates exact-pixel size constraints", () => {
    expect(buildApiMartImageRequest({ ...base, sourceDataUrls: Array(16).fill(publicReference) }).payload.image_urls).toHaveLength(16);
    expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: Array(17).fill(publicReference) })).toThrow("16");
    expect(buildApiMartImageRequest({ ...base, parameters: { size: "1600x1200", resolution: "4k" } }).payload.size).toBe("1600x1200");
    for (const size of ["1881x836", "4000x2048", "1024x256", "256x256"]) {
      expect(() => buildApiMartImageRequest({ ...base, parameters: { size } })).toThrow();
    }
    for (const url of [reference, "file:///private/a.png", "https://localhost/a.png", "http://127.0.0.1/a.png", "https://user:password@images.example/a.png"]) {
      expect(() => buildApiMartImageRequest({ ...base, sourceDataUrls: [url] })).toThrow();
    }
    expect(buildApiMartImageRequest({ ...base, sourceDataUrls: ["http://images.example/a.png"] }).payload.image_urls).toEqual(["http://images.example/a.png"]);
  });

  test("Nano 2.1 uses its own resolutions and leaves missing size adaptive without a made-up reference count cap", () => {
    const payload = buildApiMartImageRequest({ ...base, modelId: "gemini-nano-banana-2.1", parameters: { resolution: "4k" }, sourceDataUrls: Array(17).fill(reference) }).payload;
    expect(payload).toMatchObject({ model: "gemini-nano-banana-2.1", n: 1, resolution: "4K" });
    expect(payload).not.toHaveProperty("quality");
    expect(payload.size === undefined || payload.size === "auto").toBe(true);
    expect(payload.image_urls).toHaveLength(17);
    expect(buildApiMartImageRequest({ ...base, modelId: "gemini-nano-banana-2.1", parameters: { size: "16x9" } }).payload.size).toBe("16:9");
    for (const parameters of [{ resolution: "0.5K" }, { resolution: "512" }, { resolution: "3K" }, { size: "1600x1200" }, { quality: "high" }, { google_search: true }, { official_fallback: true }, { output_format: "webp" }]) {
      expect(() => buildApiMartImageRequest({ ...base, modelId: "gemini-nano-banana-2.1", parameters })).toThrow();
    }
    expect(() => buildApiMartImageRequest({ ...base, modelId: "gemini-nano-banana-2.1", sourceDataUrls: [publicReference], maskDataUrl: reference })).toThrow();
  });

  test("invalid new-model inputs fail before even reference upload or key transmission", async () => {
    const inputs = [
      { parameters: { quality: "2k" } }, { parameters: { resolution: "3k" } },
      { parameters: { background: "transparent", output_format: "jpeg" } },
      { parameters: { output_compression: 101 } }, { parameters: { official_fallback: true } },
      { sourceDataUrls: [reference, "data:image/png;base64,not-valid%%"] },
      { sourceDataUrls: [reference], maskDataUrl: "data:image/jpeg;base64,AQID" },
      { sourceDataUrls: [], maskDataUrl: reference },
    ];
    for (const extra of inputs) {
      let calls = 0;
      await expect(runApiMartImageTask({ ...base, sourceDataUrls: [reference], ...extra }, { fetch: async () => { calls++; return json({}); }, sleep: async () => {} })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test("uploads authorized references, claims submission, persists task ID, then polls and flattens every result", async () => {
    const events: string[] = [];
    const output = await runApiMartImageTask({ ...base, sourceDataUrls: [reference], maskDataUrl: reference,
      beforeSubmit: async () => { events.push("claim"); },
      onSubmitted: async taskId => { expect(taskId).toBe("task_saved"); events.push("persist"); },
    }, { sleep: async () => {}, fetch: async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret");
      if (url.endsWith("/uploads/images")) {
        events.push("upload");
        const file = (init?.body as FormData).get("file") as File;
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        return json({ url: publicReference });
      }
      if (url.endsWith("/images/generations")) {
        events.push("submit");
        expect(events).toEqual(["upload", "claim", "submit"]);
        expect(JSON.parse(String(init?.body))).toMatchObject({ image_urls: [publicReference], mask_url: reference, n: 1 });
        return json({ code: 200, data: [{ status: "submitted", task_id: "task_saved" }] });
      }
      events.push("poll");
      expect(events).toEqual(["upload", "claim", "submit", "persist", "poll"]);
      expect(url).toBe("https://provider.example/v1/tasks/task_saved");
      return json(completed);
    } });
    expect(output).toEqual(["https://images.example/one.png", "https://images.example/two.jpg", "https://images.example/three.png"]);
  });

  test("Nano references use the same upload workflow instead of sending base64 to generation", async () => {
    const requests: string[] = [];
    await runApiMartImageTask({ ...base, modelId: "gemini-nano-banana-2.1", sourceDataUrls: [reference] }, { sleep: async () => {}, fetch: async (url, init) => {
      requests.push(url);
      if (url.endsWith("/uploads/images")) return json({ url: publicReference });
      if (url.endsWith("/images/generations")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gemini-nano-banana-2.1", resolution: "1K", image_urls: [publicReference] });
        return json({ data: [{ task_id: "task_saved" }] });
      }
      return json(completed);
    } });
    expect(requests).toHaveLength(3);
  });

  test("resuming an upstream task skips invalid old sources, upload, claims and submission", async () => {
    let calls = 0;
    await runApiMartImageTask({ ...base, upstreamTaskId: "task_saved", submissionStarted: true, sourceDataUrls: ["unavailable-source"], parameters: { quality: "old-invalid-value" },
      beforeSubmit: async () => { throw new Error("Must not reclaim"); }, onSubmitted: async () => { throw new Error("Must not resubmit"); },
    }, { sleep: async () => {}, fetch: async (url, init) => { calls++; expect(url).toEndWith("/tasks/task_saved"); expect(init?.method).not.toBe("POST"); return json(completed); } });
    expect(calls).toBe(1);
  });

  test("an uncertain prior submission never uploads or resubmits", async () => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, submissionStarted: true }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow("不会");
    expect(calls).toBe(0);
  });

  test("a persistence failure stops before polling and never retries the paid submission", async () => {
    let calls = 0;
    await expect(runApiMartImageTask({ ...base, onSubmitted: async () => { throw new Error("Persistence failed"); } }, { sleep: async () => {}, fetch: async () => {
      calls++; return json({ data: [{ task_id: "task_saved" }] });
    } })).rejects.toThrow("Persistence failed");
    expect(calls).toBe(1);
  });

  test("a failed upload or failed submission claim cannot reach the paid POST", async () => {
    let claimCount = 0;
    let requests: string[] = [];
    await expect(runApiMartImageTask({ ...base, sourceDataUrls: [reference], beforeSubmit: async () => { claimCount++; } }, {
      fetch: async url => { requests.push(url); return json({}, 503); },
    })).rejects.toThrow("上传失败");
    expect(claimCount).toBe(0);
    expect(requests).toEqual(["https://provider.example/v1/uploads/images"]);
    requests = [];
    await expect(runApiMartImageTask({ ...base, beforeSubmit: async () => { throw new Error("Claim unavailable"); } }, {
      fetch: async url => { requests.push(url); return json({}); },
    })).rejects.toThrow("Claim unavailable");
    expect(requests).toEqual([]);
  });

  test("submission transport failure and missing task ID never retry or poll", async () => {
    for (const response of [new Error("Connection lost after POST"), json({ code: 200, data: [] }), json({ error: { message: "Unavailable" } }, 503)]) {
      let calls = 0;
      await expect(runApiMartImageTask(base, { sleep: async () => {}, fetch: async (url, init) => {
        calls++; expect(url).toEndWith("/images/generations"); expect(init?.method).toBe("POST");
        if (response instanceof Error) throw response;
        return response;
      } })).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  test("pending results are not returned and terminal failure wins over any attached image", async () => {
    let calls = 0;
    try {
      await runApiMartImageTask({ ...base, upstreamTaskId: "task_saved" }, { sleep: async () => {}, fetch: async () => {
        calls++;
        return calls === 1 ? json({ ...completed, data: { ...completed.data, status: "processing" } })
          : json({ ...completed, data: { ...completed.data, status: "failed", error: { message: "Model rejected input" } } });
      } });
      throw new Error("Expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiMartImageProviderFailure);
      expect(String(error)).toContain("Model rejected input");
    }
    expect(calls).toBe(2);
  });

  test("cancelled provider tasks are explicit terminal failures", async () => {
    for (const status of ["cancelled", "canceled"]) {
      await expect(runApiMartImageTask({ ...base, upstreamTaskId: "task_saved" }, {
        sleep: async () => {}, fetch: async () => json({ data: { id: "task_saved", status } }),
      })).rejects.toBeInstanceOf(ApiMartImageProviderFailure);
    }
  });

  test("completed without output and query errors remain ambiguous errors without new POST", async () => {
    for (const response of [json({ data: { status: "completed", result: { images: [] } } }), json({ error: { message: "Unavailable" } }, 503)]) {
      let calls = 0;
      try {
        await runApiMartImageTask({ ...base, upstreamTaskId: "task_saved" }, { sleep: async () => {}, fetch: async (_url, init) => { calls++; expect(init?.method).not.toBe("POST"); return response.clone(); } });
        throw new Error("Expected ambiguous failure");
      } catch (error) {
        expect(error?.constructor.name).toBe("Error");
        expect(String(error)).not.toContain("Expected ambiguous failure");
      }
      expect(calls).toBe(response.status === 503 ? 3 : 1);
    }
  });

  test("image-purpose uploads accept 20 MiB while the video default still caps 10 MiB", async () => {
    const input = { baseUrl: base.baseUrl, apiKey: base.apiKey, bytes: new Uint8Array(20 * 1024 * 1024), mimeType: "image/png" };
    let calls = 0;
    const runtime = { fetch: async () => { calls++; return json({ url: publicReference }); } };
    expect(await uploadApiMartImage({ ...input, purpose: "image" }, runtime)).toBe(publicReference);
    await expect(uploadApiMartImage(input, runtime)).rejects.toThrow("10MB");
    await expect(uploadApiMartImage({ ...input, bytes: new Uint8Array(20 * 1024 * 1024 + 1), purpose: "image" }, runtime)).rejects.toThrow("20MB");
    expect(calls).toBe(1);
  });
});
