import { describe, expect, spyOn, test } from "bun:test";
import { APIMART_VIDEO_IMAGE_MAX_BYTES, uploadApiMartImage } from "../src/apimart-upload";
import { runApiMartImageTask } from "../src/apimart-image";
import { imageTaskFailureDetail } from "../src/image-task-diagnostics";
import * as providerTransport from "../src/provider-submission-transport";

const input = { baseUrl: "https://provider.example/v1/", apiKey: "test-secret", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("APIMart reference image upload", () => {
  test("defaults to the native submission transport without falling back to Bun fetch", async () => {
    const plainFetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Bun fetch must not upload provider references"));
    const timeout = spyOn(AbortSignal, "timeout");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const nativeFetch = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init });
      return json({ url: "https://cdn.example/uploaded.png", filename: "reference.png", content_type: "image/png", bytes: input.bytes.length });
    });
    try {
      for (const purpose of ["image", "video"] as const) {
        expect(await uploadApiMartImage({ ...input, purpose })).toBe("https://cdn.example/uploaded.png");
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe("https://provider.example/v1/uploads/images");
        expect(request.init.method).toBe("POST");
        expect(request.init.redirect).toBe("error");
        expect(request.init.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer test-secret");
        expect(new Headers(request.init.headers).has("content-type")).toBe(false);
        const form = request.init.body as FormData;
        expect(Array.from(form.keys())).toEqual(["file"]);
        const file = form.get("file") as File;
        expect(file.name).toBe("reference.png");
        expect(file.type).toBe("image/png");
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(input.bytes);
      }
      expect(timeout.mock.calls).toEqual([[180_000], [180_000]]);
      expect(plainFetch).not.toHaveBeenCalled();
    } finally {
      nativeFetch.mockRestore();
      timeout.mockRestore();
      plainFetch.mockRestore();
    }
  });

  test.each(["gpt-image-2.5-flare", "gemini-nano-banana-2.1"])("an upload reset for %s reports that generation never started and retains transport evidence", async (modelId) => {
    const plainFetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Bun fallback is forbidden"));
    const failure = Object.assign(new Error("socket hang up（请求已发出，结果待核查，不会自动重新提交）"), {
      code: "ECONNRESET", phase: "http_started", attempts: 1,
      connectionAttempts: [{ code: "ECONNRESET", phase: "http_started", attempt: 1, connectMs: 118.88, elapsedMs: 60109.16 }],
      headers: { authorization: "Bearer private-key" }, url: "https://provider.example/private?key=secret",
    });
    const requests: string[] = [];
    const nativeFetch = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async (url) => {
      requests.push(String(url));
      throw failure;
    });
    let submissionStarted = false;
    let upstreamTaskId: string | null = null;
    try {
      const error = await runApiMartImageTask({
        baseUrl: input.baseUrl, apiKey: input.apiKey, modelId, prompt: "Local upload failure fixture", parameters: {},
        sourceDataUrls: ["data:image/png;base64,AQID"],
        beforeSubmit: () => { submissionStarted = true; },
        onSubmitted: (id) => { upstreamTaskId = id; },
      }, { sleep: async () => {} }).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("APIMart 参考图上传连接中断，尚未提交图片生成");
      expect(error.message).not.toMatch(/结果待核查|请求已发出|private|secret/);
      expect(error.cause).toBe(failure);
      expect(providerTransport.readProviderSubmissionDiagnostics(error)).toEqual({
        code: "ECONNRESET", phase: "http_started", attempts: 1,
        connectionAttempts: [{ code: "ECONNRESET", phase: "http_started", attempt: 1, connectMs: 118.88, elapsedMs: 60109.16 }],
      });
      expect(imageTaskFailureDetail(error, "preflight")).toEqual({ phase: "preflight", code: "ECONNRESET" });
      expect(error.headers).toBeUndefined();
      expect(error.url).toBeUndefined();
      expect(requests).toEqual(["https://provider.example/v1/uploads/images"]);
      expect(submissionStarted).toBe(false);
      expect(upstreamTaskId).toBeNull();
      expect(plainFetch).not.toHaveBeenCalled();
    } finally {
      nativeFetch.mockRestore();
      plainFetch.mockRestore();
    }
  });

  test("an interrupted upload response remains pre-generation and preserves its transport cause", async () => {
    const failure = Object.assign(new Error("Provider response stream was interrupted; the original submission will not be replayed"), {
      code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1,
    });
    const requests: string[] = [];
    let claimed = false;
    const error = await runApiMartImageTask({
      baseUrl: input.baseUrl, apiKey: input.apiKey, modelId: "gpt-image-2.5-flare", prompt: "edit", parameters: {},
      sourceDataUrls: ["data:image/png;base64,AQID"], beforeSubmit: () => { claimed = true; },
    }, { fetch: async url => {
      requests.push(url);
      return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    } }).catch(caught => caught);
    expect(error.message).toBe("APIMart 参考图上传连接中断，尚未提交图片生成");
    expect(error.cause).toBe(failure);
    expect(providerTransport.readProviderSubmissionDiagnostics(error)).toEqual({ code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1 });
    expect(claimed).toBe(false);
    expect(requests).toEqual(["https://provider.example/v1/uploads/images"]);
  });

  test("a generation POST failure keeps its uncertain-submission warning after a successful upload", async () => {
    const failure = Object.assign(new Error("socket hang up（请求已发出，结果待核查，不会自动重新提交）"), {
      code: "ECONNRESET", phase: "http_started", attempts: 1,
    });
    const requests: string[] = [];
    let claimed = false;
    const error = await runApiMartImageTask({
      baseUrl: input.baseUrl, apiKey: input.apiKey, modelId: "gpt-image-2.5-flare", prompt: "edit", parameters: {},
      sourceDataUrls: ["data:image/png;base64,AQID"], beforeSubmit: () => { claimed = true; },
    }, { fetch: async url => {
      requests.push(url);
      if (url.endsWith("/uploads/images")) return json({ url: "https://cdn.example/reference.png" });
      throw failure;
    } }).catch(caught => caught);
    expect(error).toBe(failure);
    expect(error.message).toContain("结果待核查，不会自动重新提交");
    expect(error.message).not.toContain("尚未提交图片生成");
    expect(claimed).toBe(true);
    expect(requests).toEqual(["https://provider.example/v1/uploads/images", "https://provider.example/v1/images/generations"]);
  });

  test("uploads a multipart file to the configured provider and returns its HTTPS URL", async () => {
    let calls = 0;
    const result = await uploadApiMartImage({ ...input, filename: "C:\\private\\reference.png" }, { fetch: async (url, init) => {
      calls++;
      expect(url).toBe("https://provider.example/v1/uploads/images");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret");
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeInstanceOf(FormData);
      const file = (init?.body as FormData).get("file") as File;
      expect(file).toBeInstanceOf(Blob);
      expect(file.name).toBe("reference.png");
      expect(file.type).toBe("image/png");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(input.bytes);
      expect(Array.from((init?.body as FormData).keys())).toEqual(["file"]);
      return json({ url: "https://cdn.example/uploaded.png", bytes: 3, filename: file.name, content_type: file.type });
    } });
    expect(result).toBe("https://cdn.example/uploaded.png");
    expect(calls).toBe(1);
  });

  test("rejects unsupported or oversized input before sending any image or key", async () => {
    for (const extra of [{ apiKey: "" }, { bytes: new Uint8Array() }, { bytes: new Uint8Array(APIMART_VIDEO_IMAGE_MAX_BYTES + 1) }, { mimeType: "image/svg+xml" }, { mimeType: "image/bmp" }, { mimeType: "application/octet-stream" }]) {
      let calls = 0;
      await expect(uploadApiMartImage({ ...input, ...extra }, { fetch: async () => { calls++; return json({}); } })).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });

  test("uses the matching default extension for every supported format", async () => {
    for (const [mimeType, extension] of [["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["image/gif", "gif"]]) {
      await uploadApiMartImage({ ...input, mimeType }, { fetch: async (_url, init) => {
        const file = (init?.body as FormData).get("file") as File;
        expect(file.type).toBe(mimeType);
        expect(file.name).toBe(`reference.${extension}`);
        return json({ url: `https://cdn.example/image.${extension}` });
      } });
    }
  });

  test("reports a failed upload without exposing provider bodies or secrets", async () => {
    try {
      await uploadApiMartImage(input, { fetch: async () => json({ error: input.apiKey, image: "data:image/png;base64,sensitive" }, 503) });
      throw new Error("Expected upload failure");
    } catch (error) {
      expect(String(error)).toContain("503");
      expect(String(error)).toContain("尚未提交视频生成");
      expect(String(error)).not.toContain(input.apiKey);
      expect(String(error)).not.toContain("sensitive");
    }
  });

  test("does not accept missing, insecure or private uploaded URLs", async () => {
    for (const url of [undefined, 42, "data:image/png;base64,abc", "http://cdn.example/image.png", "https://localhost/image.png", "https://private.lan/image.png", "https://127.0.0.1/image.png", "https://10.0.0.2/image.png", "https://172.16.0.2/image.png", "https://192.168.0.2/image.png", "https://169.254.169.254/image.png", "https://[::1]/image.png", "https://[fc00::1]/image.png", "https://[::ffff:127.0.0.1]/image.png", "https://user:password@cdn.example/image.png"]) {
      await expect(uploadApiMartImage(input, { fetch: async () => json({ url }) })).rejects.toThrow("公开 HTTPS");
    }
    await expect(uploadApiMartImage(input, { fetch: async () => new Response("invalid JSON") })).rejects.toThrow("公开 HTTPS");
  });
});
