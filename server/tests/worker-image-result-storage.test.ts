import { expect, test } from "bun:test";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { imageResultExtension, storeImageResult } from "../src/image-result-storage";
import { prepareImageEditInput } from "../src/image-edit-input";
import { ApiMartImageTaskPending } from "../src/apimart-image";
import { WorkflowTaskPending } from "../src/workflow-task-context";
import { resolveImageResultVariants, type ImageResultAsset } from "../src/image-result-variants";
import { disposeProviderResults } from "../src/media-result-file";

const file = new URL("../src/worker.ts", import.meta.url);
const source = ts.createSourceFile(file.pathname, await Bun.file(file).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(name: string) {
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing production declaration: ${name}`);
  return node.getText(source);
}
function functions(names: string[], dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(names.map(declaration).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn { ${names.join(",")} };`)(...Object.values(dependencies));
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const task = { id: randomUUID(), user_id: "owner", request_id: randomUUID(), protocol: "openai", model_id: "gpt-image-2.5-flare", operation_type: "inpaint", project_id: "project", source_urls: ["source", "mask"], parameters: { output_format: "webp", output_compression: 80, inputArchive: { maskReferenceIndex: 1 } } };

test("Worker stores raw before mask loading, yields one strict result and real webp auxiliary with stable keys", async () => {
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const assets: Array<ImageResultAsset & { key: string }> = [];
  const events: unknown[] = [];
  const api = functions(["storeResults", "saveResultAsset"], {
    scheduleAssetThumbnails: () => {}, assertTaskExecution: async () => {},
    randomUUID, imageResultExtension, storeImageResult, prepareImageEditInput,
    classifyDesignDirection: () => ({ primaryDirection: "other", secondaryDirections: [], ruleVersion: 1, evidence: [] }),
    recordAssetEvent: async (_db: unknown, event: unknown) => { events.push(event); },
    loadSourceAssets: async () => {
      expect(assets).toHaveLength(1);
      expect(objects.get(assets[0]!.key)!.bytes).toEqual(png);
      return [{ bytes: png, mimeType: "image/png" }, { bytes: png, mimeType: "image/png" }];
    },
    storage: { configured: true, put: async (key: string, bytes: Uint8Array, mimeType: string) => { objects.set(key, { bytes, mimeType }); } },
    db: { query: async (sql: string, values: any[]) => {
      if (sql.startsWith("INSERT INTO assets")) {
        const existing = assets.find(item => item.key === values[5]);
        const asset = { id: existing?.id || values[0], ownerUserId: values[1], taskId: values[4], key: values[5], filename: values[6], mimeType: values[7], metadata: JSON.parse(values[18]) };
        if (existing) Object.assign(existing, asset); else assets.push(asset);
        return { rows: [{ id: asset.id }] };
      }
      if (sql.startsWith("UPDATE assets SET metadata")) { assets.find(item => item.id === values[1])!.metadata = JSON.parse(values[0]); return { rows: [] }; }
      throw new Error("Unexpected query");
    } },
  });
  const urls = await api.storeResults(task, [{ bytes: png, mimeType: "image/png" }]);
  expect(urls).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(objects.size).toBe(3);
  const primary = assets.find(item => urls[0] === `/api/assets/${item.id}/content`)!;
  const variants = resolveImageResultVariants(primary, assets);
  expect(variants).toMatchObject({ primary: { mimeType: "image/png" }, original: { mimeType: "image/png" }, export: { mimeType: "image/webp" }, maskComposited: true });
  const exported = assets.find(item => item.id === variants.export!.assetId)!;
  expect(exported.filename).toEndWith("-export.webp");
  expect(Buffer.from(objects.get(exported.key)!.bytes).toString("ascii", 8, 12)).toBe("WEBP");
  expect(objects.get(assets[0]!.key)!.bytes).toEqual(png);
}, 15_000);

test("Worker pauses an opaque transparent-background result without refund or paid queue replay", async () => {
  const queries: string[] = [];
  const failureReasons: string[] = [];
  const originals: Uint8Array[] = [];
  const transparentTask = { ...task, source_urls: [], parameters: { background: "transparent" } };
  let paid = 0, refunds = 0, queued = 0;
  class VideoSubmissionClaimLost extends Error {}
  class VideoTaskPending extends Error {}
  class TaskExecutionLost extends Error {}
  const api = functions(["runTask"], {
    disposeProviderResults,
    randomUUID, TASK_LEASE_SECONDS: 180, config: { TASK_MOCK_MODE: "false" }, VideoSubmissionClaimLost, VideoTaskPending, ApiMartImageTaskPending, WorkflowTaskPending, TaskExecutionLost,
    db: { query: async (sql: string, values: any[]) => {
      queries.push(sql);
      if (sql.includes("status='paused'")) failureReasons.push(values[0]);
      return { rows: [transparentTask] };
    } },
    cache: { incr: async () => 1, expire: async () => {}, decr: async () => {}, zAdd: async () => { queued++; } },
    createGenerationTiming: () => ({ measure: async (_stage: string, call: () => unknown) => call(), finish: () => {} }),
    acquireModelLease: async () => ({ slotToken: "fixture-slot" }), releaseModelLease: async () => {},
    startTaskLeaseHeartbeat: () => ({ assertOwned() {}, stop: async () => {} }), assertTaskExecution: async () => {}, readProviderSubmissionDiagnostics: () => undefined,
    executeProvider: async () => { paid++; return [{ bytes: png, mimeType: "image/png" }]; },
    storeResults: async (current: typeof transparentTask, results: Array<{ bytes: Uint8Array; mimeType: string }>) => storeImageResult({
      result: results[0]!, parameters: current.parameters, resultIndex: 0,
      save: async (role, image) => {
        expect(role).toBe("provider-original"); originals.push(image.bytes);
        return { assetId: randomUUID(), mimeType: image.mimeType, filename: "provider-original.png" };
      },
      updateMetadata: async () => { throw new Error("failed transparency validation cannot mark the original as primary"); },
    }),
    settleReservation: async () => { refunds++; },
  });
  await api.runTask(task.id);
  expect(paid).toBe(1);
  expect(refunds).toBe(0);
  expect(queued).toBe(0);
  expect(queries.some(sql => sql.includes("status='paused'"))).toBe(true);
  expect(queries.some(sql => sql.includes("status='failed'"))).toBe(false);
  expect(originals).toEqual([png]);
  expect(failureReasons).toHaveLength(1);
  expect(failureReasons[0]).toContain("渠道原件已保存");
  expect(failureReasons[0]).toContain("所有像素均不透明");
});
