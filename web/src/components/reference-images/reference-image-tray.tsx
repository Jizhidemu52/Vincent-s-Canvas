import { Button, Tag, Tooltip } from "antd";
import { ChevronLeft, ChevronRight, ClipboardPaste, FolderPlus, GripVertical, Trash2, Upload, X } from "lucide-react";
import { useState } from "react";

import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { moveImageReference, type ImageReferenceValidation } from "@/lib/image-reference-policy";
import type { ImageReferenceItem } from "@/types/image";

type Props = {
    references: ImageReferenceItem[];
    validation: ImageReferenceValidation;
    onChange: (references: ImageReferenceItem[]) => void;
    onRequestUpload: () => void;
    onRequestAssets?: () => void;
    onRequestCanvas?: () => void;
    onRequestClipboard?: () => void;
};

export function ReferenceImageTray({ references, validation, onChange, onRequestUpload, onRequestAssets, onRequestCanvas, onRequestClipboard }: Props) {
    const [draggingKey, setDraggingKey] = useState<string | null>(null);
    const move = (from: number, to: number) => onChange(moveImageReference(references, from, to));
    const remove = (referenceKey: string) => onChange(references.filter((reference) => reference.referenceKey !== referenceKey));
    const drop = (targetKey: string) => {
        const from = references.findIndex((reference) => reference.referenceKey === draggingKey);
        const to = references.findIndex((reference) => reference.referenceKey === targetKey);
        if (from >= 0 && to >= 0) move(from, to);
        setDraggingKey(null);
    };

    return (
        <section className="min-w-0" aria-label="参考图">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-base font-semibold">参考图</span>
                    <Tag color={validation.valid ? "default" : "error"} className="m-0">{references.length} 张</Tag>
                </div>
                <div className="flex flex-wrap gap-2">
                    {onRequestCanvas ? <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onRequestCanvas}>从画布选择</Button> : null}
                    {onRequestAssets ? <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onRequestAssets}>从素材库选择</Button> : null}
                    {onRequestClipboard ? <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onRequestClipboard}>剪切板</Button> : null}
                    <Button size="small" icon={<Upload className="size-3.5" />} onClick={onRequestUpload}>上传图片</Button>
                    {references.length ? <Button size="small" danger icon={<X className="size-3.5" />} onClick={() => onChange([])}>清空</Button> : null}
                </div>
            </div>
            <div className="hover-scrollbar hover-scrollbar-hint flex min-h-28 w-full min-w-0 gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700">
                {references.map((item, index) => (
                    <div
                        key={item.referenceKey}
                        draggable
                        onDragStart={() => setDraggingKey(item.referenceKey)}
                        onDragEnd={() => setDraggingKey(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => drop(item.referenceKey)}
                        className={`group relative size-24 shrink-0 overflow-hidden rounded-md border bg-stone-50 transition dark:bg-stone-900 ${draggingKey === item.referenceKey ? "border-blue-400 opacity-50" : "border-stone-200 dark:border-stone-800"}`}
                    >
                        <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                        <span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                        <Tag className="absolute bottom-1 left-1 m-0 max-w-[70px] truncate border-0 bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{item.originLabel}</Tag>
                        <span className="absolute right-1 bottom-1 rounded bg-black/65 p-1 text-white" aria-hidden="true"><GripVertical className="size-3" /></span>
                        <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex group-focus-within:flex">
                            <Tooltip title="前移"><Button size="small" type="text" className="!size-6 !min-w-0 !bg-black/65 !p-0 !text-white" icon={<ChevronLeft className="size-3.5" />} disabled={index === 0} aria-label={`将${imageReferenceLabel(index)}前移`} onClick={() => move(index, index - 1)} /></Tooltip>
                            <Tooltip title="后移"><Button size="small" type="text" className="!size-6 !min-w-0 !bg-black/65 !p-0 !text-white" icon={<ChevronRight className="size-3.5" />} disabled={index === references.length - 1} aria-label={`将${imageReferenceLabel(index)}后移`} onClick={() => move(index, index + 1)} /></Tooltip>
                            <Tooltip title="移除"><Button size="small" type="text" danger className="!size-6 !min-w-0 !bg-black/65 !p-0 !text-red-200" icon={<Trash2 className="size-3.5" />} aria-label="移除参考图" onClick={() => remove(item.referenceKey)} /></Tooltip>
                        </div>
                    </div>
                ))}
                {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">上传图片、从素材库选择，或在画布中选择图片节点。</div> : null}
            </div>
            {!validation.valid && validation.message ? <p className="mt-2 text-xs text-red-500">{validation.message}</p> : null}
        </section>
    );
}
