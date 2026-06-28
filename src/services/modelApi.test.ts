import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationRequest } from "../domain/workspace";
import { submitGenerationRequest } from "./modelApi";

describe("model API service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits generation requests to the endpoint declared for the workflow operation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "succeeded",
          outputs: [],
          creditCost: 2,
          historyId: "history-remove-bg"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const request: GenerationRequest = {
      projectId: "project-1",
      nodeId: "node-1",
      modelId: "background-cleaner",
      prompt: "",
      referenceNodeIds: ["node-1"],
      outputCount: 1,
      operation: "removeBackground"
    };

    await submitGenerationRequest(request, "designer@company.local");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/remove-bg",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-user-id": "designer@company.local"
        })
      })
    );
  });
});
