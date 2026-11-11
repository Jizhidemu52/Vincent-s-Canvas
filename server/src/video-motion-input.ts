import { normalizeVideoMotionSettings } from "../../shared/video-motion-options";
import type { PromptInput } from "../../shared/prompt-contracts";
import { PromptOptimizationError } from "./prompt-safety";
import type { PromptRecipeStore } from "./prompt-recipe-store";
import { resolveVideoMode, type SupportedVideoModelId, type VideoProviderParameters } from "./video-models";

export const ensureVideoMotionRecipe = (store: PromptRecipeStore) => store.ensure("video-motion", {
  name: "图生视频动效", enabled: true, modelConfigId: null, failurePolicy: "stop",
});

export function assertVideoMotionPolicy(input: { operationType: string; toolKey?: string; promptInput?: PromptInput }, allowRawPrompt = false) {
  if (input.operationType !== "video_generation") return;
  if (input.promptInput && (input.promptInput.scene !== "video-motion" || input.promptInput.mode !== "video")) throw new PromptOptimizationError("PROMPT_OPERATION_INVALID", "视频任务只能使用视频动效规划");
  if (input.toolKey === "video" && !input.promptInput && !allowRawPrompt) throw new PromptOptimizationError("VIDEO_MOTION_REQUIRED", "请通过 AI 动效规划生成视频；管理员尚未开放原文直发", 403);
}

/** Apply motion choices to the actual provider parameters before validating media. */
export function videoMotionParameters(parameters: Record<string, unknown>, promptInput: PromptInput | undefined, mimeTypes: string[], model: SupportedVideoModelId): VideoProviderParameters & Record<string, unknown> {
  if (promptInput?.scene !== "video-motion") return { ...parameters };
  const motion = normalizeVideoMotionSettings(promptInput.fields);
  const imagesOnly = mimeTypes.every(mime => mime.startsWith("image/"));
  const explicit = parameters.videoMode ?? (model === "happyhorse-1.1" ? parameters.happyHorseMode : undefined);
  const automatic = explicit === undefined || explicit === "auto";
  // Seedance motion planning prefers frame pairs; other models retain their own auto semantics.
  const videoMode = automatic && imagesOnly && mimeTypes.length >= 1 && mimeTypes.length <= 2
    ? model === "doubao-seedance-2.5"
      ? mimeTypes.length === 1 ? "first-frame" : "first-last-frame"
      : resolveVideoMode(model, parameters, mimeTypes.map(mimeType => ({ mimeType, bytes: new Uint8Array() })))
    : undefined;
  // Omni's sound choices are prompt preferences, not an output mute switch.
  const { generateAudio: _generateAudio, ...omniParameters } = parameters;
  return { ...(model === "gemini-omni-1.2-flash" ? omniParameters : { ...parameters, generateAudio: motion.audio !== "none" }),
    ...(videoMode ? { videoMode } : {}),
  };
}

/** A validation-only marker: never submitted to the provider or saved as user input. */
export function videoPreflightPrompt(input: { prompt: string; promptInput?: PromptInput }) {
  return input.promptInput?.scene === "video-motion" ? "视频动效规划待生成" : input.prompt;
}
