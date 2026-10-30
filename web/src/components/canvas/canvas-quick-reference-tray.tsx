import { useUiText } from "@/lib/i18n";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useState } from "react";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import type { ReferenceImage } from "@/types/image";
import { INTERNAL_IMAGE_DRAG } from "@/lib/dropped-images";

type Props = {
    references: ReferenceImage[];
    disabled?: boolean;
    thumbnailSize?: number;
    labelForReference?: (reference: ReferenceImage, index: number) => string;
    referenceOrder?: readonly string[];
    onMove: (id: string, targetId: string) => void;
    onRemove: (id: string) => void;
    onClear: () => void;
};

export function CanvasQuickReferenceTray({ references, disabled, thumbnailSize, labelForReference, referenceOrder, onMove, onRemove, onClear }: Props) {
    const t = useUiText();
    const [activeId, setActiveId] = useState<string | null>(null);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const activeIndex = references.findIndex((reference) => reference.id === activeId);
    const numberFor = (reference: ReferenceImage, index: number) => referenceOrder?.includes(reference.id) ? referenceOrder.indexOf(reference.id) + 1 : index + 1;
    const move = (to: number) => {
        if (activeIndex >= 0 && references[to]) onMove(references[activeIndex]!.id, references[to]!.id);
    };
    if (!references.length) return null;
    return <section className="cw-reference-tray" aria-label={t("已选参考图")}>
        <div className="cw-reference-heading"><span>{t("参考图 ·")}{references.length}</span><button type="button" disabled={disabled} onClick={onClear}>{t("清空")}</button></div>
        <div className="cw-references">
            {references.map((reference, index) => <div key={reference.id} className={`cw-reference ${activeId === reference.id ? "is-active" : ""} ${draggingId === reference.id ? "is-dragging" : ""}`} style={thumbnailSize ? { width: thumbnailSize, height: thumbnailSize } : undefined}
                onDragOver={(event) => { if (!disabled && draggingId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                onDrop={(event) => { event.preventDefault(); if (!disabled && draggingId) onMove(draggingId, reference.id); setDraggingId(null); }}>
                <button type="button" className="cw-reference-image" disabled={disabled} draggable={!disabled}
                    aria-label={t("参考图 {value1}：{value2}，点击调整顺序", { value1: numberFor(reference, index), value2: reference.name })} aria-pressed={activeId === reference.id}
                    onClick={() => setActiveId(reference.id)}
                    onKeyDown={(event) => {
                        if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                            event.preventDefault(); const target = references[index + (event.key === "ArrowLeft" ? -1 : 1)];
                            if (target) onMove(reference.id, target.id);
                        }
                    }}
                    onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(INTERNAL_IMAGE_DRAG, reference.id); event.dataTransfer.setData("text/plain", reference.id); setDraggingId(reference.id); setActiveId(reference.id); }}
                    onDragEnd={() => setDraggingId(null)}>
                    <CanvasPersistedMediaPreview kind="image" url={reference.dataUrl} storageKey={reference.storageKey} alt={reference.name} className="cw-reference-preview" />
                    <span className="cw-reference-number">{labelForReference?.(reference, index) || numberFor(reference, index)}</span>
                </button>
                <button type="button" className="cw-reference-remove" aria-label={t("移除参考图 {value1}", { value1: numberFor(reference, index) })} disabled={disabled} onClick={() => onRemove(reference.id)}><X size={12} /></button>
            </div>)}
        </div>
        <div className="cw-reference-order">
            {activeIndex >= 0 ? <><span>{labelForReference?.(references[activeIndex]!, activeIndex) || `${t("图")}${numberFor(references[activeIndex]!, activeIndex)}`}</span><button type="button" aria-label={t("参考图前移")} disabled={disabled || activeIndex === 0} onClick={() => move(activeIndex - 1)}><ArrowLeft size={14} />{t("前移")}</button><button type="button" aria-label={t("参考图后移")} disabled={disabled || activeIndex === references.length - 1} onClick={() => move(activeIndex + 1)}><ArrowRight size={14} />{t("后移")}</button></> : <span>{t("点击缩略图或拖动调整顺序")}</span>}
        </div>
    </section>;
}
