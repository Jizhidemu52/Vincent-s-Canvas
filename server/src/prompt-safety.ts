import { parseStrictJson } from "./strict-json";

export class PromptOptimizationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

/** Validate the final prompt even when it came from a cached compilation or fallback. */
export function assertVideoMotionTimeline(prompt: string, expectedDuration: unknown) {
  const text = prompt.normalize("NFKC");
  const reject = () => { throw new PromptOptimizationError("PROMPT_VIDEO_TIMELINE_INVALID", "动效规划未通过时间轴检查，未提交生成", 422); };
  if (/(?:改为|改成|改用|调整为|修正为|更正为)\s*整数秒/.test(text)) reject();
  // Capture decimal/clock/exponent endpoints too, so invalid ranges cannot be
  // skipped while a later integer range is mistaken for the complete timeline.
  const ranges = [...text.matchAll(/(?<![\d.:])([+-]?(?:\d+(?:[.:]\d+)*\.?|\.\d+)(?:e[+-]?\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?\b)?\s*(?:[-–—~～]|至|到|to)\s*([+-]?(?:\d+(?:[.:]\d+)*\.?|\.\d+)(?:e[+-]?\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?\b)/gi)];
  if (ranges.some(range => !/^\d+$/.test(range[1]!) || !/^\d+$/.test(range[2]!))) reject();
  // Automatic duration has no authoritative endpoint yet. Do not require a
  // timeline or force it to begin at zero for automatic/edit/continuation jobs.
  if (typeof expectedDuration !== "number" || !Number.isInteger(expectedDuration) || expectedDuration <= 0) return;
  if (!ranges.length) reject();
  let end = 0;
  for (const range of ranges) {
    const start = Number(range[1]), next = Number(range[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(next) || start !== end || next <= start) reject();
    end = next;
  }
  if (end !== expectedDuration) reject();
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
  // Quotation alone is not a request to render text: require a lettering cue,
  // paired quotes, and exclude explicit style descriptions or negated print actions.
  const literals = /(?:印上|印有|印着|写上|绣上|文字|文案|字样|印字|标语|\b(?:text|wording|slogan|lettering|print(?:ed)?|embroider(?:ed)?)\b)([^\n"'“‘「]{0,18})(?:"([^"\n]{1,1000})"|'([^'\n]{1,1000})'|“([^”\n]{1,1000})”|‘([^’\n]{1,1000})’|「([^」\n]{1,1000})」)/gi;
  for (const match of userText.matchAll(literals)) {
    const before = userText.slice(Math.max(0, match.index! - 16), match.index);
    if (/(?:风格|字体|排版|质感|\b(?:style|font|typography|texture)\b)/i.test(match[1]!)
      || /(?:不要|禁止|不许|无需|无|do not|don't|without|no)\s*$/i.test(before)) continue;
    result.add(match.slice(2).find(value => value !== undefined)!);
  }
  if (Object.hasOwn(fields, "keep_text")) {
    const explicit = fields.keep_text;
    if (!Array.isArray(explicit) || explicit.length > 50 || explicit.some(value => typeof value !== "string" || !value.trim() || value.length > 1_000)) {
      throw new PromptOptimizationError("PROMPT_TEXT_INVALID", "需保留文字必须为不超过 50 项的非空字符串数组，每项最多 1000 字符", 422);
    }
    for (const text of explicit as string[]) result.add(text);
  }
  for (const [key, value] of Object.entries(fields)) if (/^(?:text|logoText|printText|visibleText|wording|slogan|lettering)$/i.test(key) && typeof value === "string" && value.trim()) result.add(value.trim());
  return [...result];
}

function allowRequiredText(avoid: string, language: "en" | "zh") {
  // Only qualify standalone blanket bans. Keep targeted restrictions (such as
  // unrelated text, text labels, logos, or textured fabric) exactly as supplied.
  return avoid.split(/(\s*(?:[,;，；、/]|\band\b|\bor\b)\s*)/i).map(part => {
    const phrase = part.trim().replace(/[.!。！]+$/, "");
    return /^(?:(?:no|any|all|without)\s+)?(?:text|lettering|words|slogans?)$/i.test(phrase)
      || /^(?:无|不要|禁止|任何|所有)?(?:文字|文本|字样|标语)$/.test(phrase)
      ? language === "zh" ? "无关文字" : "unrelated text" : part;
  }).join("");
}

type PromptOutputOptions = { video?: boolean; reverse?: boolean; referenceCount: number; userText: string; language: "en" | "zh"; requiredText?: string[] };

/** Apply to fresh, fallback and cached final text before any generation admission. */
export function assertPromptOutputContent(prompt: string, rules: readonly string[], options: PromptOutputOptions) {
  if (!prompt.trim() || prompt.length > (options.video ? 1500 : 20_000)) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "最终提示词无效或过长，未提交生成", 422);
  assertNoPromptRuleLeak(prompt, rules);
  for (const reference of prompt.matchAll(/(?:\bImage\s*|图片\s*)(\d+)/gi)) {
    if (Number(reference[1]) < 1 || Number(reference[1]) > options.referenceCount) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "优化结果引用了不存在的参考图，未提交生成", 422);
  }
  if (options.requiredText?.some(text => !prompt.includes(text))) throw new PromptOptimizationError("PROMPT_TEXT_NOT_PRESERVED", options.video ? "动效规划未原样保留指定文字，未提交生成" : "优化结果未原样保留指定文字，未提交生成", 422);
}

export function parseOptimizedPrompt(raw: string, rules: readonly string[], options: PromptOutputOptions) {
  if (raw.length > 30_000) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化输出过长，未提交生成", 422);
  let result: unknown;
  try { result = parseStrictJson(raw); } catch { throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化未返回有效 JSON，未提交生成", 422); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化输出格式无效，未提交生成", 422);
  const value = result as Record<string, unknown>;
  const allowed = options.reverse || options.video ? ["prompt", "summary_zh"] : ["prompt", "avoid", "keep_text"];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > (options.video ? 1500 : 20_000)) {
    throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词优化输出字段无效，未提交生成", 422);
  }
  assertNoPromptRuleLeak(result, rules);
  assertPromptOutputContent(value.prompt, rules, options);
  if (options.video) {
    if (typeof value.summary_zh !== "string" || !value.summary_zh.trim() || value.summary_zh.length > 60 || /[\r\n]/.test(value.summary_zh)) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "动效说明必须为不超过 60 字的一句话", 422);
    return { prompt: value.prompt.trim(), summaryZh: value.summary_zh.trim(), keepText: [] as string[] };
  }
  if (options.reverse) {
    if (typeof value.summary_zh !== "string" || value.summary_zh.length > 1_000) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "反推摘要格式无效", 422);
    return { prompt: value.prompt.trim(), summaryZh: value.summary_zh, keepText: [] as string[] };
  }
  if (!Array.isArray(value.avoid) || value.avoid.length > 8 || value.avoid.some(item => typeof item !== "string" || item.length > 500)
    || !Array.isArray(value.keep_text) || value.keep_text.length > 50 || value.keep_text.some(item => typeof item !== "string" || !item.length || item.length > 1_000)) {
    throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "提示词约束格式无效，未提交生成", 422);
  }
  const reportedText = value.keep_text as string[];
  // Reference lettering is visual input, not necessarily transcribed user text.
  // The compiler has already loaded/authorized these images; this is not OCR
  // verification. Every reported literal must still occur in the final prompt.
  if (reportedText.some(text => (options.referenceCount === 0 && !options.userText.includes(text) && !options.requiredText?.includes(text)) || !(value.prompt as string).includes(text))
    || options.requiredText?.some(text => !(value.prompt as string).includes(text))) {
    throw new PromptOptimizationError("PROMPT_TEXT_NOT_PRESERVED", "优化结果未原样保留指定文字，未提交生成", 422);
  }
  // Missing metadata is repairable only when the actual prompt already retains
  // every explicit literal. Never invent or patch missing text into the prompt.
  const keepText = [...new Set([...reportedText, ...(options.requiredText || [])])];
  const avoid = (value.avoid as string[]).filter(Boolean).map(item => keepText.length ? allowRequiredText(item, options.language) : item);
  const prompt = [value.prompt.trim(), avoid.length ? `${options.language === "zh" ? "避免" : "Avoid"}: ${avoid.join(", ")}.` : ""].filter(Boolean).join("\n");
  if (prompt.length > 20_000) throw new PromptOptimizationError("PROMPT_OUTPUT_INVALID", "最终提示词过长，未提交生成", 422);
  return { prompt, keepText };
}
