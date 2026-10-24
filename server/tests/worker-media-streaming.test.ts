import { expect, test } from "bun:test";
import ts from "typescript";
import { disposeProviderResults } from "../src/media-result-file";
import { VideoTaskPending, VideoSubmissionClaimLost } from "../src/media-runtime";
import { ApiMartImageTaskPending } from "../src/apimart-image";
import { WorkflowTaskPending } from "../src/workflow-task-context";

const source = ts.createSourceFile("worker.ts", await Bun.file(new URL("../src/worker.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function functions(names: string[], dependencies: Record<string, unknown>) {
  const code = names.map(name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source)).join("\n");
  return new Function(...Object.keys(dependencies), `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return {${names.join(',')}}`)(...Object.values(dependencies));
}
const id = "30000000-0000-4000-8000-000000000001";

test("worker video/audio sources use streamed probes and metadata-only provider inputs; images retain one byte buffer", async () => {
  for (const mime of ["video/mp4", "audio/mpeg", "image/png"]) {
    let fullReads = 0, streamReads = 0, streamedProbes = 0;
    const bytes = new Uint8Array([1, 2, 3]);
    const api = functions(["loadVideoSourceAssets"], {
      db: { query: async (sql: string, parameters: unknown[]) => {
        expect(parameters).toEqual([id, "owner"]); expect(sql).toContain("owner_user_id=$2"); expect(sql).toContain("deleted_at IS NULL"); expect(sql).toContain("status='ready'");
        return { rows: [{ object_key: "owned/source", mime_type: mime, byte_size: 3 }] };
      } },
      storage: { get: async () => ({ Body: { transformToByteArray: async () => { fullReads++; return bytes; }, transformToWebStream: () => { streamReads++; return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); } } }), signedDownloadUrl: async () => "https://owned.example/source" },
      probeMediaBytes: async (actual: Uint8Array) => { expect(actual).toBe(bytes); return { width: 768, height: 768 }; },
      probeMediaStream: async (stream: ReadableStream, type: string, size: number) => { streamedProbes++; expect(type).toBe(mime); expect(size).toBe(3); expect(await new Response(stream).arrayBuffer()).toEqual(bytes.buffer); return { durationMs: 5000, fps: 24 }; },
    });
    const [result] = await api.loadVideoSourceAssets([`/api/assets/${id}/content`], "owner");
    const image = mime.startsWith("image/");
    expect(fullReads).toBe(image ? 1 : 0); expect(streamReads).toBe(image ? 0 : 1); expect(streamedProbes).toBe(image ? 0 : 1);
    expect(result.bytes.byteLength).toBe(image ? 3 : 0); expect(result.byteSize).toBe(3);
    expect(result.publicUrl).toBe(image ? undefined : "https://owned.example/source");
  }
});

test("known upstream video only polls and returns a file owner without reloading reference media", async () => {
  let loaded = 0, downloads = 0;
  const file = { filePath: "fixture-only", byteSize: 9, mimeType: "video/mp4", dispose: async () => {} };
  const api = functions(["executeApiMartVideo"], {
    storage: { configured: true }, loadVideoSourceAssets: async () => { loaded++; throw new Error("must not load"); }, VideoTaskPending,
    stepApiMartVideoTask: async (input: Record<string, unknown>) => { expect(input.sources).toEqual([]); expect(input.upstreamTaskId).toBe("original"); return { status: "completed", url: "https://provider.invalid/result.mp4" }; },
    downloadVideoResult: async () => { downloads++; return file; },
  });
  expect(await api.executeApiMartVideo({ upstream_task_id: "original", upstream_submission_started_at: "started", parameters: {} }, {})).toEqual([file]);
  expect(loaded).toBe(0); expect(downloads).toBe(1);
});

test.each(["stored", "store-failed", "lease-lost"])("worker disposes generated video file after %s without replaying paid work", async outcome => {
  class TaskExecutionLost extends Error {}
  let disposed = 0, paid = 0, captures = 0, stored = 0;
  const statements: string[] = [];
  const task = { id: "task", request_id: "request", attempts: 1, operation_type: "video_generation", batch_id: null, upstream_submission_started_at: "started" };
  const db = { query: async (sql: string) => { statements.push(sql); return { rows: [task] }; } };
  const api = functions(["runTask"], {
    disposeProviderResults, db, cache: {}, randomUUID: () => "token", TASK_LEASE_SECONDS: 180, config: { TASK_MOCK_MODE: "false" },
    acquireModelLease: async () => ({}), releaseModelLease: async () => {},
    startTaskLeaseHeartbeat: () => ({ assertOwned() { if (paid && outcome === "lease-lost") throw new TaskExecutionLost("fixture lost lease"); }, stop: async () => {} }),
    createGenerationTiming: () => ({ measure: async (_stage: string, action: () => unknown) => action(), finish() {} }),
    executeProvider: async () => { paid++; return [{ filePath: "fixture-only", byteSize: 5, mimeType: "video/mp4", dispose: async () => { disposed++; } }]; },
    assertTaskExecution: async () => {}, storeResults: async () => { stored++; if (outcome === "store-failed") throw new Error("fixture storage failure"); return ["owned/result"]; },
    withTransaction: async (_db: unknown, action: (client: unknown) => unknown) => action(db), settleReservation: async (_db: unknown, _request: string, action: string) => { expect(action).toBe("capture"); captures++; },
    VideoTaskPending, ApiMartImageTaskPending, WorkflowTaskPending, VideoSubmissionClaimLost, TaskExecutionLost, readProviderSubmissionDiagnostics: () => undefined,
  });
  await api.runTask(task.id);
  expect(paid).toBe(1); expect(disposed).toBe(1); expect(captures).toBe(outcome === "stored" ? 1 : 0); expect(stored).toBe(outcome === "lease-lost" ? 0 : 1);
  expect(statements.some(sql => sql.includes("status='failed'"))).toBe(false);
  expect(statements.some(sql => sql.includes("status='paused'"))).toBe(outcome === "store-failed");
});

test("worker stores video via file upload with the streamed byte count", async () => {
  let writes = 0;
  const api = functions(["saveResultAsset"], {
    assertTaskExecution: async () => {}, randomUUID: () => id,
    storage: { put: async () => { throw new Error("must not buffer video"); }, putFile: async (_key: string, path: string, size: number, mime: string) => { writes++; expect([path, size, mime]).toEqual(["fixture-path", 1234, "video/mp4"]); } },
    classifyDesignDirection: () => ({ primaryDirection: "other", secondaryDirections: [], ruleVersion: 1, evidence: [] }),
    db: { query: async (_sql: string, values: unknown[]) => { expect(values[8]).toBe(1234); return { rows: [{ id }] }; } },
  });
  expect(await api.saveResultAsset({ id: "task", user_id: "owner", parameters: {} }, 0, { filePath: "fixture-path", byteSize: 1234, mimeType: "video/mp4" }, "primary", {})).toMatchObject({ assetId: id, mimeType: "video/mp4" });
  expect(writes).toBe(1);
});
