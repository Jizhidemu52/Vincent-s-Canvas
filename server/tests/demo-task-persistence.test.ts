import { expect, test } from "bun:test";
import ts from "typescript";
import { DemoStateStore, DemoStorageError, demoAssetFields, materializeDemoAsset } from "../src/demo-state-store";
import { decodeInlineImageResult } from "../src/demo-task-result-assets";
import { imageResultExtension, ImageResultPersistenceError, storeImageResult } from "../src/image-result-storage";
import { resolveImageResultVariants } from "../src/image-result-variants";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const file = new URL("../src/demo-server.ts", import.meta.url);
const source = ts.createSourceFile(file.pathname, await Bun.file(file).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["saveDemoAsset", "cacheStoredDemoAsset", "saveDemoAssetMetadata", "updateDemoTask", "pauseDemoTaskForStorageFailure", "finishDemoTaskFailure", "completeDemoImageTask", "runVideoTask", "recoverVideoTask", "classifyVideoTaskError", "callInternalAiSeamless", "downloadApiMartImage"];
const code = ts.transpileModule(names.map((name) => {
  const node = source.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing production declaration: ${name}`);
  return node.getText(source);
}).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(options: { path?: string; process?: Parameters<typeof storeImageResult>[0]["process"] } = {}) {
  const demoState = new DemoStateStore<any, any>(options.path || ":memory:");
  const demoAssets = new Map();
  const demoTasks = new Map();
  const user = { id: "owner", creditBalance: 10 };
  class DemoVideoTerminalError extends Error {}
  let submissions = 0;
  const downloads: string[] = [];
  const deps = {
    demoState, demoAssets, demoDeletedAssets: new Map(), demoTasks, DemoStorageError, demoAssetFields, decodeInlineImageResult,
    scheduleDemoAssetThumbnails: (asset: { id: string }) => {
      // Derived previews must never be scheduled before their original is durable.
      expect(demoState.load().assets.some((saved) => saved.id === asset.id)).toBe(true);
    },
    storeImageResult: (input: Parameters<typeof storeImageResult>[0]) => storeImageResult({ ...input, ...(options.process ? { process: options.process } : {}) }),
    ImageResultPersistenceError, imageResultExtension,
    now: () => new Date().toISOString(), console: { error() {} },
    demoAccounts: [{ user }], demoOwner: (id: string) => id === user.id ? user : undefined, DemoVideoTerminalError,
    internalAiConfig: { seamlessUrl: "http://seamless.invalid/generate", appKey: "test-only" },
    resolveDemoVideoProvider: () => ({ baseUrl: "https://video-fixture.invalid/v1", apiKey: "fixture-only" }),
    fetch: async (url: string) => {
      if (url === "http://seamless.invalid/generate") return Response.json({ data: { data: { list: ["https://result.invalid/temporary.png"] } } });
      if (url === "https://result.invalid/temporary.png") {
        downloads.push(url);
        return new Response(new Uint8Array([0, 255, 1, 2]), { headers: { "content-type": "image/png" } });
      }
      throw new Error("Unexpected network request");
    },
    callVideoProvider: async (_model: unknown, _prompt: unknown, _parameters: unknown, _sources: unknown, provider: unknown, submitted: (id: string) => void, starting: () => void) => {
      expect(provider).toEqual({ baseUrl: "https://video-fixture.invalid/v1", apiKey: "fixture-only" });
      starting(); submissions++; submitted("upstream-existing"); throw new Error("status check failed");
    },
    pollVideoProviderTask: async () => { throw new DemoVideoTerminalError("provider terminal failure"); },
  };
  const api = new Function(...Object.keys(deps), `${code}\nreturn { saveDemoAsset, updateDemoTask, finishDemoTaskFailure, completeDemoImageTask, runVideoTask, recoverVideoTask, callInternalAiSeamless };`)(...Object.values(deps));
  const task = { id: "task", requestId: "request", ownerUserId: "owner", status: "processing", operationType: "image_generation", resultUrls: [], credits: 3, parameters: {} as Record<string, unknown> };
  api.updateDemoTask(task, {});
  return { api, demoState, demoTasks, demoAssets, user, task, downloads, submissions: () => submissions };
}

test("remote seamless output is downloaded and saved as original bytes, not an expiring URL", async () => {
  const h = harness();
  try {
    const result = await h.api.callInternalAiSeamless(h.task, { bytes: new Uint8Array([1]) }, {});
    await h.api.completeDemoImageTask(h.task, h.user.id, result);
    expect(h.downloads).toEqual(["https://result.invalid/temporary.png"]);
    expect(h.demoState.load().assets[0].bytes).toEqual(new Uint8Array([0, 255, 1, 2]));
    expect(h.demoState.load().tasks[0].resultUrls[0]).toStartWith("/api/assets/");
  } finally { h.demoState.close(); }
});

test("empty, invalid and undownloaded image output cannot become a successful task", async () => {
  const h = harness();
  try {
    for (const result of ["", "data:image/png;base64,", "data:text/plain;base64,AQID", "https://result.invalid/unpersisted.png"]) {
      await expect(h.api.completeDemoImageTask(h.task, h.user.id, result)).rejects.toThrow("图片结果为空或格式无效");
      expect(h.demoState.load().tasks[0].status).toBe("processing");
      expect(h.demoState.load().assets).toHaveLength(0);
    }
  } finally { h.demoState.close(); }
});

test("image result bytes are persisted before the completed task is published", async () => {
  const h = harness();
  try {
    await h.api.completeDemoImageTask(h.task, h.user.id, "data:image/png;base64,AP8BAg==");
    const state = h.demoState.load();
    expect(state.assets[0].bytes).toEqual(new Uint8Array([0, 255, 1, 2]));
    expect(state.tasks[0]).toMatchObject({ status: "success", resultUrls: [`/api/assets/${state.assets[0].id}/content`] });
    expect(h.demoTasks.get(h.task.id)).toBe(h.task);
    expect(h.task.status).toBe("success");
  } finally { h.demoState.close(); }
});

test("storage failure never claims task completion or turns into a provider refund", async () => {
  const h = harness();
  h.demoState.close();
  await expect(h.api.completeDemoImageTask(h.task, h.user.id, "data:image/png;base64,AQID")).rejects.toThrow(DemoStorageError);
  expect(h.demoAssets.size).toBe(0);
  expect(h.task.status).toBe("processing");
  h.api.finishDemoTaskFailure(h.task, new DemoStorageError("save", new Error("disk full")), {}, h.user);
  expect(h.task).toMatchObject({ status: "paused", errorCode: "LOCAL_STORAGE_UNAVAILABLE" });
  expect(h.user.creditBalance).toBe(10);
});

test("local processing failure preserves original bytes first and pauses without a refund or paid replay", async () => {
  const h = harness({ process: async () => {
    expect(h.demoState.load().assets).toHaveLength(1);
    expect(h.demoState.load().assets[0].bytes).toEqual(new Uint8Array([0, 255, 1, 2]));
    expect(h.demoState.load().tasks[0].status).toBe("processing");
    throw new Error("local codec unavailable");
  } });
  try {
    h.task.parameters = { output_format: "webp" };
    const error = await h.api.completeDemoImageTask(h.task, h.user.id, "data:image/png;base64,AP8BAg==").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImageResultPersistenceError);
    h.api.finishDemoTaskFailure(h.task, error, { status: "failed", failureReason: "provider failed" }, h.user);
    const state = h.demoState.load();
    expect(state.tasks[0]).toMatchObject({ status: "paused", errorCode: "IMAGE_RESULT_PROCESSING_FAILED", resultUrls: [] });
    expect(state.tasks[0].failureReason).toContain("渠道原件已保存");
    expect(state.tasks[0].refundedAt).toBeUndefined();
    expect(state.assets).toHaveLength(1);
    expect(h.user.creditBalance).toBe(10);
    expect(h.submissions()).toBe(0);
  } finally { h.demoState.close(); }
});

test("opaque transparent-background output remains durable and pauses the Demo task without a paid replay", async () => {
  const h = harness();
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC";
  try {
    h.task.parameters = { background: "transparent" };
    const error = await h.api.completeDemoImageTask(h.task, h.user.id, `data:image/png;base64,${base64}`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageResultPersistenceError);
    expect(error.cause).toMatchObject({ code: "IMAGE_RESULT_TRANSPARENCY_MISSING" });
    h.api.finishDemoTaskFailure(h.task, error, { status: "failed", failureReason: "provider failed" }, h.user);
    const state = h.demoState.load();
    expect(state.tasks[0]).toMatchObject({ status: "paused", errorCode: "IMAGE_RESULT_PROCESSING_FAILED", resultUrls: [] });
    expect(state.tasks[0].failureReason).toContain("所有像素均不透明");
    expect(state.tasks[0].failureReason).toContain("渠道原件已保存");
    expect(state.tasks[0].refundedAt).toBeUndefined();
    expect(state.assets).toHaveLength(1);
    expect(state.assets[0].bytes).toEqual(new Uint8Array(Buffer.from(base64, "base64")));
    expect(state.assets[0].filename).toEndWith("-provider-original.png");
    expect(h.user.creditBalance).toBe(10);
    expect(h.submissions()).toBe(0);
  } finally { h.demoState.close(); }
});

test("completed result keeps original and export relations plus unchanged bytes after a disk reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-image-variants-test-"));
  const path = join(directory, "state.sqlite");
  const h = harness({ path, process: async () => ({
    display: { mimeType: "image/png", bytes: new Uint8Array([10, 20, 30]) },
    export: { mimeType: "image/webp", bytes: new Uint8Array([40, 50, 60]) },
    operations: ["strict_mask_composite", "format_export"], warning: "有损导出副本仅用于交付",
  }) });
  try {
    h.task.parameters = { output_format: "webp", output_compression: 82 };
    await h.api.completeDemoImageTask(h.task, h.user.id, "data:image/png;base64,AP8BAg==");
    const saved = h.demoState.load();
    expect(saved.tasks[0].resultUrls).toHaveLength(1);
    expect(saved.assets).toHaveLength(3);
    saved.assets = saved.assets.map(materializeDemoAsset);
    h.demoState.close();
    const reopened = new DemoStateStore<any, any>(path);
    try {
      const state = reopened.load();
      expect(state).toEqual(saved);
      const primary = state.assets.find(asset => state.tasks[0].resultUrls[0] === `/api/assets/${asset.id}/content`);
      const variants = resolveImageResultVariants(primary, state.assets);
      expect(variants.maskComposited).toBe(true);
      expect(variants.original.assetId).not.toBe(variants.primary.assetId);
      expect(variants.export?.mimeType).toBe("image/webp");
      expect(primary.metadata.imageResult.outputCompression).toBe(82);
      expect(state.assets.find(asset => asset.id === variants.original.assetId)?.bytes).toEqual(new Uint8Array([0, 255, 1, 2]));
      expect(state.assets.find(asset => asset.id === variants.export?.assetId)?.bytes).toEqual(new Uint8Array([40, 50, 60]));
    } finally { reopened.close(); }
  } finally {
    h.demoState.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + "\\canvas-image-variants-test-") && !resolve(directory).startsWith(resolve(tmpdir()) + "/canvas-image-variants-test-")) throw new Error("Invalid owned test directory");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed persistence before video submission blocks the paid call", async () => {
  const h = harness();
  h.demoState.close();
  await h.api.runVideoTask(h.task, h.user, "happyhorse-1.1", "prompt", {}, []);
  expect(h.submissions()).toBe(0);
  expect(h.task.status).toBe("paused");
  expect(h.user.creditBalance).toBe(10);
});

test("video submission boundary and upstream ID survive later query failure", async () => {
  const h = harness();
  try {
    await h.api.runVideoTask(h.task, h.user, "happyhorse-1.1", "prompt", {}, []);
    expect(h.submissions()).toBe(1);
    expect(h.demoState.load().tasks[0]).toMatchObject({ status: "paused", upstreamTaskId: "upstream-existing" });
    expect(h.demoState.load().tasks[0].submissionStartedAt).toBeString();
    expect(h.user.creditBalance).toBe(10);
  } finally { h.demoState.close(); }
});

test("terminal video recovery refunds once even when queried repeatedly", async () => {
  const h = harness();
  try {
    await h.api.recoverVideoTask(h.task, "happyhorse-1.1", "upstream-existing");
    await h.api.recoverVideoTask(h.task, "happyhorse-1.1", "upstream-existing");
    expect(h.user.creditBalance).toBe(13);
    expect(h.demoState.load().tasks[0]).toMatchObject({ status: "failed" });
    expect(h.demoState.load().tasks[0].refundedAt).toBeString();
  } finally { h.demoState.close(); }
});
