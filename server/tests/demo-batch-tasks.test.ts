import { expect, test } from "bun:test";

import { createDemoBatchTaskInputs } from "../src/demo-batch-tasks";

test("turns every canvas batch-edit item into a supported image task", () => {
  expect(
    createDemoBatchTaskInputs({
      requestId: "batch-1",
      projectId: "canvas-1",
      operationType: "batch_image",
      modelConfigId: "model-1",
      prompt: "make the background white",
      parameters: { size: "1:1" },
      priority: "normal",
      items: [{ sourceUrls: ["/api/assets/a/content"] }, { sourceUrls: ["/api/assets/b/content"] }],
    }),
  ).toEqual([
    {
      requestId: "batch-1:0",
      projectId: "canvas-1",
      operationType: "inpaint",
      modelConfigId: "model-1",
      prompt: "make the background white",
      parameters: { size: "1:1" },
      sourceUrls: ["/api/assets/a/content"],
      priority: "normal",
    },
    {
      requestId: "batch-1:1",
      projectId: "canvas-1",
      operationType: "inpaint",
      modelConfigId: "model-1",
      prompt: "make the background white",
      parameters: { size: "1:1" },
      sourceUrls: ["/api/assets/b/content"],
      priority: "normal",
    },
  ]);
});
