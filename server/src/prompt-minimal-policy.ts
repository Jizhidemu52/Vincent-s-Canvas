import type { PromptInput } from "../../shared/prompt-contracts";
import { PromptOptimizationError } from "./prompt-safety";
import { imagePromptInvariantNumbers, instructionsWithoutArtworkLiterals } from "../../shared/image-prompt-invariants";

export const promptChainRevision = "semantic-bindings-v6";

/** Planner instructions stay server-side; only their visual result is submitted. */
export const minimalPromptPolicy = [
  "你是服装与图案任务的最小改写分析员，不是营销文案写手。用户的明确要求、指定文字、数量、参考图片分工优先。",
  "编辑类只明确修改内容、位置及关键保留项，目标为80个汉字或60个英文词；复杂且必要的约束允许超过目标，绝不能为缩短而删掉要求。生成类在信息不足时可补充展示与质感，目标不超过120英文词或200汉字。",
  "不要擅自增加颜色、HEX、人物、场景、装饰或可见部件数量。颜色只有用户明确提供色值或已选色库值时才保留；麻灰等混色效果用原名称与材质描述，不转换成单一HEX。智能配色可选择协调颜色名，但没有可信色库值时不编色号。",
  "每张参考图按编号和用途执行，不让配色、材质、图案参考迁移款式或背景。蒙版不是编号参考图。保留用户明确的禁止要求；不添加通用避免清单，不加入与任务无关的人体、安全或营销词。",
  "颜色、数量、文字、左右位置必须绑定原来的具体部位，不能把各个数字分别保留下来却交换对应对象。局部改色要明确目标区域的新颜色和保留区域的原色，不能把大身擅自扩成领口、门襟或辅料。左右沿用用户指定的穿着者或画面坐标，不把左胸改成右胸；坐标缺失且会实质影响结果时才提出简短问题，不自行反转。",
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
const quantityNumber = `(\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千]{1,8}|${englishNumber}(?:[ -]+(?:and[ -]+)?${englishNumber})*)`;
const affirmativeClauses = (text: string) => instructionsWithoutArtworkLiterals(text).split(/[，,。；;!！?？\n]/u)
  .map(clause => clause.split(/不要|不得|禁止|避免|不应|不能|\b(?:do not|don't|never|not|avoid|rather than|instead of)\b/iu)[0]!.trim()).filter(Boolean);
const quantityEntityAliases: Record<string, string> = { 纽扣: "button", 扣子: "button", button: "button", buttons: "button", 口袋: "pocket", 胸袋: "pocket", pocket: "pocket", pockets: "pocket", 花瓣: "petal", 瓣: "petal", petal: "petal", petals: "petal", 叶片: "leaf", 叶子: "leaf", 片叶: "leaf", leaf: "leaf", leaves: "leaf" };
const quantityEntities = "纽扣|扣子|口袋|胸袋|花瓣|瓣|叶片|叶子|片叶|buttons?\\b|pockets?\\b|petals?\\b|leaves\\b|leaf\\b";
const entityQuantityPattern = () => new RegExp(`(?<![A-Za-z\\d#])${quantityNumber}\\s*(?:[枚颗粒个片朵只]\\s*)?(${quantityEntities})`, "giu");
const preservesQuantity = (text: string) => /保留|保持|沿用|原样|不变|\b(?:keep|retain|preserve|unchanged)\b/iu.test(text);
const entityQuantities = (text: string, preservationOnly = false) => {
  const result = new Map<string, Set<string>>();
  const clauses = affirmativeClauses(text).filter(clause => !preservationOnly || preservesQuantity(clause));
  for (const match of clauses.join("\n").matchAll(entityQuantityPattern())) {
    const entity = quantityEntityAliases[match[2]!.toLowerCase()]!;
    const values = result.get(entity) ?? new Set<string>();
    for (const value of imagePromptInvariantNumbers(`${match[1]}枚`)) values.add(value);
    result.set(entity, values);
  }
  return result;
};
type ExplicitQuantityChange = { entity: string; from: string; to: string; clause: number; start: number; length: number; correction: boolean };
/** Only named old-count -> new-count instructions, plus an explicit correction
 * of one earlier preservation. This is not a general arithmetic/intent parser. */
const explicitQuantityChanges = (text: string) => {
  const clauses = instructionsWithoutArtworkLiterals(text).split(/[，,。；;!！?？\n]|\.(?!\d)/u).map(clause => clause.trim());
  const number = quantityNumber.slice(1, -1), unit = "(?:[枚颗粒个片朵只]\\s*)?";
  const change = "(?:改为|改成|改到|减少到|减少至|减至|增加到|增加至|增至|变为|变成)";
  const operand = `(?<from>${number})\\s*${unit}(?<entity>${quantityEntities})`;
  const target = `(?<to>${number})\\s*${unit}(?:(?<target>${quantityEntities}))?`;
  const patterns = [
    new RegExp(`(?:把|将)?\\s*${operand}\\s*${change}\\s*${target}`, "giu"),
    new RegExp(`\\b(?:change|reduce|increase|replace)\\s+${operand}\\s+to\\s+${target}`, "giu"),
    new RegExp(`^(?:(?:现(?:在)?)?更正|修正)\\s*[:：]\\s*(?:只)?(?:把|将)?\\s*(?<entity>${quantityEntities})(?:数量)?\\s*${change}\\s*${target}`, "giu"),
    new RegExp(`^correction\\s*:\\s*(?:change|reduce|increase)\\s+(?<entity>${quantityEntities})\\s+to\\s+${target}`, "giu"),
  ];
  const candidates: ExplicitQuantityChange[] = [];
  const locks = entityQuantities(text, true);
  for (const [index, clause] of clauses.entries()) {
    const positive = affirmativeClauses(clause)[0] ?? "";
    for (const [kind, pattern] of patterns.entries()) {
      for (const match of positive.matchAll(pattern)) {
        const groups = match.groups!, entity = quantityEntityAliases[groups.entity!.toLowerCase()]!;
        if (groups.target && quantityEntityAliases[groups.target.toLowerCase()] !== entity) continue;
        const correction = kind >= 2;
        const previous = correction ? entityQuantities(clauses.slice(0, index).join(";"), true).get(entity) : undefined;
        // A preservation/change conflict is not an implicit correction. Multiple
        // previous quantities are likewise not enough evidence to choose one.
        if (correction ? previous?.size !== 1 : locks.has(entity)) continue;
        const from = correction ? [...previous!][0]! : [...imagePromptInvariantNumbers(`${groups.from}枚`)][0]!;
        const to = [...imagePromptInvariantNumbers(`${groups.to}枚`)][0]!;
        candidates.push({ entity, from, to, clause: index, start: match.index!, length: match[0].length, correction });
      }
    }
  }
  // Identical structured-field echoes are not extra edits. Leave different
  // changes to the same entity conservative; do not guess their precedence.
  const changes = candidates.filter(value => candidates.every(other => other.entity !== value.entity || (other.from === value.from && other.to === value.to)));
  const effective = [...clauses];
  for (const value of [...changes].sort((a, b) => b.clause - a.clause || b.start - a.start)) {
    const clause = effective[value.clause]!;
    effective[value.clause] = clause.slice(0, value.start) + `${value.to} ${value.entity === "leaf" ? "leaves" : `${value.entity}s`}` + clause.slice(value.start + value.length);
    if (value.correction) for (let index = 0; index < value.clause; index += 1) {
      const positive = affirmativeClauses(effective[index]!)[0] ?? "";
      if (!preservesQuantity(positive)) continue;
      const withoutOldCount = positive.replace(entityQuantityPattern(), (whole, amount: string, name: string) => {
        return quantityEntityAliases[name.toLowerCase()] === value.entity && imagePromptInvariantNumbers(`${amount}枚`).has(value.from) ? name : whole;
      });
      effective[index] = withoutOldCount + effective[index]!.slice(positive.length);
    }
  }
  return { text: effective.join(";"), changes };
};
const garmentSides = (text: string) => {
  const aliases: Record<string, string> = { 胸: "chest", 胸部: "chest", chest: "chest", 袖: "sleeve", 袖子: "sleeve", sleeve: "sleeve", 袖口: "cuff", cuff: "cuff", 肩: "shoulder", shoulder: "shoulder" };
  const content = affirmativeClauses(text).join("\n").replace(/(?:画面|观看者|图像)(?:的)?(?:左|右)(?:侧的?)?(?:胸部?|袖口|袖子?|肩)|\b(?:viewer(?:'s)?|image(?:'s)?)\s+(?:left|right)\s+(?:chest|sleeve|cuff|shoulder)\b/giu, "");
  const result = new Map<string, Set<string>>();
  for (const match of content.matchAll(/(左|右|\bleft|\bright)\s*(?:侧的?)?(胸部?|袖口|袖子?|肩|chest\b|sleeve\b|cuff\b|shoulder\b)/giu)) {
    const part = aliases[match[2]!.toLowerCase()]!, side = /^(?:左|left)$/i.test(match[1]!) ? "left" : "right";
    const values = result.get(part) ?? new Set<string>(); values.add(side); result.set(part, values);
  }
  return result;
};

/** Do not silently repair output: a lost literal or invented value stops admission. */
export function assertMinimalPromptFidelity(prompt: string, inputText: string, questions: readonly string[] = []) {
  const suppliedHex = new Set(hexes(inputText));
  if (hexes(prompt).some(hex => !suppliedHex.has(hex))) throw new PromptOptimizationError("PROMPT_COLOR_INVENTED", "改写增加了未提供的色值，未提交生成；请保留颜色原话或提供指定色值。", 422);
  const effectiveInput = explicitQuantityChanges(inputText), effectiveOutput = explicitQuantityChanges(prompt);
  const inputQuantities = new Set([...quantities(inputText), ...quantities(effectiveInput.text)]), outputQuantities = new Set([...quantities(prompt), ...quantities(effectiveOutput.text)]);
  if (!questions.length && [...quantities(effectiveInput.text)].some(value => !outputQuantities.has(value))) throw new PromptOptimizationError("PROMPT_QUANTITY_NOT_PRESERVED", "改写未保留明确指定的数量或尺寸，未提交生成。", 422);
  if ([...outputQuantities].some(value => !inputQuantities.has(value))) throw new PromptOptimizationError("PROMPT_QUANTITY_INVENTED", "改写增加了未经确认的数量或尺寸，未提交生成；请先确认可见部件。", 422);
  // Only explicitly preserved quantities become binding invariants. Ordinary
  // change instructions and negative counterexamples are not affirmative locks.
  const supplied = entityQuantities(effectiveInput.text, true), outputEntities = entityQuantities(effectiveOutput.text);
  for (const [entity, values] of outputEntities) {
    const known = supplied.get(entity);
    if (known && [...values].some(value => !known.has(value))) throw new PromptOptimizationError("PROMPT_QUANTITY_BINDING_CHANGED", "改写改变了明确数量与对象的对应关系，未提交生成。", 422);
  }
  if (!questions.length && effectiveInput.changes.some(change => !outputEntities.get(change.entity)?.has(change.to))) throw new PromptOptimizationError("PROMPT_QUANTITY_BINDING_CHANGED", "改写未保留明确变更数量与对象的对应关系，未提交生成。", 422);
  const suppliedSides = garmentSides(inputText), outputSides = garmentSides(prompt);
  for (const [part, sides] of suppliedSides) {
    const changed = outputSides.get(part);
    if (sides.size === 1 && changed?.size === 1 && ![...changed].some(side => sides.has(side))) throw new PromptOptimizationError("PROMPT_SIDE_CHANGED", "改写颠倒了明确的左右部位，未提交生成。", 422);
  }
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
