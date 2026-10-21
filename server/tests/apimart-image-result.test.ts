import { describe, expect, test } from "bun:test";
import { downloadApiMartImageResult } from "../src/apimart-image-result";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0VQAAAABJRU5ErkJggg==", "base64");

describe("APIMart existing image result download", () => {
  test("preserves binary bytes and actual MIME without forwarding authorization or a body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await downloadApiMartImageResult("https://result.example/image.webp", 1000, { fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(png, { headers: { "content-type": "image/webp" } });
    } });
    expect(result.bytes).toEqual(png);
    expect(result.mimeType).toBe("image/png");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(calls[0]!.init.headers).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
  test.each(["http://127.0.0.1/private", "https://user:secret@result.example/image", "file:///image.png", "data:image/png;base64,AA=="])("rejects unsafe result address before network: %s", async url => {
    let calls = 0;
    await expect(downloadApiMartImageResult(url, 1000, { fetch: async () => { calls++; return new Response(); } })).rejects.toMatchObject({ code: "PROVIDER_RESULT_URL_INVALID" });
    expect(calls).toBe(0);
  });
  test("expired results retain the HTTP diagnostic used to query the same upstream job", async () => {
    let calls = 0;
    await expect(downloadApiMartImageResult("https://result.example/expired", 1000, { fetch: async () => { calls++; return new Response("expired", { status: 403 }); } })).rejects.toMatchObject({ code: "RESULT_DOWNLOAD_HTTP_ERROR", httpStatus: 403 });
    expect(calls).toBe(1);
  });
  test("transport and truncated-body failures are propagated without another request", async () => {
    const failure = Object.assign(new Error("TLS rejected"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    let calls = 0;
    await expect(downloadApiMartImageResult("https://result.example/image", 1000, { fetch: async () => { calls++; throw failure; } })).rejects.toBe(failure);
    expect(calls).toBe(1);
    const interrupted = Object.assign(new Error("Interrupted"), { code: "PROVIDER_RESPONSE_STREAM_ERROR" });
    await expect(downloadApiMartImageResult("https://result.example/image", 1000, { fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(png.subarray(0, 8)); controller.error(interrupted); } }));
    } })).rejects.toBe(interrupted);
    expect(calls).toBe(2);
  });
});
