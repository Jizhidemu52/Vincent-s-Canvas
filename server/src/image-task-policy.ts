const imageOperations = new Set(["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"]);

/** Each explicit image task produces one result; independent tasks/concurrency remain allowed. */
export function singleImageTaskParameters(operationType: string, parameters: Record<string, unknown> = {}) {
  if (!imageOperations.has(operationType)) return parameters;
  return { ...parameters, n: 1, count: 1 };
}
