import type { CanvasAssistantReference } from "@/types/canvas";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { assertImagePromptInvariantCoverage, instructionsWithoutArtworkLiterals, isEnglishImagePrompt, transformImagePromptInstructions } from "./canvas-assistant-output";

const GROUPS = ["changes", "preserve", "forbid"] as const;
type Group = typeof GROUPS[number];
export type CanvasEditClause = { id: string; text: string; source: string };
/** Current requested targets, never a claim that the user approved the generated pixels. */
export type CanvasEditContract = Record<Group, CanvasEditClause[]>;


export class CanvasEditContractError extends Error {
    readonly code = "IMAGE_EDIT_CONTRACT_INVALID";
    readonly submitted = false;
    constructor(reason: string, readonly expectedMode?: "complete" | "update") { super(`${reason}；尚未提交图片生成。请按当前目标重新整理工具参数，不要自动重试生图。`); this.name = "CanvasEditContractError"; }
}
const fail = (message: string, expectedMode?: "complete" | "update"): never => { throw new CanvasEditContractError(message, expectedMode); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("缺少完整 editContract");
const string = (value: unknown, field: string, max = 2000) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : fail(`${field} 无效`);
const array = (value: unknown, field: string): unknown[] => Array.isArray(value) && value.length <= 24 ? value : fail(`${field} 必须为有限数组`);
const clauseId = (value: unknown) => { const id = string(value, "constraint id", 80); return /^[a-z][a-z0-9_.-]*$/i.test(id) ? id : fail("约束 id 必须是稳定英文标识"); };

function clauses(value: unknown, field: string): CanvasEditClause[] {
    return array(value, field).map(entry => { const item = object(entry); return { id: clauseId(item.id), text: string(item.text, `${field}.text`), source: string(item.source, `${field}.source`) }; });
}

/** Tolerant only of absence in legacy history; malformed saved contracts are never silently discarded. */
export function readCanvasEditContract(value: unknown): CanvasEditContract | undefined {
    if (value === undefined) return undefined;
    const input = object(value), result = Object.fromEntries(GROUPS.map(group => [group, clauses(input[group], group)])) as CanvasEditContract;
    const ids = GROUPS.flatMap(group => result[group].map(item => item.id));
    if (new Set(ids).size !== ids.length || !ids.length) fail("已保存修改目标存在重复或为空");
    return result;
}

function bindReferences(text: string, references: CanvasAssistantReference[]): string {
    return transformImagePromptInstructions(text, instructions => {
    // Numbered references are ambiguous after a subset/reorder. Single-image Image 1 is unambiguous.
    for (const match of instructions.matchAll(/\bimage\s*#?\s*(\d+)\b|图片\s*(\d+)/giu)) {
        const index = Number(match[1] || match[2]);
        if (references.length !== 1 || index !== 1) fail("图片编号无法可靠映射，请使用 [[ref:真实id]]");
    }
    const bound = instructions.replace(/\[\[ref:([^\]\r\n]+)\]\]/gu, (_match, id: string) => {
        const index = references.findIndex(ref => ref.id === id);
        return index >= 0 ? `Image ${index + 1}` : fail(`参考图 ${id} 不在本次实际传图中`);
    });
    if (/\[\[ref:/u.test(bound)) fail("参考图占位符格式无效");
    return bound;
    });
}

/** Pure replay entry: the same function handles captured model JSON before any provider call. */
export function compileCanvasEditContract(input: {
    contract: unknown; previous?: CanvasEditContract; continuing: boolean; userPrompt: string;
    legacySources?: string[]; draftPrompt: string; references: CanvasAssistantReference[]; prefix?: string;
}): { contract: CanvasEditContract; prompt: string } {
    const raw = object(input.contract), previous = input.continuing ? readCanvasEditContract(input.previous) : undefined;
    if (raw.mode !== "complete" && raw.mode !== "update") fail("editContract.mode 必须为 complete 或 update");
    if (previous && raw.mode !== "update") fail("已有目标必须 update，并显式 supersedes，不得整份替换丢失历史目标", "update");
    if (!previous && raw.mode !== "complete") fail("新任务或旧历史无合同，必须提供 complete 当前完整目标，不能只给本轮差量", "complete");
    const supersedes = array(raw.supersedes, "supersedes").map(clauseId);
    if (new Set(supersedes).size !== supersedes.length) fail("supersedes 重复");
    const oldIds = new Set(previous ? GROUPS.flatMap(group => previous[group].map(item => item.id)) : []);
    if (supersedes.some(id => !oldIds.has(id))) fail("supersedes 指向不存在的历史约束");
    const next = Object.fromEntries(GROUPS.map(group => [group, clauses(raw[group], group)])) as CanvasEditContract;
    const addedIds = GROUPS.flatMap(group => next[group].map(item => item.id));
    if (new Set(addedIds).size !== addedIds.length) fail("本轮约束 id 重复");
    const normalizedText = (text: string) => text.trim().replace(/\s+/gu, " ");
    for (const group of GROUPS) next[group] = next[group].filter(clause => {
        if (!oldIds.has(clause.id) || supersedes.includes(clause.id)) return true;
        const original = previous?.[group].find(item => item.id === clause.id);
        if (!original || normalizedText(original.text) !== normalizedText(clause.text)) fail("覆盖已有约束必须显式 supersedes");
        // Identical target repetitions do not write new provenance: inherit the saved clause/source.
        // Only real additions/replacements below undergo current-turn source validation.
        return false;
    });
    const sourceTexts = [input.userPrompt, ...(!previous && input.continuing ? input.legacySources || [] : []), ...(previous ? GROUPS.flatMap(group => previous[group].filter(item => supersedes.includes(item.id)).map(item => item.source)) : [])];
    const supersededClauses = previous ? GROUPS.flatMap(group => previous[group].filter(item => supersedes.includes(item.id))) : [];
    for (const group of GROUPS) for (const clause of next[group]) {
        if (!sourceTexts.some(source => source.includes(clause.source))) fail(`约束 ${clause.id} 的 source 不是已提供的用户要求原文`);
        const text = bindReferences(clause.text, input.references);
        if (!isEnglishImagePrompt(text) || /```|<\/?(?:think|analysis|reasoning)\b/iu.test(text)) fail(`约束 ${clause.id} 必须是英文指令（图中文字字面量除外）`);
        const target = `${group === "preserve" ? "Keep unchanged: " : group === "forbid" ? "Do not: " : ""}${text}`;
        // A quoted historical requirement being explicitly superseded is not a new preservation command.
        // Stop at a clause delimiter so a separate current prohibition can never be removed with it.
        const currentSource = group === "changes" && supersededClauses.length ? clause.source.replace(/(?:取代|替换|覆盖|撤销|取消)(?:上一轮|之前|此前|原先|原有)([^，,。；;\n]*)/gu, (mention, quotedTarget: string) => {
            const target = quotedTarget.trim().replace(/^(?:保留|保持|禁止|不要|不得|不许)\s*/u, "").replace(/(?:的)?(?:要求|约束|条件)$/u, "").trim();
            // Exact textual grounding in an explicitly superseded clause, never semantic/fuzzy matching.
            return target.length >= 2 && supersededClauses.some(item => item.source.includes(target) || item.text.includes(target)) ? "" : mention;
        }) : clause.source;
        if (currentSource !== clause.source) assertImagePromptInvariantCoverage(clause.source, target, { negation: false });
        assertImagePromptInvariantCoverage(currentSource, target);
    }
    // Check the planner's draft too; never permit a stale Image 3 to disappear unnoticed.
    bindReferences(input.draftPrompt, input.references);
    const merged = Object.fromEntries(GROUPS.map(group => [group, [...(previous?.[group] || []).filter(item => !supersedes.includes(item.id)), ...next[group]]])) as CanvasEditContract;
    if (!GROUPS.some(group => merged[group].length) || GROUPS.some(group => merged[group].length > 24) || GROUPS.reduce((n, group) => n + merged[group].length, 0) > 48) fail("完整目标为空或过长");
    const roles = array(raw.referenceRoles, "referenceRoles").map(value => { const role = object(value); return { id: string(role.id, "reference id", 200), role: string(role.role, "reference role", 30) }; });
    if (new Set(roles.map(item => item.id)).size !== roles.length || roles.length !== input.references.length || roles.some(item => !input.references.some(ref => ref.id === item.id) || !["base", "shape", "material", "pattern", "color", "composition", "reference"].includes(item.role))) fail("referenceRoles 必须逐一对应本次实际传图 id");
    const lines = input.references.map((ref, index) => `Image ${index + 1}: ${roles.find(item => item.id === ref.id)!.role} reference.`);
    const labels = { changes: "Required changes", preserve: "Keep unchanged", forbid: "Prohibitions" };
    for (const group of GROUPS) if (merged[group].length) lines.push(`${labels[group]}:\n${merged[group].map(item => {
        const text = bindReferences(item.text, input.references);
        return `- ${group === "forbid" && !/\b(?:not|don't|never|no|avoid|without|forbidden|prohibited)\b/iu.test(instructionsWithoutArtworkLiterals(text)) ? "Do not " : ""}${text}`;
    }).join("\n")}`);
    const prompt = lines.join("\n\n");
    // Whole-turn lexical counts/literals catch omitted clauses. Negation is checked per clause:
    // a user can negate an old target via supersedes without requiring a negative new target.
    const supersededText = supersededClauses.map(item => item.text).join("\n");
    assertImagePromptInvariantCoverage(input.userPrompt, prompt, { negation: false, supersededText });
    const completePrompt = [input.prefix, prompt].filter(Boolean).join("\n\n");
    const referenceImages = input.references.map(ref => ({ id: ref.id, name: ref.title, type: "image/png", dataUrl: ref.dataUrl || "" }));
    if (buildImageReferencePromptText(completePrompt, referenceImages, "en").length > 20_000) fail("完整编辑指令超过 20000 字符，请精简当前目标；不会截断约束");
    return { contract: merged, prompt };
}
