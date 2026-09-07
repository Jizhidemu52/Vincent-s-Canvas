import { describe, expect, test } from "bun:test";
import { preflightStoredVideoTask } from "../src/stored-video-preflight";
import { enqueueTask, type TaskInput } from "../src/tasks";

const assetId = "30000000-0000-4000-8000-000000000001";
const input: TaskInput = { requestId: "test-video-request", userId: "owner", departmentId: null, projectId: "canvas", operationType: "video_generation", modelConfigId: "model", prompt: "继续视频", parameters: { videoMode: "extend" }, sourceUrls: [`/api/assets/${assetId}/content`], priority: "normal" };
const video = { id: assetId, objectKey: "owned/video.mp4", mimeType: "video/mp4", byteSize: 1024, metadata: { durationMs: 5000, width: 1280, height: 720 } };

function database(model: string, asset: Record<string, unknown> | null) {
  const sql: string[] = [];
  const client = {
    query: async (statement: string, parameters: unknown[] = []) => {
      sql.push(statement);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) return { rows: [] };
      if (statement.includes("INSERT INTO tasks")) return { rows: [{ id: "pending-task" }] };
      if (statement.includes("FROM model_configs")) return { rows: [{ modelId: model }] };
      if (statement.includes("FROM assets")) {
        expect(parameters).toEqual([assetId, "owner"]);
        expect(statement).toContain("owner_user_id=$2");
        expect(statement).toContain("status='ready'");
        return { rows: asset ? [asset] : [] };
      }
      throw new Error(`Unexpected side effect after video validation: ${statement}`);
    },
    release() {},
  };
  return { db: { ...client, connect: async () => client }, sql };
}

describe("stored video task preflight", () => {
  test("uses owned stored MIME, actual byte count and metadata; edit exposes the upstream deposit duration", async () => {
    const { db, sql } = database("doubao-seedance-2.5", video);
    const checked = await preflightStoredVideoTask(db as never, { ...input, parameters: { videoMode: "edit", size: "16:9", seconds: 5 } }, "https://media.company.example", {
      readSource: async (key) => { expect(key).toBe(video.objectKey); return new Uint8Array(video.byteSize); },
      probe: async () => ({ durationMs: 6000, width: 1280, height: 720, fps: 24 }),
    });
    expect(checked.normalized).toMatchObject({ videoMode: "edit", seconds: -1, size: "adaptive", upstreamBillingSeconds: 36 });
    expect(sql.every((statement) => statement.startsWith("SELECT"))).toBe(true);
  });

  test("cannot substitute a metadata URL for a missing public endpoint or bypass ownership", async () => {
    const fake = database("wan2.7", { ...video, metadata: { ...video.metadata, upstreamUrl: "https://attacker.example/video.mp4" } });
    await expect(preflightStoredVideoTask(fake.db as never, input, "http://minio:9000")).rejects.toThrow("S3_PUBLIC_ENDPOINT");
    const unowned = database("wan2.7", null);
    await expect(preflightStoredVideoTask(unowned.db as never, input, "https://media.company.example")).rejects.toThrow("无权访问");
    expect(fake.sql.some((statement) => /INSERT|UPDATE/.test(statement))).toBe(false);
  });

  test("known stored oversize, duration and dimensions fail without uploading bytes", async () => {
    for (const invalid of [
      { ...video, byteSize: 100 * 1024 * 1024 + 1 },
      { ...video, metadata: { durationMs: 11000 } },
      { ...video, metadata: { durationMs: 5000, width: 10000 } },
      { ...video, mimeType: "video/webm" },
    ]) {
      const { db } = database("wan2.7", invalid);
      await expect(preflightStoredVideoTask(db as never, input, "https://media.company.example")).rejects.toThrow();
    }
  });

  test("direct enqueue cannot bypass the same validation to reserve credits or add a queue item", async () => {
    const { db, sql } = database("MiniMax-H3", { ...video, mimeType: "image/png", byteSize: 10 * 1024 * 1024 + 1 });
    let queues = 0;
    const cache = { zAdd: async () => { queues++; return 1; } };
    const badInput = { ...input, parameters: { videoMode: "first-frame" } };
    await expect(enqueueTask(db as never, cache as never, badInput)).rejects.toThrow("10MB");
    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(sql.some((statement) => /credit_reservations|pricing_rule_versions|credit_ledger/.test(statement))).toBe(false);
    expect(queues).toBe(0);
  });

  test("missing or fabricated metadata cannot hide an invalid real duration or frame rate", async () => {
    for (const metadata of [{}, { durationMs: 2000, width: 1280, height: 720, fps: 24 }]) {
      for (const actual of [{ durationMs: 16000, width: 1280, height: 720, fps: 24 }, { durationMs: 5000, width: 1280, height: 720, fps: 12 }]) {
        const { db } = database("MiniMax-H3", { ...video, metadata });
        await expect(preflightStoredVideoTask(db as never, { ...input, parameters: { videoMode: "reference" } }, "https://media.company.example", {
          readSource: async () => new Uint8Array(video.byteSize), probe: async () => actual,
        })).rejects.toThrow();
      }
    }
  });
});
