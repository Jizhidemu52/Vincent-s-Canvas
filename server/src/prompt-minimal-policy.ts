import type { PromptInput } from "../../shared/prompt-contracts";
import { PromptOptimizationError } from "./prompt-safety";
import { imagePromptInvariantNumbers, instructionsWithoutArtworkLiterals } from "../../shared/image-prompt-invariants";

export const promptChainRevision = "short-visual-v3";

/** Planner instructions stay server-side; only their visual result is submitted. */
export const minimalPromptPolicy = [
  "你是服装与图案任务的最小改写分析员，不是营销文案写手。用户的明确要求、指定文字、数量、参考图片分工优先。",
  "编辑类只明确修改内容、位置及关键保留项，目标为80个汉字或60个英文词；复杂且必要的约束允许超过目标，绝不能为缩短而删掉要求。生成类在信息不足时可补充展示与质感，目标不超过120英文词或200汉字。",
  "不要擅自增加颜色、HEX、人物、场景、装饰或可见部件数量。颜色只有用户明确提供色值或已选色库值时才保留；麻灰等混色效果用原名称与材质描述，不转换成单一HEX。智能配色可选择协调颜色名，但没有可信色库值时不编色号。",
  "每张参考图按编号和用途执行，不让配色、材质、图案参考迁移款式或背景。蒙版不是编号参考图。保留用户明确的禁止要求；不添加通用避免清单，不加入与任务无关的人体、安全或营销词。",
  "只写图片模型能执行的视觉内容，不写历史优先级、用户确认、免责声明、规划步骤或来源追踪。原始数量和指定图中文字按原样保留。看不清的部件不猜测，不把推断的计数写成锁定事实。",
  "如果缺少会实质改变结果的信息，用questions给出最多两个简短中文问题（可包含选项），prompt保留用户原话或明确部分，不代替用户做选择。没有歧义时questions为空数组，不为常规任务制造问题。",
  "只输出严格JSON对象：prompt、summary_zh、avoid、keep_text、questions。summary_zh是一句不超过200字的中文执行摘要；avoid仅列本任务必要的排除项，通常0至3项，不附加通用列表；keep_text是需要逐字呈现的文字数组；questions为空或最多两个问题。",
].join("\n");

const hexes = (text: string) => [...text.matchAll(/#[\da-f]{3}(?:[\da-f]{3})?\b/gi)].map(match => {
  const value = match[0]!.toUpperCase();
  return value.length === 4 ? `#${value.slice(1).split("").map(part => part + part).join("")}` : value;
});
const englishNumber = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)";
const quantityPattern = new RegExp(`(?<![A-Za-z\\d#])(\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千]{1,8}|${englishNumber}(?:[ -]+(?:and[ -]+)?${englishNumber})*)\\s*(?:颗|粒|枚|个|只|处|条|根|朵|片|瓣|组|排|行|层|厘米|毫米|公分|cm\\b|mm\\b|%|buttons?\\b|pockets?\\b|pieces?\\b|rows?\\b|lines?\\b|layers?\\b|petals?\\b|leaves\\b)`, "giu");
const quantities = (text: string) => {
  const content = instructionsWithoutArtworkLiterals(text).replace(/\bimage\s*#?\s*\d+\b|图(?:片)?\s*[\d一二三四五六七八九十]+/giu, "")
    .replace(/单(?=朵|个|只|片|枚|颗|条|行|组|排|层)/gu, "一")
    .replace(/\b(?:a single|single)\s+(?=button|pocket|piece|row|line|layer|petal|leaf)/giu, "one ");
  return new Set([...content.matchAll(quantityPattern)].flatMap(match => [...imagePromptInvariantNumbers(`${match[1]}枚`)]));
};

/** Do not silently repair output: a lost literal or invented value stops admission. */
export function assertMinimalPromptFidelity(prompt: string, inputText: string, questions: readonly string[] = []) {
  const suppliedHex = new Set(hexes(inputText));
  if (hexes(prompt).some(hex => !suppliedHex.has(hex))) throw new PromptOptimizationError("PROMPT_COLOR_INVENTED", "改写增加了未提供的色值，未提交生成；请保留颜色原话或提供指定色值。", 422);
  const inputQuantities = quantities(inputText), outputQuantities = quantities(prompt);
  if (!questions.length && [...inputQuantities].some(value => !outputQuantities.has(value))) throw new PromptOptimizationError("PROMPT_QUANTITY_NOT_PRESERVED", "改写未保留明确指定的数量或尺寸，未提交生成。", 422);
  if ([...outputQuantities].some(value => !inputQuantities.has(value))) throw new PromptOptimizationError("PROMPT_QUANTITY_INVENTED", "改写增加了未经确认的数量或尺寸，未提交生成；请先确认可见部件。", 422);
}

export function promptOutputMetrics(prompt: string, input: Pick<PromptInput, "mode">, avoid: readonly string[] = []) {
  const characters = Array.from(prompt).length;
  const chinese = (prompt.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (prompt.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  const avoidTerms = avoid.length ? avoid : prompt.split(/(?:^|\n)(?:Avoid|避免):\s*/i).slice(1);
  const avoidPhrases = avoidTerms.flatMap(value => value.split(/[,;，；、]|\band\b|\bor\b/i).map(part => part.trim()).filter(Boolean)).length;
  const overRecommended = input.mode === "edit" ? chinese > 80 || words > 60 : chinese > 200 || words > 120;
  return { characters, words, avoidPhrases, overRecommended };
}
