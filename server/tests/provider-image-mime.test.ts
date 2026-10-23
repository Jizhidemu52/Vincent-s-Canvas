import { describe, expect, spyOn, test } from "bun:test";
import { runOpenTokenImage } from "../src/opentoken-image";
import { fetchProviderResult } from "../src/provider-result";
import { decodeInlineImageResult } from "../src/demo-task-result-assets";

// Complete tiny image files, not just format signatures. Expected MIME values
// are independent of the production detector, and every path preserves bytes.
const images = [
  { mime: "image/png", declared: "image/jpeg", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=" },
  { mime: "image/jpeg", declared: "image/png", base64: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAf/2Q==" },
  { mime: "image/webp", declared: "image/png", base64: "UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=" },
] as const;

describe("provider image MIME follows actual bytes", () => {
  for (const fixture of images) {
    const bytes = Buffer.from(fixture.base64, "base64");
    const wrongDataUrl = `data:${fixture.declared};base64,${fixture.base64}`;
    const expectedDataUrl = `data:${fixture.mime};base64,${fixture.base64}`;

    test(`OpenToken inline ${fixture.mime} overrides requested output format without re-encoding`, async () => {
      const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ data: [{ b64_json: fixture.base64 }] }), { preconnect() {} }));
      try {
        const result = await runOpenTokenImage({ baseUrl: "http://provider.invalid/v1", apiKey: "unit-test", prompt: "test", output_format: fixture.declared === "image/jpeg" ? "jpeg" : "png" });
        expect(result).toBe(expectedDataUrl);
        expect(Buffer.from(result.split(",")[1]!, "base64")).toEqual(bytes);
        expect(network).toHaveBeenCalledTimes(1);
      } finally { network.mockRestore(); }
    });

    test(`OpenToken downloaded ${fixture.mime} overrides an incorrect response header`, async () => {
      const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: string | URL | Request) => {
        if (String(url) === "http://provider.invalid/v1/images/generations") return Response.json({ data: [{ url: "http://result.invalid/image.png" }] });
        if (String(url) === "http://result.invalid/image.png") return new Response(bytes, { headers: { "content-type": fixture.declared } });
        throw new Error("Unexpected network request");
      }, { preconnect() {} }));
      try {
        expect(await runOpenTokenImage({ baseUrl: "http://provider.invalid/v1", apiKey: "unit-test", prompt: "test" })).toBe(expectedDataUrl);
        expect(network).toHaveBeenCalledTimes(2);
      } finally { network.mockRestore(); }
    });

    test(`Worker result materialization corrects inline ${fixture.mime} without network`, async () => {
      const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("Unexpected network request"); }, { preconnect() {} }));
      try {
        expect(await fetchProviderResult(wrongDataUrl)).toEqual({ mimeType: fixture.mime, bytes });
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }
    });

    test(`Worker result download corrects ${fixture.mime} while retaining original bytes`, async () => {
      const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(bytes, { headers: { "content-type": fixture.declared } }), { preconnect() {} }));
      try {
        expect(await fetchProviderResult("http://result.invalid/image.png")).toEqual({ mimeType: fixture.mime, bytes });
        expect(network).toHaveBeenCalledTimes(1);
      } finally { network.mockRestore(); }
    });

    test(`Demo asset decoding corrects ${fixture.mime} while retaining original bytes`, () => {
      expect(decodeInlineImageResult(wrongDataUrl)).toEqual({ mimeType: fixture.mime, bytes: new Uint8Array(bytes) });
    });
  }

  test("Gemini's formatless base64 JPEG result is not mislabeled PNG", async () => {
    const fixture = images[1]!;
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ data: [{ b64_json: fixture.base64 }] }), { preconnect() {} }));
    try {
      const result = await runOpenTokenImage({ baseUrl: "http://provider.invalid/v1", apiKey: "unit-test", modelId: "gemini-3.1-flash-image", prompt: "test" });
      expect(result).toBe(`data:image/jpeg;base64,${fixture.base64}`);
      expect(decodeInlineImageResult(result)?.bytes).toEqual(new Uint8Array(Buffer.from(fixture.base64, "base64")));
      expect(network).toHaveBeenCalledTimes(1);
    } finally { network.mockRestore(); }
  });

  test("Flare returning PNG despite a WebP request remains PNG without conversion", async () => {
    const fixture = images[0]!;
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ data: [{ b64_json: fixture.base64 }] }), { preconnect() {} }));
    try {
      const result = await runOpenTokenImage({ baseUrl: "http://provider.invalid/v1", apiKey: "unit-test", modelId: "gpt-image-2.5-flare", prompt: "test", output_format: "webp", output_compression: 95 });
      expect(result).toBe(`data:image/png;base64,${fixture.base64}`);
      expect(decodeInlineImageResult(result)?.bytes).toEqual(new Uint8Array(Buffer.from(fixture.base64, "base64")));
      expect(network).toHaveBeenCalledTimes(1);
    } finally { network.mockRestore(); }
  });
});
