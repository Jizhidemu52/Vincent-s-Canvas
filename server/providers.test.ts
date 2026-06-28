import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderPayload, executeLiveProviderPayload, getProviderHealth, runProviderModel } from "./providers";
import type { GenerationRequest, ModelDefinition } from "../src/domain/workspace";

const openAiModel: ModelDefinition = {
  id: "gpt-image-2-low",
  name: "GPT Image 2 Low",
  provider: "openai",
  group: "Trending models",
  capability: ["generate", "edit"],
  cost: 2
};

const nanoBananaModel: ModelDefinition = {
  id: "nanobanana2",
  name: "Nano Banana 2",
  provider: "nanobanana",
  group: "Trending models",
  capability: ["generate", "edit"],
  cost: 11
};

const runningHubModel: ModelDefinition = {
  id: "runninghub-fashion-workflow",
  name: "RunningHub Fashion Workflow",
  provider: "runninghub",
  group: "Operations",
  capability: ["generate", "edit", "upscale", "removeBackground"],
  cost: 8
};

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    projectId: "project-provider",
    nodeId: "node-provider",
    modelId: openAiModel.id,
    prompt: "make a clean fashion product image",
    referenceNodeIds: ["node-provider"],
    outputCount: 2,
    operation: "generate",
    ...patch
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider adapters", () => {
  it("reports server-hosted mock mode without exposing secrets", () => {
    const health = getProviderHealth([openAiModel]);

    expect(health[0]).toMatchObject({
      provider: "openai",
      status: "degraded",
      modelCount: 1,
      keyLocation: "server",
      mode: "mock",
      secretConfigured: false,
      adapterId: "openai-image-adapter",
      requiredSecrets: ["OPENAI_API_KEY"],
      configuredSecrets: [],
      missingSecrets: ["OPENAI_API_KEY"],
      supportedOperations: ["generate", "edit"]
    });
    expect(JSON.stringify(health)).not.toContain("apiKey");
  });

  it("switches provider health to live-ready when the server has a key", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-secret");

    const [health] = getProviderHealth([openAiModel]);

    expect(health).toMatchObject({
      provider: "openai",
      status: "healthy",
      mode: "live-ready",
      secretConfigured: true,
      keyLocation: "server"
    });
    expect(JSON.stringify(health)).not.toContain("sk-test-secret");
  });

  it("uses admin provider settings without exposing stored secret values", () => {
    const [health] = getProviderHealth([openAiModel], {
      openai: {
        mode: "live-ready",
        endpointUrl: "https://api.openai.example/v1/images",
        configuredSecrets: ["OPENAI_API_KEY"],
        secretConfigured: true
      }
    });

    expect(health).toMatchObject({
      provider: "openai",
      mode: "live-ready",
      secretConfigured: true,
      endpointUrl: "https://api.openai.example/v1/images",
      configuredSecrets: ["OPENAI_API_KEY"],
      missingSecrets: []
    });
    expect(JSON.stringify(health)).not.toContain("sk-admin-secret");
  });

  it("supports provider secret aliases without requiring every alias to be configured", () => {
    vi.stubEnv("NANO_BANANA_API_KEY", "nano-secret");

    const [health] = getProviderHealth([nanoBananaModel]);

    expect(health).toMatchObject({
      provider: "nanobanana",
      mode: "live-ready",
      secretConfigured: true,
      configuredSecrets: ["NANO_BANANA_API_KEY"],
      missingSecrets: []
    });
    expect(health.requiredSecrets).toEqual(["NANOBANANA_API_KEY", "NANO_BANANA_API_KEY"]);
    expect(JSON.stringify(health)).not.toContain("nano-secret");
  });

  it("runs model requests through the provider adapter result contract", () => {
    const result = runProviderModel(request(), openAiModel, "history-provider", 4);

    expect(result).toMatchObject({
      status: "succeeded",
      creditCost: 4,
      historyId: "history-provider"
    });
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0].source).toBe("mock://openai/generate/node-provider/1");
  });

  it("uses provider request size settings for mock output dimensions", () => {
    const result = runProviderModel(request({ providerSettings: { size: "1536x1024", quality: "high" }, outputCount: 1 }), openAiModel, "history-size", 2);

    expect(result.outputs[0]).toMatchObject({
      width: 1536,
      height: 1024
    });
  });

  it("maps OpenAI image requests with typed provider settings without secret values", () => {
    const payload = buildProviderPayload(
      request({
        referenceNodeIds: ["reference-front"],
        outputCount: 3,
        providerSettings: { size: "1536x1024", quality: "high", preset: "lookbook-cleanup" }
      }),
      openAiModel,
      {
        mode: "live-ready",
        endpointUrl: "https://api.openai.example/v1/images",
        configuredSecrets: ["OPENAI_API_KEY"],
        secretConfigured: true
      }
    );

    expect(payload).toMatchObject({
      provider: "openai",
      adapterId: "openai-image-adapter",
      endpointUrl: "https://api.openai.example/v1/images",
      secretNames: ["OPENAI_API_KEY"],
      body: {
        model: "gpt-image-2-low",
        operation: "generate",
        prompt: "make a clean fashion product image",
        n: 3,
        size: "1536x1024",
        quality: "high",
        preset: "lookbook-cleanup",
        references: ["reference-front"]
      }
    });
    expect(JSON.stringify(payload)).not.toContain("sk-admin-secret");
  });

  it("maps workflow providers with mask, batch, and provider settings", () => {
    const payload = buildProviderPayload(
      request({
        modelId: runningHubModel.id,
        operation: "edit",
        referenceNodeIds: ["original-node"],
        mask: { x: 10, y: 20, width: 300, height: 240 },
        batchSettings: { concurrency: 2, failurePolicy: "continue" },
        providerSettings: { size: "1024x1536", quality: "medium", preset: "catalog-retouch" }
      }),
      runningHubModel,
      {
        mode: "live-ready",
        endpointUrl: "https://runninghub.example/api/run",
        configuredSecrets: ["RUNNINGHUB_API_KEY"],
        secretConfigured: true
      }
    );

    expect(payload).toMatchObject({
      provider: "runninghub",
      adapterId: "runninghub-workflow-adapter",
      endpointUrl: "https://runninghub.example/api/run",
      secretNames: ["RUNNINGHUB_API_KEY"],
      body: {
        workflowId: "runninghub-fashion-workflow",
        operation: "edit",
        inputs: {
          prompt: "make a clean fashion product image",
          references: ["original-node"],
          outputCount: 2,
          providerSettings: { size: "1024x1536", quality: "medium", preset: "catalog-retouch" },
          mask: { x: 10, y: 20, width: 300, height: 240 },
          batchSettings: { concurrency: 2, failurePolicy: "continue" }
        }
      }
    });
  });

  it("submits live image provider payloads with resolved secrets and normalizes outputs", async () => {
    const providerRequest = request({
      outputCount: 1,
      providerSettings: { size: "1536x1024", quality: "high", preset: "lookbook-cleanup" }
    });
    const payload = buildProviderPayload(providerRequest, openAiModel, {
      mode: "live-ready",
      endpointUrl: "https://api.openai.example/v1/images",
      configuredSecrets: ["OPENAI_API_KEY"],
      secretConfigured: true
    });
    const fetchCalls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];

    const result = await executeLiveProviderPayload(payload, providerRequest, openAiModel, "history-live-openai", 2, {
      resolveSecret: (name) => (name === "OPENAI_API_KEY" ? "sk-live-secret" : undefined),
      fetchJson: async (url, init) => {
        fetchCalls.push({ url, init });
        return {
          ok: true,
          status: 200,
          body: {
            data: [{ url: "https://cdn.example/openai/lookbook-1.png", width: 1536, height: 1024 }]
          }
        };
      }
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({
      url: "https://api.openai.example/v1/images",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-live-secret",
          "Content-Type": "application/json"
        }
      }
    });
    expect(JSON.parse(fetchCalls[0].init.body ?? "{}")).toMatchObject({
      model: "gpt-image-2-low",
      n: 1,
      size: "1536x1024",
      quality: "high",
      preset: "lookbook-cleanup"
    });
    expect(result).toMatchObject({
      status: "succeeded",
      creditCost: 2,
      historyId: "history-live-openai",
      outputs: [
        {
          name: "GPT Image 2 Low output 1.png",
          source: "https://cdn.example/openai/lookbook-1.png",
          width: 1536,
          height: 1024
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-secret");
  });

  it("polls workflow provider jobs and normalizes returned assets", async () => {
    const providerRequest = request({
      modelId: runningHubModel.id,
      operation: "edit",
      outputCount: 1,
      referenceNodeIds: ["original-node"],
      providerSettings: { size: "1024x1536", quality: "medium" }
    });
    const payload = buildProviderPayload(providerRequest, runningHubModel, {
      mode: "live-ready",
      endpointUrl: "https://runninghub.example/api/run",
      configuredSecrets: ["RUNNINGHUB_API_KEY"],
      secretConfigured: true
    });
    const fetchCalls: string[] = [];

    const result = await executeLiveProviderPayload(payload, providerRequest, runningHubModel, "history-live-rh", 8, {
      maxPollAttempts: 2,
      resolveSecret: (name) => (name === "RUNNINGHUB_API_KEY" ? "rh-live-secret" : undefined),
      fetchJson: async (url) => {
        fetchCalls.push(url);
        if (fetchCalls.length === 1) {
          return {
            ok: true,
            status: 202,
            body: { jobId: "rh-job-1", status: "running", statusUrl: "https://runninghub.example/api/jobs/rh-job-1" }
          };
        }
        return {
          ok: true,
          status: 200,
          body: {
            status: "succeeded",
            outputs: [{ url: "https://cdn.example/runninghub/final.png", width: 1024, height: 1536, name: "final.png" }]
          }
        };
      }
    });

    expect(fetchCalls).toEqual(["https://runninghub.example/api/run", "https://runninghub.example/api/jobs/rh-job-1"]);
    expect(result).toMatchObject({
      status: "succeeded",
      creditCost: 8,
      historyId: "history-live-rh",
      outputs: [{ name: "final.png", source: "https://cdn.example/runninghub/final.png", width: 1024, height: 1536 }],
      providerProgress: {
        providerJobId: "rh-job-1",
        status: "succeeded",
        statusUrl: "https://runninghub.example/api/jobs/rh-job-1",
        pollAttempts: 1
      }
    });
  });

  it("executes RunningHub AI app payloads with body apiKey and POST output polling", async () => {
    const providerRequest = request({
      modelId: runningHubModel.id,
      operation: "edit",
      outputCount: 1,
      referenceNodeIds: ["uploaded-reference"],
      providerSettings: {
        size: "1024x1536",
        webappId: "rh-webapp-7788",
        taskType: "ASYNC",
        instanceType: "plus",
        nodeInfoList: [
          { nodeId: "3", fieldName: "prompt", fieldValue: "clean product shadow" },
          { nodeId: "9", fieldName: "image", fieldValue: "uploaded-reference.png", valueType: "image" }
        ]
      }
    });
    const payload = buildProviderPayload(providerRequest, runningHubModel, {
      mode: "live-ready",
      endpointUrl: "https://www.runninghub.cn/task/openapi/ai-app/run",
      configuredSecrets: ["RUNNINGHUB_API_KEY"],
      secretConfigured: true
    });
    const fetchCalls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];

    expect(payload.body).toMatchObject({
      webappId: "rh-webapp-7788",
      taskType: "ASYNC",
      instanceType: "plus",
      nodeInfoList: [
        { nodeId: "3", fieldName: "prompt", fieldValue: "clean product shadow" },
        { nodeId: "9", fieldName: "image", fieldValue: "uploaded-reference.png", valueType: "image" }
      ]
    });
    expect(JSON.stringify(payload)).not.toContain("rh-live-secret");

    const result = await executeLiveProviderPayload(payload, providerRequest, runningHubModel, "history-rh-ai-app", 8, {
      maxPollAttempts: 2,
      resolveSecret: (name) => (name === "RUNNINGHUB_API_KEY" ? "rh-live-secret" : undefined),
      fetchJson: async (url, init) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) {
          return {
            ok: true,
            status: 200,
            body: { code: 0, msg: "success", data: { taskId: "rh-task-7788" } }
          };
        }
        return {
          ok: true,
          status: 200,
          body: {
            code: 0,
            msg: "success",
            data: [{ fileUrl: "https://rh-images.example/final.png", fileType: "image", width: 1024, height: 1536 }]
          }
        };
      }
    });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toMatchObject({
      url: "https://www.runninghub.cn/task/openapi/ai-app/run",
      init: { method: "POST", headers: { "Content-Type": "application/json" } }
    });
    expect(fetchCalls[0].init.headers?.Authorization).toBeUndefined();
    expect(JSON.parse(fetchCalls[0].init.body ?? "{}")).toMatchObject({
      apiKey: "rh-live-secret",
      webappId: "rh-webapp-7788",
      taskType: "ASYNC",
      instanceType: "plus"
    });
    expect(fetchCalls[1]).toMatchObject({
      url: "https://www.runninghub.cn/task/openapi/outputs",
      init: { method: "POST", headers: { "Content-Type": "application/json" } }
    });
    expect(JSON.parse(fetchCalls[1].init.body ?? "{}")).toEqual({ apiKey: "rh-live-secret", taskId: "rh-task-7788" });
    expect(result).toMatchObject({
      status: "succeeded",
      outputs: [{ name: "RunningHub Fashion Workflow output 1.png", source: "https://rh-images.example/final.png", width: 1024, height: 1536 }],
      providerProgress: {
        providerJobId: "rh-task-7788",
        status: "succeeded",
        statusUrl: "https://www.runninghub.cn/task/openapi/outputs",
        pollAttempts: 1
      }
    });
    expect(JSON.stringify(result)).not.toContain("rh-live-secret");
  });

  it("normalizes NanoBanana base64 image outputs", async () => {
    const providerRequest = request({
      modelId: nanoBananaModel.id,
      outputCount: 1,
      providerSettings: { size: "768x1024", quality: "high" }
    });
    const payload = buildProviderPayload(providerRequest, nanoBananaModel, {
      mode: "live-ready",
      endpointUrl: "https://nanobanana.example/v1/images",
      configuredSecrets: ["NANO_BANANA_API_KEY"],
      secretConfigured: true
    });

    const result = await executeLiveProviderPayload(payload, providerRequest, nanoBananaModel, "history-live-nano", 11, {
      resolveSecret: (name) => (name === "NANO_BANANA_API_KEY" ? "nano-live-secret" : undefined),
      fetchJson: async () => ({
        ok: true,
        status: 200,
        body: {
          status: "succeeded",
          images: [
            {
              b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAE=",
              mimeType: "image/png",
              width: 768,
              height: 1024
            }
          ]
        }
      })
    });

    expect(result.outputs).toEqual([
      {
        name: "Nano Banana 2 output 1.png",
        source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=",
        width: 768,
        height: 1024
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("nano-live-secret");
  });

  it("normalizes nested workflow result outputs with provider asset url fields", async () => {
    const providerRequest = request({
      modelId: runningHubModel.id,
      operation: "edit",
      outputCount: 1,
      referenceNodeIds: ["original-node"],
      providerSettings: { size: "1280x1280" }
    });
    const payload = buildProviderPayload(providerRequest, runningHubModel, {
      mode: "live-ready",
      endpointUrl: "https://comfy.example/api/workflows",
      configuredSecrets: ["COMFYUI_API_KEY"],
      secretConfigured: true
    });

    const result = await executeLiveProviderPayload(payload, providerRequest, runningHubModel, "history-comfy-nested", 8, {
      resolveSecret: (name) => (name === "COMFYUI_API_KEY" ? "comfy-live-secret" : undefined),
      fetchJson: async () => ({
        ok: true,
        status: 200,
        body: {
          status: "succeeded",
          result: {
            outputs: [
              {
                file_url: "https://cdn.example/comfy/final.webp",
                width: 1280,
                height: 1280,
                filename: "final.webp"
              }
            ]
          }
        }
      })
    });

    expect(result.outputs).toEqual([
      {
        name: "final.webp",
        source: "https://cdn.example/comfy/final.webp",
        width: 1280,
        height: 1280
      }
    ]);
  });

  it("keeps successful outputs visible when a provider reports an item failure", async () => {
    const providerRequest = request({ modelId: runningHubModel.id, outputCount: 2 });
    const payload = buildProviderPayload(providerRequest, runningHubModel, {
      mode: "live-ready",
      endpointUrl: "https://runninghub.example/api/run",
      configuredSecrets: ["RUNNINGHUB_API_KEY"],
      secretConfigured: true
    });

    const result = await executeLiveProviderPayload(payload, providerRequest, runningHubModel, "history-rh-partial", 8, {
      resolveSecret: (name) => (name === "RUNNINGHUB_API_KEY" ? "rh-live-secret" : undefined),
      fetchJson: async () => ({
        ok: true,
        status: 200,
        body: {
          status: "succeeded",
          outputs: [
            { url: "https://cdn.example/runninghub/ok.png", width: 1024, height: 1024 },
            { status: "failed", error: { message: "Second output blocked", code: "SAFETY" } }
          ]
        }
      })
    });

    expect(result.outputs).toEqual([
      {
        name: "RunningHub Fashion Workflow output 1.png",
        source: "https://cdn.example/runninghub/ok.png",
        width: 1024,
        height: 1024
      }
    ]);
    expect(result.providerProgress).toMatchObject({
      status: "succeeded",
      errorMessage: "Second output blocked (SAFETY)"
    });
  });

  it("rejects live provider execution before HTTP when configured secrets are missing", async () => {
    const providerRequest = request();
    const payload = buildProviderPayload(providerRequest, openAiModel, {
      mode: "live-ready",
      endpointUrl: "https://api.openai.example/v1/images",
      configuredSecrets: ["OPENAI_API_KEY"],
      secretConfigured: true
    });
    const fetchJson = vi.fn();

    await expect(
      executeLiveProviderPayload(payload, providerRequest, openAiModel, "history-missing-secret", 2, {
        resolveSecret: () => undefined,
        fetchJson
      })
    ).rejects.toThrow("Provider secret OPENAI_API_KEY is not configured");
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("normalizes nested OpenAI-style provider errors", async () => {
    const providerRequest = request();
    const payload = buildProviderPayload(providerRequest, openAiModel, {
      mode: "live-ready",
      endpointUrl: "https://api.openai.example/v1/images",
      configuredSecrets: ["OPENAI_API_KEY"],
      secretConfigured: true
    });

    await expect(
      executeLiveProviderPayload(payload, providerRequest, openAiModel, "history-openai-error", 2, {
        resolveSecret: (name) => (name === "OPENAI_API_KEY" ? "sk-live-secret" : undefined),
        fetchJson: async () => ({
          ok: false,
          status: 429,
          body: { error: { message: "OpenAI quota exceeded", code: "rate_limit_exceeded" } }
        })
      })
    ).rejects.toThrow("OpenAI quota exceeded (rate_limit_exceeded)");
  });

  it("normalizes workflow provider array errors into progress and thrown messages", async () => {
    const providerRequest = request({ modelId: runningHubModel.id });
    const payload = buildProviderPayload(providerRequest, runningHubModel, {
      mode: "live-ready",
      endpointUrl: "https://runninghub.example/api/run",
      configuredSecrets: ["RUNNINGHUB_API_KEY"],
      secretConfigured: true
    });
    const progressSnapshots: unknown[] = [];

    await expect(
      executeLiveProviderPayload(payload, providerRequest, runningHubModel, "history-rh-error", 8, {
        resolveSecret: (name) => (name === "RUNNINGHUB_API_KEY" ? "rh-live-secret" : undefined),
        onProgress: (progress) => progressSnapshots.push(progress),
        fetchJson: async () => ({
          ok: true,
          status: 200,
          body: {
            status: "failed",
            jobId: "rh-job-error",
            errors: [{ message: "RunningHub workflow validation failed", code: "INVALID_WORKFLOW" }]
          }
        })
      })
    ).rejects.toThrow("RunningHub workflow validation failed (INVALID_WORKFLOW)");
    expect(progressSnapshots[progressSnapshots.length - 1]).toMatchObject({
      providerJobId: "rh-job-error",
      status: "failed",
      errorMessage: "RunningHub workflow validation failed (INVALID_WORKFLOW)"
    });
  });
});
