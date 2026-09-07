import { describe, expect, test } from "bun:test";
import { ObjectStorage } from "../src/object-storage";
import { loadConfig } from "../src/config";

const env = { DATABASE_URL: "postgres://unused", REDIS_URL: "redis://unused", S3_ENDPOINT: "http://minio:9000", S3_ACCESS_KEY_ID: "test-only-key", S3_SECRET_ACCESS_KEY: "test-only-secret", S3_BUCKET: "owned-assets" };
describe("public video source signing", () => {
  test("signs the public HTTPS endpoint while the internal storage endpoint stays private", async () => {
    const config = loadConfig({ ...env, S3_PUBLIC_ENDPOINT: "https://media.company.example" });
    const storage = new ObjectStorage(config);
    const url = new URL(await storage.signedDownloadUrl("users/owner/asset/clip.mp4", 1800));
    expect(config.S3_ENDPOINT).toBe("http://minio:9000");
    expect(url.origin).toBe("https://media.company.example");
    expect(url.pathname).toBe("/owned-assets/users/owner/asset/clip.mp4");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("1800");
    expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
  });

  test("refuses internal, HTTP and missing public endpoints before sharing a signed private URL", async () => {
    for (const publicEndpoint of ["", "http://media.company.example", "https://127.0.0.1", "https://minio.local"]) {
      const storage = new ObjectStorage(loadConfig({ ...env, S3_PUBLIC_ENDPOINT: publicEndpoint }));
      await expect(storage.signedDownloadUrl("users/owner/clip.mp4")).rejects.toThrow("S3_PUBLIC_ENDPOINT");
    }
    const storage = new ObjectStorage(loadConfig({ ...env, S3_ENDPOINT: "https://objects.company.example" }));
    expect(new URL(await storage.signedDownloadUrl("clip.mp4")).origin).toBe("https://objects.company.example");
  });
});
