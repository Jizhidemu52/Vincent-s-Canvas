import { useState } from "react";
import type { AgentDocument, AgentDocumentFigure, DesignRequirementCard } from "../../../../shared/image-agent-documents";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { parseDesignRequirements } from "@/lib/agent-documents";
import { confirmedDesignRequirements } from "@/lib/image-agent/document-tools";

/** Shared by the two conversation surfaces; edits remain drafts until explicit confirmation. */
export function AgentDocumentPanel({ documents = [], card, disabled, onChange, onReference, onPlace }: {
    documents?: AgentDocument[]; card?: DesignRequirementCard; disabled?: boolean;
    onChange: (card: DesignRequirementCard) => void;
    onReference: (figure: AgentDocumentFigure) => void;
    onPlace?: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState("");
    if (!documents.length && !card) return null;
    const update = (patch: Partial<DesignRequirementCard>) => card && onChange({ ...card, ...patch, status: "draft", updatedAt: new Date().toISOString() });
    return <details className="mx-3 mb-2 rounded-lg border border-current/15 p-2 text-xs" open={Boolean(card?.status === "draft")} data-testid="agent-document-panel">
        <summary className="cursor-pointer font-medium">设计资料 · {documents.length} 个文件{card ? ` · 需求卡${card.status === "confirmed" ? "已确认" : "待确认"}` : " · 等待整理需求卡"}</summary>
        <div className="mt-2 max-h-72 space-y-3 overflow-y-auto">
            {documents.map(document => <details key={document.id}>
                <summary className="cursor-pointer">{document.name} · {document.sections.length} 页/节 · {document.figures.length} 张图</summary>
                {document.warnings.map((warning, index) => <p key={index} className="mt-1 opacity-75">{warning}</p>)}
                <div className="mt-2 flex gap-2 overflow-x-auto">{document.figures.map(figure => <div key={figure.id} className="w-24 shrink-0">
                    <CanvasPersistedMediaPreview kind="image" url={figure.dataUrl} storageKey={figure.storageKey} alt={figure.label} className="h-20 w-24 rounded object-contain" />
                    <p className="truncate">{figure.label}</p><button type="button" disabled={disabled} className="min-h-8 underline disabled:opacity-40" onClick={() => onReference(figure)}>选作参考图</button>
                </div>)}</div>
            </details>)}
            {card ? <section aria-label="设计需求卡" className="space-y-2 border-t border-current/15 pt-2">
                <p className="font-medium">{card.title || "设计需求卡"}</p>
                {([['subject', '款式/主体'], ['colors', '颜色'], ['materials', '材质/工艺'], ['must', '必须'], ['avoid', '禁止'], ['unknowns', '待确认']] as const).map(([key, label]) => {
                    const value = Array.isArray(card[key]) ? (card[key] as string[]).join("\n") : card[key] as string;
                    return <label key={key} className="block"><span className="opacity-70">{label}：</span>{editing
                        ? <textarea aria-label={`需求卡${label}`} disabled={disabled} value={value} className="mt-1 block min-h-12 w-full rounded border border-current/20 bg-transparent p-2" onChange={event => update({ [key]: Array.isArray(card[key]) ? event.target.value.split("\n").filter(Boolean) : event.target.value })} />
                        : <span className="whitespace-pre-wrap">{value || "未注明"}</span>}</label>;
                })}
                <p className="opacity-65">来源：{card.sources.map(source => `${documents.find(document => document.id === source.documentId)?.name || source.documentId} / ${documents.find(document => document.id === source.documentId)?.sections.find(section => section.id === source.sectionId)?.title || source.sectionId}`).join("；") || "未标明章节"}</p>
                <p className="opacity-65">确认后每轮使用；只确认需求，不会自动出图。待确认项不作为确定要求。</p>
                {error ? <p role="alert">{error}</p> : null}
                <div className="flex flex-wrap gap-3">
                    <button type="button" disabled={disabled} className="min-h-8 underline disabled:opacity-40" onClick={() => setEditing(value => !value)}>{editing ? "收起编辑" : "编辑需求"}</button>
                    {card.status !== "confirmed" ? <button type="button" disabled={disabled} className="min-h-8 font-medium underline disabled:opacity-40" onClick={() => {
                        try { parseDesignRequirements(confirmedDesignRequirements({ ...card, status: "confirmed" }), documents); onChange({ ...card, status: "confirmed", updatedAt: new Date().toISOString() }); setEditing(false); setError(""); }
                        catch (reason) { setError(reason instanceof Error ? reason.message : "请检查需求卡内容"); }
                    }}>确认需求卡</button> : <span className="py-2">已确认</span>}
                    {onPlace && card.status === "confirmed" ? <button type="button" disabled={disabled} className="min-h-8 underline disabled:opacity-40" onClick={onPlace}>放到画布作文本节点</button> : null}
                </div>
            </section> : null}
        </div>
    </details>;
}
