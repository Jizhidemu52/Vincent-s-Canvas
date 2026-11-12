import { uiText, useUiLocale } from "@/lib/i18n";
import { Button, Select, Tag, Tooltip } from "antd";
import { ChevronLeft, ChevronRight, ClipboardPaste, FolderPlus, GripVertical, Trash2, Upload, X } from "lucide-react";
import { useState } from "react";

import { moveImageReference, type ImageReferenceValidation } from "@/lib/image-reference-policy";
import { INTERNAL_IMAGE_DRAG } from "@/lib/dropped-images";
import type { ImageReferenceItem } from "@/types/image";
import { imageReferenceRoleOptions } from "@/lib/image-reference-prompt";
import { WorkbenchImage } from "@/components/workbench-image";

type Props = {
    references: ImageReferenceItem[];
    loading?: boolean;
    fixedReferenceKey?: string;
    validation: ImageReferenceValidation;
    onChange: (references: ImageReferenceItem[]) => void;
    onRequestUpload: () => void;
    onRequestAssets?: () => void;
    onRequestCanvas?: () => void;
    onRequestClipboard?: () => void;
};

export function ReferenceImageTray({ references, loading, fixedReferenceKey, validation, onChange, onRequestUpload, onRequestAssets, onRequestCanvas, onRequestClipboard }: Props) {
    useUiLocale();
    const [draggingKey, setDraggingKey] = useState<string | null>(null);
    const move = (from: number, to: number) => {
        if (references[from]?.referenceKey === fixedReferenceKey || references[to]?.referenceKey === fixedReferenceKey) return;
        onChange(moveImageReference(references, from, to));
    };
    const remove = (referenceKey: string) => {
        if (referenceKey !== fixedReferenceKey) onChange(references.filter((reference) => reference.referenceKey !== referenceKey));
    };
    const drop = (targetKey: string) => {
        const from = references.findIndex((reference) => reference.referenceKey === draggingKey);
        const to = references.findIndex((reference) => reference.referenceKey === targetKey);
        if (from >= 0 && to >= 0) move(from, to);
        setDraggingKey(null);
    };

    return (
        <section className="min-w-0" aria-label={uiText("参考图")}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-base font-semibold">{uiText("参考图")}</span>
                    <Tag color={validation.valid ? "default" : "error"} className="m-0">{uiText("{count} 张", { count: references.length })}</Tag>
                </div>
                <div className="flex flex-wrap gap-2">
                    {onRequestCanvas ? <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onRequestCanvas}>{uiText("从画布选择")}</Button> : null}
                    {onRequestAssets ? <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onRequestAssets}>{uiText("从素材库选择")}</Button> : null}
                    {onRequestClipboard ? <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onRequestClipboard}>{uiText("剪切板")}</Button> : null}
                    <Button size="small" loading={loading} icon={<Upload className="size-3.5" />} onClick={onRequestUpload}>{uiText("上传图片")}</Button>
                    {references.some(reference => reference.referenceKey !== fixedReferenceKey) ? <Button size="small" danger icon={<X className="size-3.5" />} onClick={() => onChange(references.filter(reference => reference.referenceKey === fixedReferenceKey))}>{fixedReferenceKey ? uiText("清空附加图") : uiText("清空")}</Button> : null}
                </div>
            </div>
            <div className="hover-scrollbar hover-scrollbar-hint flex min-h-28 w-full min-w-0 gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-border p-2 pb-3 overscroll-x-contain">
                {references.map((item, index) => (
                    <div
                        key={item.referenceKey}
                        draggable={item.referenceKey !== fixedReferenceKey}
                        onDragStart={(event) => { if (item.referenceKey !== fixedReferenceKey) { event.dataTransfer.setData(INTERNAL_IMAGE_DRAG, item.referenceKey); setDraggingKey(item.referenceKey); } }}
                        onDragEnd={() => setDraggingKey(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => drop(item.referenceKey)}
                        className={`group w-36 shrink-0 rounded-md border border-border bg-muted/30 p-1 transition ${draggingKey === item.referenceKey ? "opacity-50" : ""}`}
                    >
                        <div className="relative h-24 overflow-hidden rounded-md bg-muted">
                        <WorkbenchImage src={item.dataUrl} alt={item.name} loading="lazy" decoding="async" className="size-full object-contain" />
                        <span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-xs font-medium text-white">{uiText("图片{count}", { count: index + 1 })}</span>
                        <Tag className="absolute bottom-1 left-1 m-0 max-w-[70px] truncate border-0 bg-black/65 px-1.5 py-0.5 text-xs text-white">{item.originLabel}</Tag>
                        {item.referenceKey !== fixedReferenceKey ? <><span className="absolute right-1 bottom-1 rounded bg-black/65 p-1 text-white" aria-hidden="true"><GripVertical className="size-3" /></span>
                        <div className="absolute right-1 top-1 flex gap-1 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                            <Tooltip title={uiText("前移")}><Button size="small" type="text" className="!size-6 !min-w-0 !bg-black/65 !p-0 !text-white" icon={<ChevronLeft className="size-3.5" />} disabled={index === 0 || references[index - 1]?.referenceKey === fixedReferenceKey} aria-label={uiText("将图片{count}前移", { count: index + 1 })} onClick={() => move(index, index - 1)} /></Tooltip>
                            <Tooltip title={uiText("后移")}><Button size="small" type="text" className="!size-6 !min-w-0 !bg-black/65 !p-0 !text-white" icon={<ChevronRight className="size-3.5" />} disabled={index === references.length - 1} aria-label={uiText("将图片{count}后移", { count: index + 1 })} onClick={() => move(index, index + 1)} /></Tooltip>
                            <Tooltip title={uiText("移除")}><Button size="small" type="text" danger className="!size-6 !min-w-0 !bg-black/65 !p-0 !text-red-200" icon={<Trash2 className="size-3.5" />} aria-label={uiText("移除参考图")} onClick={() => remove(item.referenceKey)} /></Tooltip>
                        </div></> : null}
                        </div>
                        <Select size="small" className="mt-1 w-full" aria-label={uiText("图片{count}用途", { count: index + 1 })} placeholder={uiText("选择图片用途")}
                            value={item.role || undefined} allowClear
                            options={[...new Set([...imageReferenceRoleOptions, ...(item.role ? [item.role] : [])])].map(role => ({ value: role, label: uiText(role) }))}
                            onChange={role => onChange(references.map(reference => reference.referenceKey === item.referenceKey ? { ...reference, role: role || "" } : reference))}
                            onClick={event => event.stopPropagation()} />
                    </div>
                ))}
                {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-muted-foreground">{onRequestCanvas ? uiText("上传图片、从素材库选择，或在画布中选择图片节点。") : uiText("上传、粘贴或拖入图片，也可从素材库选择。")}</div> : null}
            </div>
            {!validation.valid && validation.message ? <p role="alert" className="mt-2 text-[13px] text-destructive">{validation.message}</p> : null}
            {loading ? <p role="status" className="mt-2 text-xs text-muted-foreground">{uiText("正在读取参考图，请稍候…")}</p> : null}
        </section>
    );
}
