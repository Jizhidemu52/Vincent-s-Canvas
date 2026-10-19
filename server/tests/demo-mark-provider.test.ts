import { afterEach, describe, expect, test } from "bun:test";
import ts from "typescript";
import { MARK_IMAGE_BASE_URL, MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import { ApiMartImageProviderFailure } from "../src/apimart-image";
import { createDemoMarkProvider } from "../src/demo-mark-provider";
import { listAvailableDemoModels } from "../src/demo-provider-configuration";
import { DemoStateStore, DemoStorageError } from "../src/demo-state-store";
import { ImageResultPersistenceError } from "../src/image-result-storage";
import { imageTaskApiReplacer, imageTaskFailureDetail, imageTaskPauseReason, type ImageTaskFailureDetail } from "../src/image-task-diagnostics";
import { isPublicHttpUrl } from "../src/apimart-upload";

const stores: DemoStateStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const source = ts.createSourceFile("demo-server.ts", await Bun.file(new URL("../src/demo-server.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["runApiMartImageTaskForDemo", "callApiMartImage", "updateDemoTask", "finishDemoTaskFailure", "pauseDemoTaskForStorageFailure"];
const productionCode = ts.transpileModule(names.map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing production declaration: ${name}`);
  return declaration.getText(source);
}).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Task = { id: string; requestId: string; ownerUserId: string; status: string; operationType: string; credits: number; parameters: Record<string, unknown>; upstreamTaskId?: string; upstreamResultUrl?: string; submissionStartedAt?: string; failureReason?: string; lastFailure?: ImageTaskFailureDetail };
type Input = { baseUrl: string; apiKey: string; sourceDataUrls: string[]; maskDataUrl?: string; upstreamTaskId?: string; submissionStarted?: boolean; beforeSubmit?: () => void; onSubmitted?: (id: string) => void };
function harness(failure?: "prepare" | "preflight" | "submission" | "polling" | "download" | "store" | "terminal") {
  const demoState = new DemoStateStore(":memory:"); stores.push(demoState);
  const inputs: Input[] = [];
  const completed: unknown[][] = [];
  let paid = 0;
  let downloads = 0;
  const dependencies = {
    demoState, DemoStorageError, ImageResultPersistenceError, ApiMartImageProviderFailure, MARK_IMAGE_PROVIDER_ID,
    imageTaskFailureDetail, imageTaskPauseReason, isPublicHttpUrl,
    demoAssets: new Map(), demoTasks: new Map(), now: () => new Date().toISOString(),
    gptImage2ProviderId: "legacy-apimart", apiMartBaseUrl: "https://legacy.invalid/v1", apiMartApiKey: "legacy-key-must-not-be-used",
    markImageProvider: createDemoMarkProvider({ apiKey: "fake-mark-key", baseUrl: "https://mark.invalid/v1" }),
    prepareImageEditInput: async (sources: unknown[]) => { if (failure === "prepare") throw new Error("invalid local input"); return { references: sources }; },
    completeDemoImageTask: async (...args: unknown[]) => {
      if (failure === "store") throw new ImageResultPersistenceError({ assetId: "original", mimeType: "image/png", filename: "original.png" }, new Error("synthetic conversion failure"));
      completed.push(args); (args[0] as Task).status = "success";
    },
    runApiMartImageTask: async (input: Input) => {
      inputs.push(input);
      if (failure === "preflight") throw new Error("bad local input");
      if (!input.upstreamTaskId) {
        if (input.submissionStarted) throw new Error("unsafe duplicate submission");
        input.beforeSubmit?.();
        paid++;
        if (failure === "submission") throw new Error("uncertain paid submission fake-mark-key");
        input.onSubmitted?.("mark-original-task");
      }
      if (failure === "polling") throw new Error("poll unavailable fake-mark-key");
      if (failure === "terminal") throw new ApiMartImageProviderFailure("provider terminal fake-mark-key");
      return ["https://result.invalid/image.png"];
    },
    downloadApiMartImage: async () => { downloads++; if (failure === "download") throw Object.assign(new Error("download unavailable"), { code: "ECONNRESET" }); return "data:image/png;base64,AQID"; },
  };
  const run = new Function(...Object.keys(dependencies), `${productionCode}\nreturn runApiMartImageTaskForDemo;`)(...Object.values(dependencies));
  const task: Task = { id: "task-mark", requestId: "request-mark", ownerUserId: "owner", status: "processing", operationType: "image_generation", credits: 3, parameters: {} };
  const user = { id: "owner", creditBalance: 10 };
  return { task, user, inputs, completed, demoState, paid: () => paid, downloads: () => downloads, clearFailure: () => { failure = undefined; }, run: (prepared?: unknown) => run(task, user, "gpt-image-2.5-flare", "prompt", task.parameters, [], MARK_IMAGE_PROVIDER_ID, prepared) };
}

describe("read-only demo Mark catalog", () => {
  test("uses the shared identity and stable preset UUIDs without exposing credentials in catalog rows", () => {
    const mark = createDemoMarkProvider({ apiKey: " fake-mark-key " });
    expect(mark.apiKey).toBe("fake-mark-key");
    expect(mark.baseUrl).toBe(MARK_IMAGE_BASE_URL);
    expect(mark.provider).toMatchObject({ id: MARK_IMAGE_PROVIDER_ID, hasCredentials: true, protocol: "apimart" });
    expect(mark.models.map(model => [model.id, model.modelId])).toEqual(MARK_PLATFORM_MODELS.map((model, index) => [`d5000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, model.modelId]));
    expect(listAvailableDemoModels(mark.models, [mark.provider])).toHaveLength(MARK_PLATFORM_MODELS.length - 1);
    expect(mark.models.filter(model => !model.enabled).map(model => model.modelId)).toEqual(["grok-imagine-image-2.0"]);
    expect(mark.models.at(-1)).toMatchObject({ id: "d5000000-0000-4000-8000-000000000010", modelId: "claude-sonnet-5-5", enabled: true });
    expect(mark.models.find(model => model.modelId === "gemini-3.1-flash-image-preview-official")?.id).toBe("d5000000-0000-4000-8000-000000000009");
    expect(JSON.stringify([mark.provider, mark.models])).not.toContain("fake-mark-key");
    const disabled = createDemoMarkProvider({ apiKey: " " });
    expect(listAvailableDemoModels(disabled.models, [disabled.provider])).toEqual([]);
  });

  test("separates Mark credentials and mask, persists intent/ID, and passes the original input to strict result storage", async () => {
    const h = harness();
    const reference = { mimeType: "image/png", bytes: new Uint8Array([1, 2]) };
    const mask = { mimeType: "image/png", bytes: new Uint8Array([3, 4]) };
    const prepared = { references: [reference], mask };
    await h.run(prepared);
    expect(h.inputs[0]).toMatchObject({ baseUrl: "https://mark.invalid/v1", apiKey: "fake-mark-key", sourceDataUrls: ["data:image/png;base64,AQI="], maskDataUrl: "data:image/png;base64,AwQ=" });
    expect(h.task.submissionStartedAt).toEqual(expect.any(String));
    expect(h.task.upstreamTaskId).toBe("mark-original-task");
    expect(h.completed[0]?.[3]).toBe(prepared);
    expect(h.task.status).toBe("success");
    expect(h.paid()).toBe(1);
  });

  for (const failure of ["submission", "polling", "download"] as const) {
    test(`${failure} uncertainty pauses without refund, leaking provider text, or repeating a paid POST`, async () => {
      const h = harness(failure); await h.run();
      expect(h.task.status).toBe("paused");
      expect(h.user.creditBalance).toBe(10);
      expect(h.task.failureReason).not.toContain("fake-mark-key");
      expect(h.paid()).toBe(1);
      expect(h.completed).toHaveLength(0);
      expect(h.task.lastFailure?.phase).toBe(failure);
      if (failure !== "submission") expect(h.task.upstreamTaskId).toBe("mark-original-task");
    });
  }

  test("persists a private result URL before download and resumes it without polling, uploading, or submitting again", async () => {
    const h = harness("download"); await h.run();
    expect(h.task.lastFailure).toEqual({ phase: "download", code: "ECONNRESET" });
    const stored = h.demoState.load().tasks[0] as unknown as Task;
    expect(stored.upstreamResultUrl).toBe("https://result.invalid/image.png");
    expect(JSON.stringify({ task: stored, history: [{ ...stored }] }, imageTaskApiReplacer)).not.toContain("https://result.invalid");
    h.clearFailure();
    await h.run();
    expect(h.task.status).toBe("success");
    expect(h.paid()).toBe(1); expect(h.inputs).toHaveLength(1); expect(h.downloads()).toBe(2);
    expect(h.user.creditBalance).toBe(10);
  });

  test("preflight failure does not mark a paid submission", async () => {
    const h = harness("preflight"); await h.run();
    expect(h.task.status).toBe("failed"); expect(h.task.submissionStartedAt).toBeUndefined();
    expect(h.paid()).toBe(0); expect(h.user.creditBalance).toBe(13);
  });

  test("recovery preflight and result-store failures retain their real phases and never refund or replay", async () => {
    const prepare = harness("prepare");
    prepare.task.upstreamTaskId = "existing-upstream";
    await prepare.run();
    expect(prepare.task.lastFailure?.phase).toBe("preflight");
    expect(prepare.task.status).toBe("paused"); expect(prepare.paid()).toBe(0);
    const store = harness("store"); await store.run();
    expect(store.task.lastFailure).toEqual({ phase: "result_store", code: "IMAGE_RESULT_PROCESSING_FAILED" });
    expect(store.task.status).toBe("paused"); expect(store.task.upstreamResultUrl).toBe("https://result.invalid/image.png");
    expect(store.user.creditBalance).toBe(10); expect(store.paid()).toBe(1);
    store.clearFailure(); await store.run();
    expect(store.task.status).toBe("success"); expect(store.inputs).toHaveLength(1); expect(store.paid()).toBe(1);
  });

  test("only explicit upstream terminal failure settles as failed and refunds once", async () => {
    const h = harness("terminal"); await h.run();
    expect(h.task.status).toBe("failed"); expect(h.task.upstreamTaskId).toBe("mark-original-task");
    expect(h.user.creditBalance).toBe(13); expect(h.task.failureReason).not.toContain("fake-mark-key");
    await h.run(); expect(h.paid()).toBe(1); expect(h.user.creditBalance).toBe(13);
  });
});
