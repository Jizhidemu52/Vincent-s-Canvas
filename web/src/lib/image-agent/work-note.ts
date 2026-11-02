export type ImageAgentWorkNote = { summary: string; keep: string[] };
export const IMAGE_AGENT_NOTE_LIMIT = 800;

const unique = (items: readonly string[]) => [...new Set(items.map(item => item.trim()).filter(Boolean))];

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
    return { summary, keep: preserved };
}

export function imageAgentWorkNoteText(note?: ImageAgentWorkNote): string {
    if (!note) return "";
    return [note.summary, note.keep.length ? `需保持：${note.keep.join("；")}` : ""].filter(Boolean).join("\n").slice(0, IMAGE_AGENT_NOTE_LIMIT);
}
