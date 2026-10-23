import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { openAiImageParameters } from "../src/openai-image-parameters";
import { buildOpenTokenImageRequest } from "../src/opentoken-image";
import { inlineProviderImageDataUrl } from "../src/provider-image-result";
import { assertImageEditMaskSupport, prepareImageEditInput } from "../src/image-edit-input";

const rgba = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const sources = [
  { filename: "original.png", mimeType: "image/png", bytes: rgba },
  { filename: "texture.png", mimeType: "image/png", bytes: rgba },
  { filename: "mask.png", mimeType: "image/png", bytes: rgba },
];
const parameters = { inputArchive: { maskReferenceIndex: 2 } };
const wideRgba = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFElEQVR4nGP8////fwYkwILMAbEBfgoEAu8AY9wAAAAASUVORK5CYII=", "base64");
const opaqueRgb = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAE0lEQVR4nGP8//8/AwMDCwMYAAAkFAMDuxa40wAAAABJRU5ErkJggg==", "base64");
const timing = { measure: async (_stage: string, operation: () => unknown) => operation(), finish: () => {} };
const workerTask = { protocol: "openai", base_url: "https://provider.invalid/v1", model_id: "gpt-image-2", encrypted_credentials: "unit-test", operation_type: "inpaint", source_urls: ["one", "two", "mask"], parameters, prompt: "edit", user_id: "user" };

// Execute the production branches without starting the Worker/demo process,
// loading real environment credentials, or contacting an image provider.
async function declaration(file: string, name: string) {
  const source = ts.createSourceFile(file, await Bun.file(new URL(file, import.meta.url)).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing production function ${name}`);
  return ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

const workerCode = await declaration("../src/worker.ts", "executeProvider");
const demoCode = await declaration("../src/demo-server.ts", "runOpenTokenImageTaskForDemo");

function harness(extra: Record<string, unknown> = {}) {
  const submissions: RequestInit[] = [];
  const dependencies = {
    config: { PROVIDER_ENCRYPTION_KEY: "unit-test" },
    decryptSecret: () => '{"apiKey":"unit-test"}',
    openAiImageParameters,
    inlineProviderImageDataUrl,
    assertImageEditMaskSupport,
    prepareImageEditInput,
    OPENAI_IMAGE_TIMEOUT_MS: 1000,
    claimProviderSubmission: async () => {},
    assertProviderSubmissionResponse: async (response: Response) => { if (!response.ok) throw new Error(`Provider ${response.status}`); },
    loadSourceAssets: async () => sources,
    fetchProviderSubmission: async (_url: string, init: RequestInit) => { submissions.push(init); return Response.json({ data: [{ b64_json: rgba.toString("base64") }] }); },
    fetchProviderResult: async (url: string) => ({ url }),
    createGenerationTiming: () => timing,
    updateDemoTask: Object.assign,
    completeDemoImageTask: async (task: { status: string }) => { task.status = "success"; },
    finishDemoTaskFailure: (task: { status: string }, _error: unknown, patch: unknown) => Object.assign(task, patch),
    now: () => "2026-10-13T00:00:00Z",
    openTokenBaseUrl: "https://provider.invalid/v1",
    openTokenApiKey: "unit-test",
    runOpenTokenImage: async (input: Parameters<typeof buildOpenTokenImageRequest>[0]) => {
      const request = buildOpenTokenImageRequest(input);
      submissions.push({ method: request.method, body: request.form || JSON.stringify(request.body) });
      return `data:image/png;base64,${rgba.toString("base64")}`;
    },
    ...extra,
  };
  const api = new Function(...Object.keys(dependencies), `${workerCode}\n${demoCode}\nreturn { executeProvider, runOpenTokenImageTaskForDemo };`)(...Object.values(dependencies));
  return { api, submissions };
}

async function expectMaskMultipart(body: RequestInit["body"]) {
  // Parse the encoded wire payload, not just a mocked FormData method call.
  const request = new Request("https://provider.invalid/v1/images/edits", { method: "POST", body });
  const form = await request.formData();
  expect(form.getAll("image").map(value => (value as File).name)).toEqual(["original.png", "texture.png"]);
  expect(form.getAll("mask")).toHaveLength(1);
  const mask = form.get("mask") as File;
  expect(mask.name).toBe("mask.png");
  expect(new Uint8Array(await mask.arrayBuffer())).toEqual(new Uint8Array(rgba));
}

describe("image edit mask wire contract", () => {
  test("resuming an async image cannot dispatch a new paid request after provider or workflow changes", async () => {
    for (const patch of [
      { protocol: "openai", upstream_task_id: "already-paid", upstream_submission_started_at: "started" },
      { protocol: "openai", upstream_task_id: null, upstream_submission_started_at: "unknown" },
      { protocol: "apimart", workflow_config_id: "new-workflow", upstream_task_id: "already-paid", upstream_submission_started_at: "started" },
    ]) {
      const { api, submissions } = harness();
      await expect(api.executeProvider({ ...workerTask, ...patch }, timing)).rejects.toThrow("渠道配置已变更");
      expect(submissions).toHaveLength(0);
    }
  });
  test("image_generation carrying references uses edits in Worker just as in demo", async () => {
    const actualSources = sources.slice(0, 2);
    const { api, submissions } = harness({ loadSourceAssets: async () => actualSources });
    await api.executeProvider({ ...workerTask, operation_type: "image_generation", source_urls: ["original", "texture"], parameters: {} }, timing);
    expect(submissions[0]!.body instanceof FormData).toBe(true);
    const form = await new Request("https://provider.invalid/v1/images/edits", { method: "POST", body: submissions[0]!.body }).formData();
    expect(form.getAll("image").map(value => (value as File).name)).toEqual(["original.png", "texture.png"]);
    expect(form.getAll("mask")).toHaveLength(0);
    const task = { id: "demo", status: "processing", operationType: "image_generation" };
    await api.runOpenTokenImageTaskForDemo(task, { id: "user" }, "gpt-image-2", "edit", {}, actualSources);
    const demoForm = await new Request("https://provider.invalid/v1/images/edits", { method: "POST", body: submissions[1]!.body }).formData();
    expect(demoForm.getAll("image").map(value => (value as File).name)).toEqual(["original.png", "texture.png"]);
    expect(demoForm.getAll("mask")).toHaveLength(0);
  });

  test("Worker removes the archived mask from image references and sends one independent mask", async () => {
    const { api, submissions } = harness();
    await api.executeProvider(workerTask, timing);
    expect(submissions).toHaveLength(1);
    await expectMaskMultipart(submissions[0]!.body);
  });

  test("demo and Worker use the same ordered images plus independent mask contract", async () => {
    const { api, submissions } = harness();
    const task = { id: "demo", status: "processing", operationType: "inpaint" };
    await api.runOpenTokenImageTaskForDemo(task, { id: "user" }, "gpt-image-2", "edit", parameters, sources);
    expect(task.status).toBe("success");
    expect(submissions).toHaveLength(1);
    await expectMaskMultipart(submissions[0]!.body);
  });

  test("a mask in the middle is removed without reordering the two actual images", async () => {
    const { api, submissions } = harness({ loadSourceAssets: async () => [sources[0], sources[2], sources[1]] });
    await api.executeProvider({ ...workerTask, parameters: { inputArchive: { maskReferenceIndex: 1 } } }, timing);
    await expectMaskMultipart(submissions[0]!.body);
  });

  for (const index of [-1, 0, 3, 1.5, "2", null]) {
    test(`invalid archived mask index ${JSON.stringify(index)} fails before a provider POST`, async () => {
      const { api, submissions } = harness();
      const invalid = { inputArchive: { maskReferenceIndex: index } };
      await expect(api.executeProvider({ ...workerTask, parameters: invalid }, timing)).rejects.toThrow("索引");
      const task = { id: "demo", status: "processing", operationType: "inpaint", failureReason: "" };
      await api.runOpenTokenImageTaskForDemo(task, { id: "user" }, "gpt-image-2", "edit", invalid, sources);
      expect(task.status).toBe("failed");
      expect(task.failureReason).toContain("索引");
      expect(submissions).toHaveLength(0);
    });
  }

  for (const [name, bytes, message] of [
    ["different dimensions", wideRgba, "不一致"],
    ["missing alpha", opaqueRgb, "透明通道"],
    ["corrupt PNG", Buffer.from("broken png"), "无法完整解码"],
  ] as const) {
    test(`${name} is rejected in both runtimes without paying for generation`, async () => {
      const invalidSources = [...sources.slice(0, 2), { ...sources[2]!, bytes }];
      const { api, submissions } = harness({ loadSourceAssets: async () => invalidSources });
      await expect(api.executeProvider(workerTask, timing)).rejects.toThrow(message);
      const task = { id: "demo", status: "processing", operationType: "inpaint", failureReason: "" };
      await api.runOpenTokenImageTaskForDemo(task, { id: "user" }, "gpt-image-2", "edit", parameters, invalidSources);
      expect(task.status).toBe("failed");
      expect(task.failureReason).toContain(message);
      expect(submissions).toHaveLength(0);
    });
  }

  for (const patch of [
    { protocol: "apimart" },
    { model_id: "gemini-3.1-flash-image" },
    { workflow_config_id: "workflow" },
    { operation_type: "image_generation" },
  ]) {
    test(`unsupported mask target ${JSON.stringify(patch)} never reaches a paid submission`, async () => {
      const { api, submissions } = harness();
      await expect(api.executeProvider({ ...workerTask, ...patch }, timing)).rejects.toThrow("蒙版");
      expect(submissions).toHaveLength(0);
    });
  }

  test("ordinary reference images without a mask marker are not removed or decoded", async () => {
    const { api, submissions } = harness({ loadSourceAssets: async () => [{ filename: "unchanged.png", mimeType: "image/png", bytes: new Uint8Array([0, 255]) }] });
    await api.executeProvider({ ...workerTask, parameters: {} }, timing);
    const form = await new Request("https://provider.invalid/v1/images/edits", { method: "POST", body: submissions[0]!.body }).formData();
    expect(form.getAll("image")).toHaveLength(1);
    expect(form.getAll("mask")).toHaveLength(0);
    expect(new Uint8Array(await (form.get("image") as File).arrayBuffer())).toEqual(new Uint8Array([0, 255]));
  });

  test("a mask marker without any source cannot fall through to paid text-to-image generation", async () => {
    const { api, submissions } = harness();
    await expect(api.executeProvider({ ...workerTask, source_urls: [] }, timing)).rejects.toThrow("索引");
    expect(submissions).toHaveLength(0);
  });

  test("Worker tags formatless Gemini JPEG bytes correctly before materialization", async () => {
    const jpeg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAf/2Q==";
    let calls = 0;
    const { api } = harness({ fetchProviderSubmission: async () => {
      calls++;
      return Response.json({ data: [{ b64_json: jpeg }] });
    } });
    const result = await api.executeProvider({ ...workerTask, model_id: "gemini-3.1-flash-image", operation_type: "image_generation", source_urls: [], parameters: {} }, timing);
    expect(result[0].url).toBe(`data:image/jpeg;base64,${jpeg}`);
    expect(calls).toBe(1);
  });

  for (const outputFormat of ["jpeg", "webp"] as const) {
    for (const operation of ["image_generation", "inpaint"] as const) {
      test(`Worker identifies returned PNG despite requested ${outputFormat} and omits GPT response_format during ${operation}`, async () => {
        const { api, submissions } = harness();
        const result = await api.executeProvider({ ...workerTask, operation_type: operation, source_urls: operation === "inpaint" ? ["source"] : [], parameters: { output_format: outputFormat } }, timing);
        expect(result[0].url).toBe(`data:image/png;base64,${rgba.toString("base64")}`);
        if (operation === "inpaint") {
          const form = await new Request("https://provider.invalid/v1/images/edits", { method: "POST", body: submissions[0]!.body }).formData();
          expect(form.get("output_format")).toBe(outputFormat);
          expect(form.has("response_format")).toBe(false);
        } else {
          const body = JSON.parse(String(submissions[0]!.body));
          expect(body.output_format).toBe(outputFormat);
          expect(body.response_format).toBeUndefined();
        }
      });
    }
  }
});

describe("mask preflight before enqueue or provider execution", () => {
  const target = { protocol: "openai", modelId: "gpt-image-2", operationType: "inpaint" };
  test("rejects non-PNG and oversized masks", async () => {
    await expect(prepareImageEditInput([sources[0]!, sources[1]!, { ...sources[2]!, mimeType: "image/jpeg" }], parameters, target)).rejects.toThrow("PNG");
    await expect(prepareImageEditInput([sources[0]!, sources[1]!, { ...sources[2]!, bytes: new Uint8Array(4 * 1024 * 1024) }], parameters, target)).rejects.toThrow("4 MiB");
  });
  test("unsupported APIMart rejects masks instead of silently accepting them as reference images", async () => {
    await expect(prepareImageEditInput(sources, parameters, { ...target, protocol: "apimart" })).rejects.toThrow("不支持独立 PNG 蒙版");
  });
  test("matching dimensions are checked against the first original, not another reference", async () => {
    await expect(prepareImageEditInput([{ ...sources[0]!, bytes: wideRgba }, sources[1]!, sources[2]!], parameters, target)).rejects.toThrow("第一张原图");
  });
});
