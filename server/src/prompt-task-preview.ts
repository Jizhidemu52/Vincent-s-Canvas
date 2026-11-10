import type { PromptInput } from "../../shared/prompt-contracts";
import { PromptOptimizationError } from "./prompt-safety";

/** The public preview contains execution data only, never recipe rules or provider credentials. */
export function publicPromptTaskPreview(prepared: { prompt: string; promptInput?: PromptInput; parameters: Record<string, unknown>; summaryZh?: string; optimized?: boolean }) {
  if (!prepared.promptInput?.compilationId) throw new PromptOptimizationError("PROMPT_INPUT_REQUIRED", "生成前确认需要已编译的场景输入，未提交图片任务。", 400);
  const exclusions = prepared.parameters.promptExclusions as { mode?: string; negativePrompt?: string } | undefined;
  return { prompt: prepared.prompt, promptInput: prepared.promptInput, summaryZh: prepared.summaryZh, optimized: prepared.optimized === true,
    ...(exclusions?.mode === "native" && typeof exclusions.negativePrompt === "string" ? { nativeNegativePrompt: exclusions.negativePrompt } : {}) };
}
