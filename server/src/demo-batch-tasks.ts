export function createDemoBatchTaskInputs(input: {
  requestId: string;
  projectId: string;
  operationType: string;
  modelConfigId: string;
  prompt: string;
  parameters?: Record<string, unknown>;
  priority?: string;
  items: Array<{ sourceUrls: string[] }>;
}) {
  return input.items.map((item, index) => ({
    requestId: `${input.requestId}:${index}`,
    projectId: input.projectId,
    operationType: input.operationType === "batch_image" ? "inpaint" : input.operationType,
    modelConfigId: input.modelConfigId,
    prompt: input.prompt,
    parameters: input.parameters || {},
    sourceUrls: item.sourceUrls,
    priority: input.priority || "normal",
  }));
}
