import { expect, test } from "bun:test";
import ts from "typescript";
import { DemoStateStore, DemoStorageError } from "../src/demo-state-store";
import { decodeInlineImageResult } from "../src/demo-task-result-assets";

const file = new URL("../src/demo-server.ts", import.meta.url);
const source = ts.createSourceFile(file.pathname, await Bun.file(file).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["saveDemoAsset", "updateDemoTask", "pauseDemoTaskForStorageFailure", "finishDemoTaskFailure", "completeDemoImageTask", "runVideoTask", "recoverVideoTask", "classifyVideoTaskError", "callInternalAiSeamless", "downloadApiMartImage"];
const code = ts.transpileModule(names.map((name) => {
  const node = source.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing production declaration: ${name}`);
  return node.getText(source);
}).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const demoState = new DemoStateStore<any, any>(":memory:");
  const demoAssets = new Map();
  const demoTasks = new Map();
  const user = { id: "owner", creditBalance: 10 };
  class DemoVideoTerminalError extends Error {}
  let submissions = 0;
  const downloads: string[] = [];
  const deps = {
    demoState, demoAssets, demoTasks, DemoStorageError, decodeInlineImageResult,
    now: () => new Date().toISOString(), console: { error() {} },
    demoAccounts: [{ user }], DemoVideoTerminalError,
    internalAiConfig: { seamlessUrl: "http://seamless.invalid/generate", appKey: "test-only" },
    fetch: async (url: string) => {
      if (url === "http://seamless.invalid/generate") return Response.json({ data: { data: { list: ["https://result.invalid/temporary.png"] } } });
      if (url === "https://result.invalid/temporary.png") {
        downloads.push(url);
        return new Response(new Uint8Array([0, 255, 1, 2]), { headers: { "content-type": "image/png" } });
      }
      throw new Error("Unexpected network request");
    },
    callVideoProvider: async (_model: unknown, _prompt: unknown, _parameters: unknown, _sources: unknown, submitted: (id: string) => void, starting: () => void) => {
      starting(); submissions++; submitted("upstream-existing"); throw new Error("status check failed");
    },
    pollVideoProviderTask: async () => { throw new DemoVideoTerminalError("provider terminal failure"); },
  };
  const api = new Function(...Object.keys(deps), `${code}\nreturn { saveDemoAsset, updateDemoTask, finishDemoTaskFailure, completeDemoImageTask, runVideoTask, recoverVideoTask, callInternalAiSeamless };`)(...Object.values(deps));
  const task = { id: "task", requestId: "request", ownerUserId: "owner", status: "processing", operationType: "image_generation", resultUrls: [], credits: 3 };
  api.updateDemoTask(task, {});
  return { api, demoState, demoTasks, demoAssets, user, task, downloads, submissions: () => submissions };
}

test("remote seamless output is downloaded and saved as original bytes, not an expiring URL", async () => {
  const h = harness();
  try {
    const result = await h.api.callInternalAiSeamless(h.task, { bytes: new Uint8Array([1]) }, {});
    h.api.completeDemoImageTask(h.task, h.user.id, result);
    expect(h.downloads).toEqual(["https://result.invalid/temporary.png"]);
    expect(h.demoState.load().assets[0].bytes).toEqual(new Uint8Array([0, 255, 1, 2]));
    expect(h.demoState.load().tasks[0].resultUrls[0]).toStartWith("/api/assets/");
  } finally { h.demoState.close(); }
});

test("empty, invalid and undownloaded image output cannot become a successful task", () => {
  const h = harness();
  try {
    for (const result of ["", "data:image/png;base64,", "data:text/plain;base64,AQID", "https://result.invalid/unpersisted.png"]) {
      expect(() => h.api.completeDemoImageTask(h.task, h.user.id, result)).toThrow("图片结果为空或格式无效");
      expect(h.demoState.load().tasks[0].status).toBe("processing");
      expect(h.demoState.load().assets).toHaveLength(0);
    }
  } finally { h.demoState.close(); }
});

test("image result bytes and completed task are committed together", () => {
  const h = harness();
  try {
    h.api.completeDemoImageTask(h.task, h.user.id, "data:image/png;base64,AP8BAg==");
    const state = h.demoState.load();
    expect(state.assets[0].bytes).toEqual(new Uint8Array([0, 255, 1, 2]));
    expect(state.tasks[0]).toMatchObject({ status: "success", resultUrls: [`/api/assets/${state.assets[0].id}/content`] });
    expect(h.demoTasks.get(h.task.id)).toBe(h.task);
    expect(h.task.status).toBe("success");
  } finally { h.demoState.close(); }
});

test("storage failure never claims task completion or turns into a provider refund", () => {
  const h = harness();
  h.demoState.close();
  expect(() => h.api.completeDemoImageTask(h.task, h.user.id, "data:image/png;base64,AQID")).toThrow(DemoStorageError);
  expect(h.demoAssets.size).toBe(0);
  expect(h.task.status).toBe("processing");
  h.api.finishDemoTaskFailure(h.task, new DemoStorageError("save", new Error("disk full")), {}, h.user);
  expect(h.task).toMatchObject({ status: "paused", errorCode: "LOCAL_STORAGE_UNAVAILABLE" });
  expect(h.user.creditBalance).toBe(10);
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
