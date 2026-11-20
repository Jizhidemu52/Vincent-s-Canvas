import { PromptOptimizationError } from "./prompt-safety";
import type { ChatCompletionResult } from "./routes/chat";

export function validatePromptOptimizerResponse(result: ChatCompletionResult, modelId: string) {
  if (modelId === "gpt-6.2-sol" && ((result.stopReason !== undefined && result.stopReason !== "stop") || result.toolCalls.length)) {
    throw new PromptOptimizationError("PROMPT_OUTPUT_REJECTED", "提示词优化未完整返回纯文本结果，未提交生成；不会自动重新提交。", 422);
  }
  return result;
}
