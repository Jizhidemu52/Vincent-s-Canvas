import { afterEach, describe, expect, test } from "bun:test";
import ts from "typescript";
import { buildApiMartImageRequest } from "../src/apimart-image";
import { DemoStateStore, DemoStorageError } from "../src/demo-state-store";

const stores: DemoStateStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

// Execute the actual declarations without starting demo-server, loading its
// environment, mutating global fetch, or invoking a real provider/child process.
async function declarations(path: string, names: string[]) {
  const source = ts.createSourceFile(path, await Bun.file(new URL(path, import.meta.url)).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return names.map((name) => {
    const declaration = source.statements.find((node) =>
      ts.isFunctionDeclaration(node) ? node.name?.text === name
        : ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name));
    if (!declaration) throw new Error(`Missing production declaration: ${name}`);
    return declaration.getText(source).replace(/^export\s+/, "");
  }).join("\n");
}

const productionCode = ts.transpileModule([
  await declarations("../src/demo-server.ts", [
    "callGptImage2", "callGptImage2WithBun", "normalizeGptImageSize", "normalizeGptImageResolution",
    "runApiMartImageTaskForDemo", "callApiMartImage", "downloadApiMartImage", "isProviderNetworkError", "isLocalCertificateError",
    "updateDemoTask", "finishDemoTaskFailure", "pauseDemoTaskForStorageFailure",
  ]),
  await declarations("../src/apimart-image.ts", [
    "runApiMartImageTask", "readTaskId", "readStatus", "readOutputUrls", "readFailureMessage", "providerMessage", "object", "string",
    "IMAGE_STATUSES", "IMAGE_FAILURE_STATUSES",
  ]),
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type FailurePhase = "submission" | "polling" | "download";
type RecordedRequest = { url: string; method: string; init?: RequestInit };
type DemoImageTask = { id: string; requestId: string; credits: number; status: string; failureReason?: string };
type Harness = {
  callGptImage2(prompt: string, parameters: Record<string, unknown>, sources: Array<{ mimeType: string; bytes: Uint8Array }>): Promise<string>;
  runApiMartImageTaskForDemo(task: DemoImageTask, user: { id: string; creditBalance: number }, modelId: string, prompt: string, parameters: Record<string, unknown>, sources: unknown[]): Promise<void>;
};

function createHarness(failurePhase?: FailurePhase) {
  const demoState = new DemoStateStore(":memory:");
  stores.push(demoState);
  const paid: RecordedRequest[] = [];
  const reads: RecordedRequest[] = [];
  let completed = 0;
  const failure = Object.assign(new Error("unknown certificate verification error"), { code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR" });
  const dependencies = {
    demoState, DemoStorageError, demoAssets: new Map(), demoTasks: new Map(), now: () => new Date().toISOString(),
    apiMartBaseUrl: "https://apimart.invalid/v1",
    apiMartApiKey: "mock-model-key",
    buildApiMartImageRequest,
    Bun: { sleep: async () => {} },
    sleep: async () => {},
    completeDemoImageTask: () => { completed++; },
    fetchProviderSubmission: async (url: string, init?: RequestInit) => {
      paid.push({ url: String(url), method: init?.method || "GET", init });
      if (failurePhase === "submission") throw failure;
      return Response.json({ data: [{ task_id: "original-task" }] });
    },
    fetch: async (url: string, init?: RequestInit) => {
      const request = { url: String(url), method: init?.method || "GET", init };
      reads.push(request);
      if (request.method !== "GET") throw new Error("A paid submission bypassed fetchProviderSubmission");
      if (request.url === "https://apimart.invalid/v1/tasks/original-task") {
        if (failurePhase === "polling") throw failure;
        return Response.json({ data: { status: "completed", result: { images: [{ url: ["https://images.invalid/original.png"] }] } } });
      }
      if (request.url === "https://images.invalid/original.png") {
        if (failurePhase === "download") throw failure;
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      throw new Error(`Unexpected mock request: ${request.url}`);
    },
  };
  const api = new Function(...Object.keys(dependencies), `${productionCode}\nreturn { callGptImage2, runApiMartImageTaskForDemo };`)(...Object.values(dependencies)) as Harness;
  return { api, paid, reads, failure, completed: () => completed };
}

describe("demo image paid-submission boundaries", () => {
  test("GPT Image2 submits through the helper once and keeps polling/download on ordinary GET", async () => {
    const harness = createHarness();
    const result = await harness.api.callGptImage2("reference prompt", { size: "16:9", resolution: "2k" }, [{ mimeType: "image/png", bytes: new Uint8Array([0, 255]) }]);
    expect(result).toBe("data:image/png;base64,AQID");
    expect(harness.paid).toHaveLength(1);
    expect(harness.paid[0]).toMatchObject({ url: "https://apimart.invalid/v1/images/generations", method: "POST" });
    expect(new Headers(harness.paid[0]!.init?.headers).get("authorization")).toBe("Bearer mock-model-key");
    expect(JSON.parse(String(harness.paid[0]!.init?.body))).toEqual({ model: "gpt-image-2", prompt: "reference prompt", n: 1, size: "16:9", resolution: "2k", image_urls: ["data:image/png;base64,AP8="] });
    expect(harness.reads.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "https://apimart.invalid/v1/tasks/original-task", method: "GET" },
      { url: "https://images.invalid/original.png", method: "GET" },
    ]);
  });

  for (const phase of ["submission", "polling", "download"] as const) {
    test(`GPT Image2 does not restart the whole paid job after a ${phase} network failure`, async () => {
      const harness = createHarness(phase);
      const error = await harness.api.callGptImage2("paid prompt", {}, []).catch((error) => error);
      expect(error).toBe(harness.failure);
      expect(harness.paid).toHaveLength(1);
      expect(harness.paid[0]!.method).toBe("POST");
      expect(harness.reads.map((request) => request.method)).toEqual(Array(phase === "submission" ? 0 : phase === "polling" ? 1 : 2).fill("GET"));
    });

    test(`APIMart demo does not use a whole-job fallback after a ${phase} network failure`, async () => {
      const harness = createHarness(phase);
      const task: DemoImageTask = { id: "task", requestId: "request", status: "processing", credits: 3 };
      const user = { id: "test-owner", creditBalance: 10 };
      await harness.api.runApiMartImageTaskForDemo(task, user, "gemini-3.1-flash-image-preview", "paid prompt", {}, []);
      expect(task.status).toBe("failed");
      expect(task.failureReason).toContain("无法与图像服务建立安全连接");
      expect(user.creditBalance).toBe(13);
      expect(harness.completed()).toBe(0);
      expect(harness.paid).toHaveLength(1);
      expect(harness.paid[0]).toMatchObject({ url: "https://apimart.invalid/v1/images/generations", method: "POST" });
      expect(harness.reads.map((request) => request.method)).toEqual(Array(phase === "submission" ? 0 : phase === "polling" ? 1 : 2).fill("GET"));
    });
  }
});
