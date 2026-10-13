import { describe, expect, spyOn, test } from "bun:test";
import { fetchProviderResult } from "../src/provider-result";
import { createGenerationTiming } from "../src/generation-timing";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0VQAAAABJRU5ErkJggg==";

describe("provider result materialization", () => {
  test.each([png, `data:image/png;base64,${png}`])("inline images are decoded without network or download timing", async value => {
    const records: Record<string, unknown>[] = [];
    const log = spyOn(console, "log").mockImplementation(line => { records.push(JSON.parse(line)); });
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("unexpected download"); }, { preconnect() {} }));
    try {
      const result = await fetchProviderResult(value, createGenerationTiming({ taskId: "inline-result", runtime: "worker" }));
      expect(result.mimeType).toBe("image/png");
      expect(result.bytes).toEqual(Buffer.from(png, "base64"));
      expect(network).not.toHaveBeenCalled();
      expect(records).toEqual([]);
    } finally { log.mockRestore(); network.mockRestore(); }
  });

  test("remote timing ends only after the complete original response body is read", async () => {
    const records: Record<string, unknown>[] = [];
    const log = spyOn(console, "log").mockImplementation(line => { records.push(JSON.parse(line)); });
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(stream, { headers: { "content-type": "image/webp; charset=binary" } }), { preconnect() {} }));
    try {
      const pending = fetchProviderResult("https://provider.test/image.webp", createGenerationTiming({ taskId: "remote-result", runtime: "worker" }));
      await Promise.resolve();
      expect(records.map(record => record.phase)).toEqual(["start"]);
      body.enqueue(new Uint8Array([0, 255, 2, 3]));
      body.close();
      expect(await pending).toEqual({ bytes: Buffer.from([0, 255, 2, 3]), mimeType: "image/webp" });
      expect(records.map(record => [record.stage, record.phase, record.status])).toEqual([["result_download", "start", undefined], ["result_download", "end", "success"]]);
      expect(network).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); network.mockRestore(); }
  });

  test("invalid inline images fail locally, without a download or resubmission", async () => {
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("unexpected download"); }, { preconnect() {} }));
    try {
      await expect(fetchProviderResult("data:image/png;base64,INVALID")).rejects.toThrow("Provider 返回了无法识别的内联图片");
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
