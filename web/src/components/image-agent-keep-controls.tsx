import { imageAgentKeepRevocationDraft, imageAgentKeepRevocations } from "@/lib/image-agent/work-note";

/** Draft-only controls: cancelling a draft never changes this version's saved locks. */
export function ImageAgentKeepControls({ keep, draft, onChange, disabled }: { keep: readonly string[]; draft: string; onChange: (value: string) => void; disabled?: boolean }) {
    if (!keep.length) return null;
    const pending = new Set(imageAgentKeepRevocations(draft));
    return <details className="text-xs" data-testid="image-agent-keep-controls">
        <summary className="w-fit cursor-pointer">当前保留项（{keep.length}）{pending.size ? " · 有待发送取消" : ""}</summary>
        <ul className="mt-2 grid gap-1.5">
            {keep.map(item => <li key={item} className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words">{item}</span>
                <button type="button" disabled={disabled || pending.has(item)} className="shrink-0 underline disabled:opacity-60" onClick={() => onChange(imageAgentKeepRevocationDraft(draft, item))}>{pending.has(item) ? "待发送取消" : "下轮取消"}</button>
            </li>)}
        </ul>
        <p className="mt-2 opacity-75">取消要求会加入输入框，随下一次修改发送后生效；删除草稿则不生效。</p>
    </details>;
}
