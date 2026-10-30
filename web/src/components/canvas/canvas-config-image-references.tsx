import { useUiText, uiText } from "@/lib/i18n";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { App } from "antd";
import { ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useImageDrop } from "@/hooks/use-image-drop";
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
    const t = useUiText();
    const { node, references, disabled, labels, onChange } = props;
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { id: projectId } = useParams<{ id: string }>();
    const owner = useUserStore(state => `${state.status}:${state.user?.id || ""}`);
    const scope = useMemo(() => ({ active: false, owner }), [projectId, node.id, owner]);
    const inputRef = useRef<HTMLInputElement>(null);
    const latest = useRef({ props, scope });
    const uploadingRef = useRef(false);
    const operationRef = useRef<object | null>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    useLayoutEffect(() => { latest.current = { props, scope }; });
    useLayoutEffect(() => {
        scope.active = true;
        uploadingRef.current = false; operationRef.current = null;
        setUploading(false); setError("");
        return () => { scope.active = false; uploadingRef.current = false; operationRef.current = null; };
    }, [scope]);
    const save = (next: ImageReferenceItem[]) => onChange(node.id, configImageReferencePatch(node, references, next));
    const addFiles = async (files: File[]) => {
        const currentScope = () => {
            const account = useUserStore.getState();
            return scope.active && latest.current.scope === scope
                && `${account.status}:${account.user?.id || ""}` === scope.owner;
        };
        if (!files.length || disabled || latest.current.props.disabled || uploadingRef.current || !currentScope()) return;
        const operation = {};
        operationRef.current = operation;
        const current = () => operationRef.current === operation && currentScope() && !latest.current.props.disabled;
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
                if (!current()) return;
                const stored = await uploadImage(file);
                if (!current()) return;
                added.push(createImageReferenceItem({ id: createClientId(), name: file.name, originalFileName: file.name, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }, "upload"));
            }
        } catch (reason) {
            if (!current()) return;
            const detail = reason instanceof Error ? reason.message : "图片上传失败，请重试";
            setError(detail);
            void message.error(detail);
        } finally {
            if (current()) {
                const latestProps = latest.current.props;
                if (added.length) latestProps.onChange(node.id, configImageReferencePatch(latestProps.node, latestProps.references, dedupeImageReferences([...latestProps.references, ...added])));
            }
            if (operationRef.current === operation) {
                operationRef.current = null; uploadingRef.current = false;
                if (currentScope()) setUploading(false);
            }
        }
    };
    const imageDrop = useImageDrop({ onFiles: addFiles, disabled: disabled || uploading, scopeKey: `canvas-config-references:${projectId || ""}:${node.id}` });
    const adding = uploading || imageDrop.reading;
    const busy = disabled || adding;
    const controlStyle = { background: theme.toolbar.panel, color: theme.node.text, borderColor: theme.node.stroke };
    return <section {...imageDrop.dropProps} aria-label={t("参考图")} aria-busy={adding} className="min-w-0 cursor-default rounded-md" style={imageDrop.dragging ? { outline: `2px solid ${theme.canvas.selectionStroke}`, outlineOffset: 3 } : undefined} onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-xs disabled:opacity-50" style={{ color: theme.node.text }}>
            {adding ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}{adding ? t("正在添加参考图") : t("添加参考图")}
        </button>
        {imageDrop.dragging ? <p role="status" className="mb-1 text-xs" style={{ color: theme.node.text }}>{t("松开以添加参考图片，不会自动生成。")}</p> : null}
        <input ref={inputRef} aria-label={t("上传参考图")} className="hidden" type="file" accept="image/*" multiple disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; void addFiles(files); }} />
        {references.length ? <div className="thin-scrollbar mt-1 flex gap-2 overflow-x-auto pb-1">
            {references.map((item, index) => <div key={item.referenceKey} className="group relative h-[76px] w-20 shrink-0 overflow-hidden rounded-md border" style={{ borderColor: theme.node.stroke }}>
                <CanvasPersistedMediaPreview kind="image" url={item.dataUrl} storageKey={item.storageKey} alt={`${labels?.[item.referenceKey] || `参考图${index + 1}`}：${item.name}`} className="h-full w-full object-cover" />
                <span className="absolute left-0 top-0 rounded-br px-1 text-[10px]" style={controlStyle}>{labels?.[item.referenceKey] || index + 1}</span>
                <button type="button" disabled={busy} aria-label={t("移除{value1}", { value1: labels?.[item.referenceKey] || uiText("参考图{value1}", { value1: index + 1 }) })} className="absolute right-0 top-0 rounded-bl p-0.5" style={controlStyle} onClick={() => save(references.filter(reference => reference.referenceKey !== item.referenceKey))}><X className="size-3" /></button>
                {references.length > 1 ? <div className="absolute bottom-0 right-0 flex rounded-tl" style={controlStyle}>
                    <button type="button" disabled={busy || index === 0} aria-label={t("{value1}前移", { value1: labels?.[item.referenceKey] || uiText("参考图{value1}", { value1: index + 1 }) })} className="p-0.5 disabled:opacity-30" onClick={() => save(moveImageReference(references, index, index - 1))}><ChevronLeft className="size-3" /></button>
                    <button type="button" disabled={busy || index === references.length - 1} aria-label={t("{value1}后移", { value1: labels?.[item.referenceKey] || uiText("参考图{value1}", { value1: index + 1 }) })} className="p-0.5 disabled:opacity-30" onClick={() => save(moveImageReference(references, index, index + 1))}><ChevronRight className="size-3" /></button>
                </div> : null}
            </div>)}
        </div> : null}
        {error ? <div role="alert" className="mt-1 text-xs" style={{ color: theme.node.text }}>{error}</div> : null}
    </section>;
}
