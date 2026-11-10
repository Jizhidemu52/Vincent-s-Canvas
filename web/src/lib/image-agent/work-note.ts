import { ImageAgentPlanningError } from "../../../../shared/image-agent-iteration";
import { imagePromptInvariantNumbers } from "../../../../shared/image-prompt-invariants";

export type ImageAgentWorkNote = { summary: string; keep: string[]; revokedKeep?: string[] };
export const IMAGE_AGENT_NOTE_LIMIT = 800;

const unique = (items: readonly string[]) => [...new Set(items.map(item => item.trim()).filter(Boolean))];

/** Explicit UI-authored revocations stay in the ordinary user turn and its branch. */
export function imageAgentKeepRevocations(text: string): string[] {
    return [...text.matchAll(/取消保留项：[ \t]*("(?:[^"\\\n]|\\.)*")/gu)].flatMap(match => {
        try { const value: unknown = JSON.parse(match[1]!); return typeof value === "string" && value.trim() ? [value.trim()] : []; }
        catch { return []; }
    });
}

export function imageAgentKeepRevocationDraft(draft: string, keep: string): string {
    if (imageAgentKeepRevocations(draft).includes(keep)) return draft;
    return [draft.trim(), `取消保留项：${JSON.stringify(keep)}`].filter(Boolean).join("\n");
}

export function imageAgentVisualPrompt(text: string): string {
    return text.replace(/取消保留项：[ \t]*("(?:[^"\\\n]|\\.)*")[。；;]?/gu, "").trim();
}

/** Counts inferred from pixels are suggestions, never silently promoted to a saved lock. */
export function resolveImageAgentWorkNote(previous: ImageAgentWorkNote | undefined, update: string | undefined, keep: readonly string[] | undefined, userPrompt?: string): ImageAgentWorkNote {
    const requestedRevocations = imageAgentKeepRevocations(userPrompt || "");
    const revoked = unique([...(previous?.revokedKeep || []), ...requestedRevocations]);
    const current = imageAgentVisualPrompt(userPrompt || "");
    if (requestedRevocations.length && !current) throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "本轮只有待取消保留项，请同时填写下一次图片修改要求；尚未提交生成，取消项尚未生效。");
    // A later explicit user instruction can reinstate that exact requirement.
    const stillRevoked = revoked.filter(item => !new RegExp(`(?:^|[，,。；;\\n])(?:这次|本轮)?\\s*(?:恢复|重新保留|重新保持)\\s*${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(current));
    const effectiveKeep = unique(keep === undefined ? previous?.keep || [] : keep).filter(item => !stillRevoked.includes(item));
    if (userPrompt !== undefined) {
        const confirmed = imagePromptInvariantNumbers([current, ...(previous?.keep || []).filter(item => !stillRevoked.includes(item))].join("\n"));
        for (const item of effectiveKeep) if ([...imagePromptInvariantNumbers(item)].some(value => !confirmed.has(value))) {
            throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "保留项含未经用户确认的数量或尺寸；图像观察只能作为待确认建议，请写入 edit_spec.assumptions，不得锁定为事实。尚未提交生成。");
        }
    }
    const note = mergeImageAgentWorkNote(previous, update, effectiveKeep);
    const constraints = [note.keep.length ? `需保持：${note.keep.join("；")}` : "", stillRevoked.length ? `已撤销，不再继承：${stillRevoked.join("；")}` : ""].filter(Boolean).join("\n");
    if (constraints.length >= IMAGE_AGENT_NOTE_LIMIT) throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "当前保留与撤销记录过长，请从明确版本新建分支；不会截断有效约束或提交生成。");
    return { summary: note.summary.slice(0, Math.max(0, IMAGE_AGENT_NOTE_LIMIT - constraints.length - 1)), keep: note.keep, ...(stillRevoked.length ? { revokedKeep: stillRevoked } : {}) };
}

/** The note describes requested design state, not a claim of visual acceptance. */
export function mergeImageAgentWorkNote(previous?: ImageAgentWorkNote, update = "", keep?: readonly string[]): ImageAgentWorkNote {
    const preserved = unique(keep === undefined ? previous?.keep || [] : keep);
    // Keep explicit constraints before the prose summary. Do not silently discard
    // an old requirement to fit a newly returned note.
    if (preserved.join("；").length > 500) throw new Error("作品中需要保持的要求过长，请精简后再生成。");
    const limit = IMAGE_AGENT_NOTE_LIMIT - (preserved.length ? preserved.join("；").length + 6 : 0);
    // The planner sees the previous note and returns the merged CURRENT state in
    // this same call. Appending superseded colors/shapes would contradict it.
    const summary = (update.trim() || previous?.summary || "").slice(0, limit);
    return { summary, keep: preserved, ...(previous?.revokedKeep?.length ? { revokedKeep: [...previous.revokedKeep] } : {}) };
}

export function imageAgentWorkNoteText(note?: ImageAgentWorkNote): string {
    if (!note) return "";
    return [note.summary, note.keep.length ? `需保持：${note.keep.join("；")}` : "", note.revokedKeep?.length ? `已撤销，不再继承：${note.revokedKeep.join("；")}` : ""].filter(Boolean).join("\n").slice(0, IMAGE_AGENT_NOTE_LIMIT);
}
