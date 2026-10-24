import { parseStrictJson } from "./strict-json";

export class PromptOptimizationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

function normalized(value: string) { return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase(); }

/** The check inspects output, not instructions inside user input. Never include matched text in errors. */
export function assertNoPromptRuleLeak(output: unknown, privateRules: readonly string[], options: { strictEnglish?: boolean } = {}) {
  const raw = typeof output === "string" ? output : JSON.stringify(output);
  if (!raw) return;
  const candidate = normalized(raw);
  if (/(?:以下(?:是|为).{0,12}(?:系统提示词|内部规则|扩写配方)|system\s*prompt\s*[:：]|【(?:输出契约|信息优先级|扩写步骤|安全规则)】)/i.test(raw)) {
    throw new PromptOptimizationError("PROMPT_OUTPUT_REJECTED", "提示词优化输出未通过安全检查，未提交生成", 422);
  }
  for (const rule of privateRules) {
    // Match long authoring passages, not public tool names or short visual phrases.
    for (const paragraph of rule.split(/\r?\n/)) {
      const source = normalized(paragraph);
      if (source.length < 64) continue;
      for (let offset = 0; offset + 64 <= source.length; offset += 16) {
        const fragment = source.slice(offset, offset + 64);
        const authoringLanguage = options.strictEnglish || (fragment.match(/[\u3400-\u9fff]/g)?.length ?? 0) >= 12
          || /systemprompt|internalrules|outputcontract|instructionhierarchy|confidential/.test(fragment);
        if (authoringLanguage && candidate.includes(fragment)) {
          throw new PromptOptimizationError("PROMPT_OUTPUT_REJECTED", "提示词优化输出未通过安全检查，未提交生成", 422);
        }
      }
    }
  }
}

export function specifiedPromptText(userText: string, fields: Record<string, unknown>) {
  const result = new Set<string>();
  for (const match of userText.matchAll(/(?:文字|文案|字样|印字|标语|text|wording|slogan|lettering)[^\n“"「]{0,18}[“"「]([^”"」\n]{1,200})[”"」]/gi)) result.add(match[1]!);
  for (const [key, value] of Object.entries(fields)) if (/^(?:text|logoText|printText|visibleText|wording|slogan|lettering)$/i.test(key) && typeof value === "string" && value.trim()) result.add(value.trim());
  return [...result];
}

export function parseOptimizedPrompt(raw: string, rules: readonly string[], options: { reverse?: boolean; referenceCount: number; userText: string; language: "en" | "zh"; requiredText?: string[] }) {
  if (raw.length > 30_000) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化输出过长，未提交生成", 422);
  let result: unknown;
  try { result = parseStrictJson(raw); } catch { throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化未返回有效 JSON，未提交生成", 422); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化输出格式无效，未提交生成", 422);
  const value = result as Record<string, unknown>;
  const allowed = options.reverse ? ["prompt", "summary_zh"] : ["prompt", "avoid", "keep_text"];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 20_000) {
    throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化输出字段无效，未提交生成", 422);
  }
  assertNoPromptRuleLeak(result, rules);
  for (const reference of value.prompt.matchAll(/\bImage\s+(\d+)\b/gi)) {
    if (Number(reference[1]) < 1 || Number(reference[1]) > options.referenceCount) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "优化结果引用了不存在的参考图，未提交生成", 422);
  }
  if (options.reverse) {
    if (typeof value.summary_zh !== "string" || value.summary_zh.length > 1_000) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "反推摘要格式无效", 422);
    return { prompt: value.prompt.trim(), summaryZh: value.summary_zh, keepText: [] as string[] };
  }
  if (!Array.isArray(value.avoid) || value.avoid.length > 8 || value.avoid.some(item => typeof item !== "string" || item.length > 500)
    || !Array.isArray(value.keep_text) || value.keep_text.length > 50 || value.keep_text.some(item => typeof item !== "string" || !item.length || item.length > 1_000)) {
    throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词约束格式无效，未提交生成", 422);
  }
  const keepText = value.keep_text as string[];
  if (keepText.some(text => !options.userText.includes(text) || !(value.prompt as string).includes(text))
    || options.requiredText?.some(text => !keepText.includes(text) || !(value.prompt as string).includes(text))) {
    throw new PromptOptimizationError("PROMPT_TEXT_NOT_PRESERVED", "优化结果未原样保留指定文字，未提交生成", 422);
  }
  const avoid = (value.avoid as string[]).filter(Boolean);
  const prompt = [value.prompt.trim(), avoid.length ? `${options.language === "zh" ? "避免" : "Avoid"}: ${avoid.join(", ")}.` : ""].filter(Boolean).join("\n");
  if (prompt.length > 20_000) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "最终提示词过长，未提交生成", 422);
  return { prompt, keepText };
}
