import { processImageResult } from "./image-result-processing";
import { IMAGE_RESULT_POSTPROCESS_FAILURE_CODE, IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX } from "../../shared/generation-error";
import { quickImageResultAction } from "./quick-image-tools";
import { inspectGifFrames } from "./gif-image";

type ImageBytes = { bytes: Uint8Array; mimeType: string };
type AssetReference = { assetId: string; mimeType: string; filename: string };
type ResultRole = "primary" | "provider-original" | "export";
type EditInput = { references: ImageBytes[]; mask?: ImageBytes };
type StoredResultInput = {
  result: ImageBytes;
  parameters: Record<string, unknown>;
  resultIndex: number;
  prepareEditInput?: () => Promise<EditInput>;
  save: (role: ResultRole, image: ImageBytes, metadata: Record<string, unknown>) => Promise<AssetReference>;
  updateMetadata: (asset: AssetReference, metadata: Record<string, unknown>) => Promise<void>;
  process?: typeof processImageResult;
};

export class ImageResultPersistenceError extends Error {
  readonly code = IMAGE_RESULT_POSTPROCESS_FAILURE_CODE;
  constructor(readonly original: AssetReference, cause: unknown) {
    super(`${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：${cause instanceof Error ? cause.message : "本地处理失败"}；任务已暂停，不会自动重新生成。`, { cause });
  }
}

export function hasImageResultProcessing(parameters: Record<string, unknown>) {
  const archive = parameters.inputArchive as Record<string, unknown> | undefined;
  return Boolean(quickImageResultAction(parameters)) || parameters.background === "transparent" || archive?.maskReferenceIndex !== undefined || ["png", "jpeg", "webp", "gif"].includes(String(parameters.output_format));
}

/** Persist upstream bytes before any fallible local decoding, mask loading or conversion. */
export async function storeImageResult(input: StoredResultInput): Promise<AssetReference> {
  if (!hasImageResultProcessing(input.parameters)) return input.save("primary", input.result, {});
  // Initially visible: if processing is interrupted this original remains recoverable in the library.
  const original = await input.save("provider-original", input.result, {});
  try {
    if (input.parameters.output_format === "gif") {
      const gif = await inspectGifFrames(input.result.bytes);
      if (input.result.mimeType !== "image/gif" || input.parameters.background === "transparent" || input.parameters.output_compression !== undefined) throw new Error("GIF 结果格式或参数不一致；原件已保留");
      if (gif.frames !== (input.parameters.frame_count ?? 9)) throw new Error("GIF 实际帧数与请求不一致；原件已保留，不会自动重新生成");
      await input.updateMetadata(original, { imageResult: { version: 1, resultIndex: input.resultIndex, original, role: "primary",
        maskComposited: false, requestedOutputFormat: "gif", operations: ["original_gif_animation_preserved"], animated: true, frameCount: gif.frames } });
      return original;
    }
    const editInput = await input.prepareEditInput?.();
    const processed = await (input.process ?? processImageResult)({ result: input.result, parameters: input.parameters, editInput });
    const format = String(input.parameters.output_format || "");
    const compression = Number(input.parameters.output_compression);
    const common = {
      version: 1, resultIndex: input.resultIndex, original,
      maskComposited: processed.operations.includes("strict_mask_composite"),
      ...(["png", "jpeg", "webp"].includes(format) ? { requestedOutputFormat: format } : {}),
      ...(["jpeg", "webp"].includes(format) && input.parameters.output_compression !== undefined && input.parameters.output_compression !== "" && Number.isInteger(compression) ? { outputCompression: compression } : {}),
      operations: processed.operations,
      ...(quickImageResultAction(input.parameters) ? { quickImageAction: quickImageResultAction(input.parameters), recipeVersion: 1 } : {}),
    };
    let warning = processed.warning;
    let exported: AssetReference | undefined;
    if (processed.export) {
      try {
        exported = await input.save("export", processed.export, { imageResult: { ...common, role: "export" } });
      } catch {
        warning = [warning, "指定格式副本保存失败；无损主图和渠道原件已保留。"].filter(Boolean).join(" ");
      }
    }
    const metadata = { imageResult: { ...common, role: "primary", ...(exported ? { export: exported } : {}), ...(warning ? { warning } : {}) } };
    if (processed.display.bytes === input.result.bytes && processed.display.mimeType === input.result.mimeType && !exported) {
      await input.updateMetadata(original, metadata);
      return original;
    }
    const primary = await input.save("primary", processed.display, metadata);
    await input.updateMetadata(original, { imageResult: { ...common, role: "provider-original" } });
    return primary;
  } catch (error) {
    // No paid replay, no original overwrite, and no raw image masquerading as a strict composite.
    throw new ImageResultPersistenceError(original, error);
  }
}

export function imageResultExtension(mimeType: string) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" } as Record<string, string>)[mimeType] || "png";
}
