import { useRef, useState } from "react";
import { App } from "antd";
import { ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { createClientId } from "@/lib/client-id";
import { createImageReferenceItem, dedupeImageReferences, moveImageReference } from "@/lib/image-reference-policy";
import { toCanvasStoredImageReference } from "@/lib/canvas/canvas-image-references";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { uploadImage } from "@/services/image-storage";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { ImageReferenceItem } from "@/types/image";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";

export function configImageReferencePatch(node: CanvasNodeData, current: ImageReferenceItem[], next: ImageReferenceItem[]): Partial<CanvasNodeMetadata> {
    const connected = new Set([...(node.metadata?.excludedConnectedImageReferenceKeys || []), ...current.filter(item => item.origin === "connection").map(item => item.referenceKey)]);
    const kept = new Set(next.map(item => item.referenceKey));
    return {
        manualImageReferences: next.filter(item => item.origin !== "connection").map(toCanvasStoredImageReference),
        excludedConnectedImageReferenceKeys: [...connected].filter(key => !kept.has(key)),
        imageReferenceOrder: next.map(item => item.referenceKey),
    };
}

type Props = {
    node: CanvasNodeData;
    references: ImageReferenceItem[];
    disabled: boolean;
    labels?: Record<string, string>;
    onChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
};

/** Compact card tray: uploads are stored by the existing image service, never ephemeral file URLs. */
export function CanvasConfigImageReferences(props: Props) {
    const { node, references, disabled, labels, onChange } = props;
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const inputRef = useRef<HTMLInputElement>(null);
    const latest = useRef(props);
    latest.current = props;
    const uploadingRef = useRef(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const busy = disabled || uploading;
    const save = (next: ImageReferenceItem[]) => onChange(node.id, configImageReferencePatch(node, references, next));
    const addFiles = async (files: File[]) => {
        if (!files.length || disabled || uploadingRef.current) return;
        uploadingRef.current = true;
        setUploading(true);
        setError("");
        const added: ImageReferenceItem[] = [];
        try {
            for (const file of files) {
                if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
                assertCanvasImageUploadSize(file);
            }
            for (const file of files) {
                const stored = await uploadImage(file);
                added.push(createImageReferenceItem({ id: createClientId(), name: file.name, originalFileName: file.name, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }, "upload"));
            }
        } catch (reason) {
            const detail = reason instanceof Error ? reason.message : "图片上传失败，请重试";
            setError(detail);
            void message.error(detail);
        } finally {
            const current = latest.current;
            if (added.length && current.node.id === node.id) current.onChange(node.id, configImageReferencePatch(current.node, current.references, dedupeImageReferences([...current.references, ...added])));
            uploadingRef.current = false;
            setUploading(false);
        }
    };
    const controlStyle = { background: theme.toolbar.panel, color: theme.node.text, borderColor: theme.node.stroke };
    return <section aria-label="参考图" className="min-w-0 cursor-default" onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-xs disabled:opacity-50" style={{ color: theme.node.text }}>
            {uploading ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}{uploading ? "正在添加参考图" : "添加参考图"}
        </button>
        <input ref={inputRef} aria-label="上传参考图" className="hidden" type="file" accept="image/*" multiple disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; void addFiles(files); }} />
        {references.length ? <div className="thin-scrollbar mt-1 flex gap-2 overflow-x-auto pb-1">
            {references.map((item, index) => <div key={item.referenceKey} className="group relative h-[76px] w-20 shrink-0 overflow-hidden rounded-md border" style={{ borderColor: theme.node.stroke }}>
                <CanvasPersistedMediaPreview kind="image" url={item.dataUrl} storageKey={item.storageKey} alt={`${labels?.[item.referenceKey] || `参考图${index + 1}`}：${item.name}`} className="h-full w-full object-cover" />
                <span className="absolute left-0 top-0 rounded-br px-1 text-[10px]" style={controlStyle}>{labels?.[item.referenceKey] || index + 1}</span>
                <button type="button" disabled={busy} aria-label={`移除${labels?.[item.referenceKey] || `参考图${index + 1}`}`} className="absolute right-0 top-0 rounded-bl p-0.5" style={controlStyle} onClick={() => save(references.filter(reference => reference.referenceKey !== item.referenceKey))}><X className="size-3" /></button>
                {references.length > 1 ? <div className="absolute bottom-0 right-0 flex rounded-tl" style={controlStyle}>
                    <button type="button" disabled={busy || index === 0} aria-label={`${labels?.[item.referenceKey] || `参考图${index + 1}`}前移`} className="p-0.5 disabled:opacity-30" onClick={() => save(moveImageReference(references, index, index - 1))}><ChevronLeft className="size-3" /></button>
                    <button type="button" disabled={busy || index === references.length - 1} aria-label={`${labels?.[item.referenceKey] || `参考图${index + 1}`}后移`} className="p-0.5 disabled:opacity-30" onClick={() => save(moveImageReference(references, index, index + 1))}><ChevronRight className="size-3" /></button>
                </div> : null}
            </div>)}
        </div> : null}
        {error ? <div role="alert" className="mt-1 text-xs" style={{ color: theme.node.text }}>{error}</div> : null}
    </section>;
}
