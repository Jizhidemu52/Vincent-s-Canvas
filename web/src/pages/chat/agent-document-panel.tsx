import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { useState } from "react";
import type { AgentDocument, AgentDocumentFigure, DesignRequirementCard } from "../../../../shared/image-agent-documents";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { parseDesignRequirements } from "@/lib/agent-documents";
import { confirmedDesignRequirements } from "@/lib/image-agent/document-tools";
import { DisplayText, DisplayTranslationPreview, DisplayTranslationScope, useDisplayText } from "@/hooks/use-display-text";

/** Shared by the two conversation surfaces; edits remain drafts until explicit confirmation. */
type AgentDocumentPanelProps = {
    documents?: AgentDocument[]; card?: DesignRequirementCard; disabled?: boolean;
    onChange: (card: DesignRequirementCard) => void;
    onReference: (figure: AgentDocumentFigure) => void;
    onPlace?: () => void;
};
export function AgentDocumentPanel(props: AgentDocumentPanelProps) {
    const { documents = [], card } = props;
    const [expanded, setExpanded] = useState(Boolean(card?.status === "draft"));
    if (!documents.length && !card) return null;
    return <details className="mx-3 mb-2 rounded-lg border border-current/15 p-2 text-xs" open={Boolean(card?.status === "draft")} onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }} data-testid="agent-document-panel">
        <summary className="cursor-pointer font-medium">{staticUiText("设计资料 · ")}{documents.length}{staticUiText(" 个文件")}{card ? staticUiText(" · 需求卡{p0}", { p0: `${card.status === "confirmed" ? staticUiText("已确认") : staticUiText("待确认")}` }) : staticUiText(" · 等待整理需求卡")}</summary>
        <DisplayTranslationScope visible={expanded}><AgentDocumentBody {...props} /></DisplayTranslationScope>
    </details>;
}

function AgentDocumentBody({ documents = [], card, disabled, onChange, onReference, onPlace }: AgentDocumentPanelProps) {
    const locale = useUiLocale();
    const display = useDisplayText();
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState("");
    if (!documents.length && !card) return null;
    const update = (patch: Partial<DesignRequirementCard>) => card && onChange({ ...card, ...patch, status: "draft", updatedAt: new Date().toISOString() });
    return <div className="mt-2 max-h-72 space-y-3 overflow-y-auto">
            {documents.map(document => <DocumentPreview key={document.id} document={document} disabled={disabled} onReference={onReference} />)}
            {card ? <section aria-label={staticUiText("设计需求卡")} className="space-y-2 border-t border-current/15 pt-2">
                <p className="font-medium"><DisplayText text={card.title || staticUiText("设计需求卡")} /></p>
                {([['subject', '款式/主体'], ['colors', '颜色'], ['materials', '材质/工艺'], ['must', '必须'], ['avoid', '禁止'], ['unknowns', '待确认']] as const).map(([key, label]) => {
                    const value = Array.isArray(card[key]) ? (card[key] as string[]).join("\n") : card[key] as string;
                    return <label key={key} className="block"><span className="opacity-70">{staticUiText(label)}{locale === "en-US" ? ": " : "："}</span>{editing
                        ? <><textarea aria-label={staticUiText("需求卡{p0}", { p0: staticUiText(label) })} disabled={disabled} value={value} className="mt-1 block min-h-12 w-full rounded border border-current/20 bg-transparent p-2" onChange={event => update({ [key]: Array.isArray(card[key]) ? event.target.value.split("\n").filter(Boolean) : event.target.value })} /><DisplayTranslationPreview text={value} /></>
                        : <span className="whitespace-pre-wrap"><DisplayText text={value || staticUiText("未注明")} /></span>}</label>;
                })}
                <p className="opacity-65">{staticUiText("来源：")}{card.sources.map(source => `${display(documents.find(document => document.id === source.documentId)?.name || source.documentId)} / ${display(documents.find(document => document.id === source.documentId)?.sections.find(section => section.id === source.sectionId)?.title || source.sectionId)}`).join(locale === "en-US" ? "; " : "；") || staticUiText("未标明章节")}</p>
                <p className="opacity-65">{staticUiText("确认后每轮使用；只确认需求，不会自动出图。待确认项不作为确定要求。")}</p>
                {error ? <p role="alert"><DisplayText text={error} /></p> : null}
                <div className="flex flex-wrap gap-3">
                    <button type="button" disabled={disabled} className="min-h-8 underline disabled:opacity-40" onClick={() => setEditing(value => !value)}>{editing ? staticUiText("收起编辑") : staticUiText("编辑需求")}</button>
                    {card.status !== "confirmed" ? <button type="button" disabled={disabled} className="min-h-8 font-medium underline disabled:opacity-40" onClick={() => {
                        try { parseDesignRequirements(confirmedDesignRequirements({ ...card, status: "confirmed" }), documents); onChange({ ...card, status: "confirmed", updatedAt: new Date().toISOString() }); setEditing(false); setError(""); }
                        catch (reason) { setError(reason instanceof Error ? reason.message : "请检查需求卡内容"); }
                    }}>{staticUiText("确认需求卡")}</button> : <span className="py-2">{staticUiText("已确认")}</span>}
                    {onPlace && card.status === "confirmed" ? <button type="button" disabled={disabled} className="min-h-8 underline disabled:opacity-40" onClick={onPlace}>{staticUiText("放到画布作文本节点")}</button> : null}
                </div>
            </section> : null}
        </div>;
}

function DocumentPreview({ document, disabled, onReference }: { document: AgentDocument; disabled?: boolean; onReference: (figure: AgentDocumentFigure) => void }) {
    const [expanded, setExpanded] = useState(false);
    return <details onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
        <summary className="cursor-pointer"><DisplayText text={document.name} /> · {document.sections.length}{staticUiText(" 页/节 · ")}{document.figures.length}{staticUiText(" 张图")}</summary>
        <DisplayTranslationScope visible={expanded}><DocumentFigures document={document} disabled={disabled} onReference={onReference} /></DisplayTranslationScope>
    </details>;
}

function DocumentFigures({ document, disabled, onReference }: { document: AgentDocument; disabled?: boolean; onReference: (figure: AgentDocumentFigure) => void }) {
    const display = useDisplayText();
    return <>
        {document.warnings.map((warning, index) => <p key={index} className="mt-1 opacity-75"><DisplayText text={warning} /></p>)}
        <div className="mt-2 flex gap-2 overflow-x-auto">{document.figures.map(figure => <div key={figure.id} className="w-24 shrink-0">
            <CanvasPersistedMediaPreview kind="image" url={figure.dataUrl} storageKey={figure.storageKey} alt={display(figure.label)} className="h-20 w-24 rounded object-contain" />
            <p className="truncate"><DisplayText text={figure.label} /></p><button type="button" disabled={disabled} className="min-h-8 underline disabled:opacity-40" onClick={() => onReference(figure)}>{staticUiText("选作参考图")}</button>
        </div>)}</div>
    </>;
}
