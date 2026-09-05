import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useState } from "react";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import type { ReferenceImage } from "@/types/image";

type Props = {
    references: ReferenceImage[];
    disabled?: boolean;
    onMove: (id: string, targetId: string) => void;
    onRemove: (id: string) => void;
    onClear: () => void;
};

export function CanvasQuickReferenceTray({ references, disabled, onMove, onRemove, onClear }: Props) {
    const [activeId, setActiveId] = useState<string | null>(null);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const activeIndex = references.findIndex((reference) => reference.id === activeId);
    const move = (to: number) => {
        if (activeIndex >= 0 && references[to]) onMove(references[activeIndex]!.id, references[to]!.id);
    };
    if (!references.length) return null;
    return <section className="cw-reference-tray" aria-label="已选参考图">
        <div className="cw-reference-heading"><span>参考图 · {references.length}</span><button type="button" disabled={disabled} onClick={onClear}>清空</button></div>
        <div className="cw-references">
            {references.map((reference, index) => <div key={reference.id} className={`cw-reference ${activeId === reference.id ? "is-active" : ""} ${draggingId === reference.id ? "is-dragging" : ""}`}
                onDragOver={(event) => { if (!disabled && draggingId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                onDrop={(event) => { event.preventDefault(); if (!disabled && draggingId) onMove(draggingId, reference.id); setDraggingId(null); }}>
                <button type="button" className="cw-reference-image" disabled={disabled} draggable={!disabled}
                    aria-label={`参考图 ${index + 1}：${reference.name}，点击调整顺序`} aria-pressed={activeId === reference.id}
                    onClick={() => setActiveId(reference.id)}
                    onKeyDown={(event) => {
                        if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                            event.preventDefault(); const target = references[index + (event.key === "ArrowLeft" ? -1 : 1)];
                            if (target) onMove(reference.id, target.id);
                        }
                    }}
                    onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", reference.id); setDraggingId(reference.id); setActiveId(reference.id); }}
                    onDragEnd={() => setDraggingId(null)}>
                    <CanvasPersistedMediaPreview kind="image" url={reference.dataUrl} storageKey={reference.storageKey} alt={reference.name} className="cw-reference-preview" />
                    <span className="cw-reference-number">{index + 1}</span>
                </button>
                <button type="button" className="cw-reference-remove" aria-label={`移除参考图 ${index + 1}`} disabled={disabled} onClick={() => onRemove(reference.id)}><X size={12} /></button>
            </div>)}
        </div>
        <div className="cw-reference-order">
            {activeIndex >= 0 ? <><span>图 {activeIndex + 1}</span><button type="button" aria-label="参考图前移" disabled={disabled || activeIndex === 0} onClick={() => move(activeIndex - 1)}><ArrowLeft size={14} />前移</button><button type="button" aria-label="参考图后移" disabled={disabled || activeIndex === references.length - 1} onClick={() => move(activeIndex + 1)}><ArrowRight size={14} />后移</button></> : <span>点击缩略图或拖动调整顺序</span>}
        </div>
    </section>;
}
