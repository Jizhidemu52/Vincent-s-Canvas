import { describe, expect, test } from "bun:test";
import { APIMART_VIDEO_IMAGE_MAX_BYTES, uploadApiMartImage } from "../src/apimart-upload";

const input = { baseUrl: "https://provider.example/v1/", apiKey: "test-secret", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("APIMart reference image upload", () => {
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
