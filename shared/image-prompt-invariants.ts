/** Only explicit quoted artwork literals may retain a non-Latin script. */
const QUOTED_LITERAL = /"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’|「[^」\n]*」/gu;
const ENGLISH_LITERAL_LABEL = /(?:\b(?:text|wording|words?|logo|label|lettering|inscription|reads?|reading|brand(?: name)?)\s*(?:(?:must|should)\s+be\s*|(?:is|as|says?|reads?)\s*)?[:=]?\s*|(?:文字|字样|标语|品牌|商标|标签)\s*(?:为|是|写着|改为)?\s*[:：]?\s*)$/iu;

export function instructionsWithoutArtworkLiterals(prompt: string): string {
    return prompt.replace(QUOTED_LITERAL, (literal, offset: number) => {
        const introduction = prompt.slice(Math.max(0, offset - 100), offset);
        return ENGLISH_LITERAL_LABEL.test(introduction) ? " literal " : literal;
    });
}

/** Transform instruction spans only; explicit artwork wording is literal data, not a reference expression. */
export function transformImagePromptInstructions(prompt: string, transform: (text: string) => string): string {
    let start = 0, result = "";
    for (const match of prompt.matchAll(QUOTED_LITERAL)) {
        const index = match.index!;
        if (!ENGLISH_LITERAL_LABEL.test(prompt.slice(Math.max(0, index - 100), index))) continue;
        result += transform(prompt.slice(start, index)) + match[0];
        start = index + match[0].length;
    }
    return result + transform(prompt.slice(start));
}

function requiredArtworkLiterals(prompt: string): string[] {
    return Array.from(prompt.matchAll(QUOTED_LITERAL)).filter(match => {
        const introduction = prompt.slice(Math.max(0, match.index - 100), match.index);
        return ENGLISH_LITERAL_LABEL.test(introduction) || /(?:文字|字样|标语|品牌|商标|标签)[^。！？\n]*$/u.test(introduction);
    }).map(match => match[0].slice(1, -1));
}

function isBareEnglishPrompt(prompt: string): boolean {
    return isEnglishImagePrompt(prompt) && !/```|<\/?(?:think|analysis|reasoning)\b/iu.test(prompt);
}

/** A script guard, not a general-purpose language detector; the system policy supplies English semantics. */
export function isEnglishImagePrompt(prompt: string): boolean {
    const instructions = instructionsWithoutArtworkLiterals(prompt);
    return /[a-z]/iu.test(instructions) && !Array.from(instructions).some(character => /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character));
}

export class CanvasImagePromptLanguageError extends Error {
    readonly code = "IMAGE_PROMPT_LANGUAGE_REQUIRED";
    readonly submitted = false;
    constructor(reason = "未能整理出完整英文生图指令") {
        super(`${reason}，本次未提交图片生成任务；请重新整理指令。`);
        this.name = "CanvasImagePromptLanguageError";
    }
}

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const ENGLISH_NUMBERS: Record<string, number> = { ...Object.fromEntries(SMALL_NUMBERS.map((word, index) => [word, index])), thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
export function imagePromptInvariantNumbers(text: string): Set<string> {
    const count = `(?:\\d+|${SMALL_NUMBERS.join("|")})`;
    const source = instructionsWithoutArtworkLiterals(text)
        .replace(/\[\[ref:[^\]]+\]\]|\bimage\s*#?\s*\d+\b|图(?:片)?\s*[\d一二三四五六七八九十]+/giu, "")
        // Output count/aspect ratio are independently constrained by generation settings, not image-content counts.
        .replace(new RegExp(`(?:生成|输出|出图|制作|提供|返回|只要|只需)\\s*(?:仅|只|恰好)?\\s*\\d+\\s*张(?:图(?:片)?)?|\\b(?:generate|output|return|produce|want|need)\\s+(?:(?:only|exactly)\\s+)?${count}\\s+(?:images?|pictures?|outputs?|variations?)\\b|(?:比例|aspect\\s+ratio)\\s*[:：]?\\s*\\d+\\s*[:：]\\s*\\d+`, "giu"), "")
        .replace(/\b(?:both|a pair of)\s+(?=(?:[a-z]+\s+){0,2}(?:sleeves|cuffs|pockets|buttons|straps|handles|legs|shoes|socks|ears|eyes|wings)\b)/giu, "two ");
    const found = new Set(Array.from(source.matchAll(/(?<![A-Za-z0-9_.])\d+(?:\.\d+)?(?![\d.])/gu), match => String(Number(match[0]))));
    const word = `(?:${Object.keys(ENGLISH_NUMBERS).join("|")})`;
    for (const match of source.matchAll(new RegExp(`\\b${word}(?:[ -]+(?:and[ -]+)?${word})*\\b`, "giu"))) {
        let total = 0, part = 0;
        for (const token of match[0].toLowerCase().split(/[ -]+/u)) {
            const value = ENGLISH_NUMBERS[token];
            if (value === 1000) { total += (part || 1) * value; part = 0; }
            else if (value === 100) part = (part || 1) * value;
            else if (value !== undefined) part += value;
        }
        found.add(String(total + part));
    }
    const chineseDigit = (value: string) => "零一二三四五六七八九".indexOf(value.replace("两", "二"));
    for (const match of source.matchAll(/([零一二两三四五六七八九十百千]{1,8})(?=颗|粒|枚|条|根|只|朵|片|瓣|排|行|列|圈|组|双|毫米|厘米|米|度|倍|个(?:纽扣|口袋|花瓣|图案))/gu)) {
        let total = 0, digit = 0;
        for (const character of match[1]!) {
            const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[character];
            if (unit) { total += (digit || 1) * unit; digit = 0; }
            else digit = chineseDigit(character);
        }
        found.add(String(total + digit));
    }
    return found;
}

/** Deliberately narrow: lexical counts, explicit negation/preservation markers and artwork literals, not semantic equivalence. */
export function assertImagePromptInvariantCoverage(source: string, target: string, options: { negation?: boolean; supersededText?: string } = {}): void {
    const targetNumbers = imagePromptInvariantNumbers(target);
    const removedNumbers = imagePromptInvariantNumbers(options.supersededText || "");
    if (requiredArtworkLiterals(source).some(literal => !target.includes(literal) && !options.supersededText?.includes(literal))) throw new CanvasImagePromptLanguageError("执行指令遗漏必须保留的文字标识");
    if ([...imagePromptInvariantNumbers(source)].some(value => !targetNumbers.has(value) && !removedNumbers.has(value))) throw new CanvasImagePromptLanguageError("执行指令遗漏可确定的数量");
    const negativeSource = /\b(?:no|not|never|without|avoid|unchanged|unaltered|preserve|retain)\b|(?:不要|不能|不得|禁止|不许|不变|保持|保留)/iu.test(instructionsWithoutArtworkLiterals(source));
    const negativeTarget = /\b(?:no|not|never|without|avoid|unchanged|unaltered|preserve|retain|keep|leave)\b|(?:不要|不能|不得|禁止|不许|不变|保持|保留)/iu.test(instructionsWithoutArtworkLiterals(target));
    if (options.negation !== false && negativeSource && !negativeTarget) throw new CanvasImagePromptLanguageError("执行指令遗漏明确的禁止或保留约束");
}

/** Validate before any billed image dispatch; translate at most once, and never invent a fallback. */
export async function ensureEnglishImagePrompt(
    prompt: string,
    translate?: (source: string) => Promise<string>,
    options: { requiresPrompt?: boolean } = {},
): Promise<string> {
    const source = prompt.trim();
    if (!source && options.requiresPrompt === false) return "";
    if (isBareEnglishPrompt(source)) return source;
    if (!source || !translate) throw new CanvasImagePromptLanguageError();
    let translated: string;
    try {
        translated = (await translate(source)).trim();
    } catch {
        throw new CanvasImagePromptLanguageError();
    }
    if (!isBareEnglishPrompt(translated)) throw new CanvasImagePromptLanguageError();
    assertImagePromptInvariantCoverage(source, translated);
    return translated;
}
