import type { AdminPromptCompilation, PromptInput } from "../../shared/prompt-contracts";
import { requiredPromptScene } from "../../shared/prompt-contracts";
import {getToolDefinition} from "../../shared/feature-catalog";
import type { AppConfig } from "./config";
import { PromptOptimizationError } from "./prompt-safety";

export type PromptFallbackPolicy = Pick<AppConfig, "PROMPT_OPTIMIZATION_TIMEOUT_MS" | "PROMPT_OPTIMIZATION_FALLBACK" | "PROMPT_FALLBACK_TOOL_KEYS">;

export function directCreativePrompt(input:PromptInput,tool:string|undefined,fields:Record<string,unknown>,roles:readonly string[]){
  if(!tool?.startsWith("creative-")||requiredPromptScene(tool)!==input.scene)throw new PromptOptimizationError("PROMPT_RECIPE_MISMATCH","此入口不能使用创意场景的原始设计输入",400);
  const text=input.userText.trim();
  const selected=Object.fromEntries(Object.entries(fields).filter(([k,v])=>v!=null&&v!==""&&!(Array.isArray(v)&&!v.length)&&!(["change","description"].includes(k)&&v===text)));
  return {prompt:[getToolDefinition(tool)?.label,text,Object.keys(selected).length?`按以下设计设置执行：${JSON.stringify(selected)}`:"",roles.length>1?roles.map((role,i)=>`图片${i+1}：${role}`).join("；"):"",input.hasMask?"仅修改蒙版选区，保留其余部分。":""].filter(Boolean).join("\n"),summaryZh:"已使用本次设计输入，未调用改写模型。"};
}

export function allowsOriginalPrompt(policy: PromptFallbackPolicy | undefined, tool: string | undefined, input: PromptInput) {
  return !!tool && policy?.PROMPT_OPTIMIZATION_FALLBACK === "original" && tool.startsWith("creative-") && requiredPromptScene(tool) === input.scene
    && policy.PROMPT_FALLBACK_TOOL_KEYS.split(",").some(key => [tool, "creative-*"].includes(key.trim()));
}

export function originalFallbackPrompt(policy: PromptFallbackPolicy | undefined, tool: string | undefined, input: PromptInput, result: AdminPromptCompilation) {
  if (!allowsOriginalPrompt(policy, tool, input)) return;
  if (result.status !== "failed" || result.adminTest || !["PROMPT_OPTIMIZATION_TIMEOUT", "PROMPT_PREPARATION_FAILED", "PROMPT_OPTIMIZATION_FAILED"].includes(result.errorCode ?? "")) return;
  if (result.upstreamStatus !== undefined && result.upstreamStatus !== 429 && result.upstreamStatus < 500) return;
  const original = input.userText.trim();
  if (!original) return;
  const fields = Object.fromEntries(Object.entries(input.fields).filter(([key, value]) => value != null && value !== "" && !(Array.isArray(value) && !value.length) && !(["change","description"].includes(key) && value === original)));
  return [original,
    ...(Object.keys(fields).length ? [`场景 ${input.scene}；按以下原始设置执行：${JSON.stringify(fields)}`] : []),
    ...(input.referenceRoles.length ? [input.referenceRoles.map((role, i) => `图${i + 1}：${role}`).join("；")] : [])].join("\n");
}

export async function withOptimizerDeadline<T>(ms: number, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new PromptOptimizationError("PROMPT_OPTIMIZATION_TIMEOUT", "提示词优化超时，尚未提交图片任务", 408);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try { return await Promise.race([invoke(controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}
