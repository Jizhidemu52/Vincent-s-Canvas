import type { CanvasAssistantMessage } from "@/types/canvas";

const PROMPT_SECTION = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?(?:(?:完整|最终|英文|图片|图像|生图|生成|使用|实际使用|提交的)\s*)*提示词(?:\*\*)?\s*(?::|：|\n|$)|(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:(?:image|generation|final|english|used)\s+)*prompt(?:\*\*)?\s*:/iu;

/** Display-only filtering. Never use the returned text as generation/history input. */
export function canvasAssistantDisplayText(text: string, hiddenPrompt?: string): string {
    let visible = text
        .replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, "")
        .replace(/```(?:json)?[ \t]*\n([\s\S]*?)```/giu, (block, content: string) => /"(?:tool_calls|function|arguments|ops)"/u.test(content) ? "" : block);
    const promptStart = visible.search(PROMPT_SECTION);
    if (promptStart >= 0) visible = visible.slice(0, promptStart);
    if (hiddenPrompt?.trim()) visible = visible.split(hiddenPrompt.trim()).join("");
    return visible
        .split("\n")
        .filter(line => !/^\s*(?:\[?tool(?:_call| result)?\]?\s*:|canvas_[a-z_]+\b)/iu.test(line))
        .join("\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
}

/** Strip internals from a render copy, retaining the original message and assets. */
export function canvasAssistantDisplayMessage(message: CanvasAssistantMessage): CanvasAssistantMessage | null {
    if (message.role === "user") return message;
    if (message.role === "system" || message.detail?.kind === "agent_tool_progress") return null;
    const detail = message.detail;
    if (message.role === "tool") {
        if (detail?.status === "pending" || detail?.status === "running") {
            return { ...message, title: "待确认操作", text: canvasAssistantDisplayText(message.text) || "请确认是否执行本次画布操作。", meta: undefined, detail: { status: detail.status } };
        }
        // Keep an actionable workflow, but never its tool payload or execution log.
        return detail?.mediaWorkflow ? { ...message, role: "assistant", title: undefined, text: "", meta: undefined, detail: { mediaWorkflow: detail.mediaWorkflow } } : null;
    }
    const prompt = typeof detail?.prompt === "string" ? detail.prompt : undefined;
    let text = canvasAssistantDisplayText(message.text, prompt);
    if (Array.isArray(detail?.hiddenPrompts)) {
        for (const hidden of detail.hiddenPrompts) if (typeof hidden === "string" && hidden.trim()) text = text.split(hidden.trim()).join("").trim();
    }
    if (detail?.kind === "agent_generation") {
        const video = message.attachments?.some(item => item.mediaType === "video") || (detail.settings && typeof detail.settings === "object" && "mode" in detail.settings && detail.settings.mode === "video");
        if (detail.status === "running") text = video ? "正在生成视频…" : "正在生成图片…";
        if (!text && detail.status === "completed") text = video ? "视频已生成。" : `已生成 ${message.attachments?.length || 1} 张图片。`;
    }
    if (!text && !message.attachments?.length && !detail?.mediaWorkflow) return null;
    return { ...message, text, detail: detail?.mediaWorkflow ? { mediaWorkflow: detail.mediaWorkflow } : undefined };
}

/** Only explicit quoted artwork literals may retain a non-Latin script. */
const QUOTED_LITERAL = /"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|‘[^’\n]*’|「[^」\n]*」/gu;
const ENGLISH_LITERAL_LABEL = /\b(?:text|wording|words?|logo|label|lettering|inscription|reads?|reading|brand(?: name)?)\s*(?:(?:must|should)\s+be\s*|(?:is|as|says?|reads?)\s*)?[:=]?\s*$/iu;

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
function invariantNumbers(text: string): Set<string> {
    const count = `(?:\\d+|${SMALL_NUMBERS.join("|")})`;
    const source = instructionsWithoutArtworkLiterals(text)
        .replace(/\[\[ref:[^\]]+\]\]|\bimage\s*#?\s*\d+\b|图(?:片)?\s*[\d一二三四五六七八九十]+/giu, "")
        // Output count/aspect ratio are independently constrained by generation settings, not image-content counts.
        .replace(new RegExp(`(?:生成|输出|出图|制作|提供|返回|只要|只需)\\s*(?:仅|只|恰好)?\\s*\\d+\\s*张(?:图(?:片)?)?|\\b(?:generate|output|return|produce|want|need)\\s+(?:(?:only|exactly)\\s+)?${count}\\s+(?:images?|pictures?|outputs?|variations?)\\b|(?:比例|aspect\\s+ratio)\\s*[:：]?\\s*\\d+\\s*[:：]\\s*\\d+`, "giu"), "")
        .replace(/\b(?:both|a pair of)\s+(?=(?:[a-z]+\s+){0,2}(?:sleeves|cuffs|pockets|buttons|straps|handles|legs|shoes|socks|ears|eyes|wings)\b)/giu, "two ");
    const found = new Set(Array.from(source.matchAll(/\b\d+(?:\.\d+)?\b/gu), match => String(Number(match[0]))));
    const words = new RegExp(`\\b(${SMALL_NUMBERS.join("|")})\\b`, "giu");
    for (const match of source.matchAll(words)) found.add(String(SMALL_NUMBERS.indexOf(match[1]!.toLowerCase())));
    const chineseDigit = (value: string) => "零一二三四五六七八九".indexOf(value.replace("两", "二"));
    for (const match of source.matchAll(/([零一二两三四五六七八九十]{1,3})(?=颗|粒|枚|条|根|只|朵|片|瓣|排|行|列|圈|个(?:纽扣|口袋|花瓣|图案))/gu)) {
        const value = match[1]!;
        const number = value.includes("十") ? (value.split("十")[0] ? chineseDigit(value.split("十")[0]!) : 1) * 10 + (value.split("十")[1] ? chineseDigit(value.split("十")[1]!) : 0) : chineseDigit(value);
        if (number >= 0) found.add(String(number));
    }
    return found;
}

/** Deliberately narrow: lexical counts, explicit negation/preservation markers and artwork literals, not semantic equivalence. */
export function assertImagePromptInvariantCoverage(source: string, target: string, options: { negation?: boolean; supersededText?: string } = {}): void {
    const targetNumbers = invariantNumbers(target);
    const removedNumbers = invariantNumbers(options.supersededText || "");
    if (requiredArtworkLiterals(source).some(literal => !target.includes(literal) && !options.supersededText?.includes(literal))) throw new CanvasImagePromptLanguageError("英文指令遗漏必须保留的文字标识");
    if ([...invariantNumbers(source)].some(value => !targetNumbers.has(value) && !removedNumbers.has(value))) throw new CanvasImagePromptLanguageError("英文指令遗漏可确定的数量");
    const negativeSource = /\b(?:no|not|never|without|avoid|unchanged|unaltered|preserve|retain)\b|(?:不要|不能|不得|禁止|不许|不变|保持|保留)/iu.test(instructionsWithoutArtworkLiterals(source));
    const negativeTarget = /\b(?:no|not|never|without|avoid|unchanged|unaltered|preserve|retain|keep|leave)\b/iu.test(instructionsWithoutArtworkLiterals(target));
    if (options.negation !== false && negativeSource && !negativeTarget) throw new CanvasImagePromptLanguageError("英文指令遗漏明确的禁止或保留约束");
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
