import { useUiText } from "@/lib/i18n";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal, Select } from "antd";
import { Check, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { fitCropRatio, moveCrop, resizeCrop, type CanvasCropHandle as ResizeHandle, type CanvasImageCropRect } from "@/lib/canvas/canvas-crop-geometry";
export type { CanvasImageCropRect } from "@/lib/canvas/canvas-crop-geometry";

type DragMode = "move" | "resize";

const handles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const defaultCrop = { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };
const ratioOptions = [
    { value: "free", label: "自由比例" }, { value: "original", label: "原图比例" },
    ...["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"].map(value => ({ value, label: value })),
];
const handleNames: Record<ResizeHandle, string> = { n: "上", e: "右", s: "下", w: "左", ne: "右上", nw: "左上", se: "右下", sw: "左下" };

export function CanvasNodeCropDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (crop: CanvasImageCropRect) => void }) {
    const t = useUiText();
    const boxRef = useRef<HTMLDivElement>(null);
    const dragCleanupRef = useRef<(() => void) | null>(null);
    const [crop, setCrop] = useState<CanvasImageCropRect>(defaultCrop);
    const [ratioKey, setRatioKey] = useState("free");
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [imageError, setImageError] = useState("");
    const cropSize = image ? { width: Math.max(1, Math.round(crop.width * image.width)), height: Math.max(1, Math.round(crop.height * image.height)) } : null;
    const normalizedRatio = (key: string) => {
        if (key === "free" || !image) return null;
        if (key === "original") return 1;
        const [width, height] = key.split(":").map(Number);
        return (width! / height!) / (image.width / image.height);
    };
    const changeRatio = (key: string) => {
        dragCleanupRef.current?.();
        setRatioKey(key);
        const ratio = normalizedRatio(key);
        if (ratio !== null) setCrop(current => fitCropRatio(current, ratio));
    };

    useEffect(() => {
        if (open) { setCrop(defaultCrop); setRatioKey("free"); }
        return () => { dragCleanupRef.current?.(); };
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        let active = true;
        setImage(null);
        setImageError("");
        void readImageMeta(dataUrl).then(
            (meta) => { if (active) setImage(meta); },
            (error) => { if (active) setImageError(error instanceof Error ? error.message : "图片读取失败"); },
        );
        return () => { active = false; };
    }, [dataUrl, open]);

    const startDrag = (mode: DragMode, event: ReactPointerEvent, handle?: ResizeHandle) => {
        const box = boxRef.current?.getBoundingClientRect();
        if (!image || !box?.width || !box.height) return;
        event.preventDefault();
        event.stopPropagation();
        dragCleanupRef.current?.();
        const start = { x: event.clientX, y: event.clientY, crop };
        const move = (event: PointerEvent) => {
            const dx = (event.clientX - start.x) / box.width;
            const dy = (event.clientY - start.y) / box.height;
            setCrop(mode === "move" ? moveCrop(start.crop, dx, dy) : resizeCrop(start.crop, dx, dy, handle || "se", normalizedRatio(ratioKey)));
        };
        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            document.removeEventListener("pointercancel", up);
            dragCleanupRef.current = null;
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
        dragCleanupRef.current = up;
    };

    return (
        <Modal title={t("裁剪图片")} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={780} centered destroyOnHidden>
            <div className="space-y-4">
                {imageError ? <div role="alert" className="text-sm">{imageError}</div> : null}
                <div className="flex justify-center">
                    <div ref={boxRef} className="relative inline-block max-w-full touch-none overflow-hidden rounded-lg bg-black select-none">
                        <img src={dataUrl} alt="" className="block max-h-[62vh] max-w-full opacity-90" draggable={false} />
                        <CropMask crop={crop} />
                        <div aria-label={t("裁剪选区")} className="absolute cursor-move border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.3),0_0_28px_rgba(0,0,0,.28)]" style={cropStyle(crop)} onPointerDown={(event) => startDrag("move", event)}>
                            <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/50" />
                            <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/50" />
                            <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/50" />
                            <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/50" />
                            {handles.map((handle) => (
                                <button key={handle} type="button" disabled={!image} className="absolute size-3 rounded-full border border-black bg-white" style={handleStyle(handle)} onPointerDown={(event) => startDrag("resize", event, handle)} aria-label={t("调整裁剪框{value1}", { value1: t(handleNames[handle]) })} onKeyDown={event => {
                                    const delta = event.shiftKey ? 0.05 : 0.01;
                                    const dx = event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0;
                                    const dy = event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0;
                                    if (dx || dy) { event.preventDefault(); event.stopPropagation(); setCrop(current => resizeCrop(current, dx, dy, handle, normalizedRatio(ratioKey))); }
                                }} />
                            ))}
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3 text-sm opacity-80">
                        <span>{t("裁剪尺寸")}{cropSize ? `${cropSize.width} x ${cropSize.height}` : t("未知")}</span>
                        <span>{t("比例")}{cropSize ? formatRatio(cropSize.width, cropSize.height) : t("未知")}</span>
                        {image ? (
                            <span>
                                {t("原图 ")}{image.width} x {image.height}
                            </span>
                        ) : null}
                    </div>
                    <Select aria-label={t("裁剪比例")} className="min-w-32" value={ratioKey} options={ratioOptions.map(option => ({ ...option, label: t(option.label) }))} disabled={!image} onChange={changeRatio} />
                </div>

                <div className="flex items-center justify-end gap-2">
                    <Button onClick={() => { dragCleanupRef.current?.(); setCrop(defaultCrop); setRatioKey("free"); }}>{t("重置")}</Button>
                    <Button icon={<X className="size-4" />} onClick={onClose}>
                        {t("取消")}</Button>
                    <Button type="primary" icon={<Check className="size-4" />} disabled={!image} onClick={() => onConfirm(crop)}>
                        {t("确认裁剪")}</Button>
                </div>
            </div>
        </Modal>
    );
}

function CropMask({ crop }: { crop: CanvasImageCropRect }) {
    const t = useUiText();
    return (
        <>
            <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: `${crop.y * 100}%` }} />
            <div className="absolute inset-x-0 bottom-0 bg-black/55" style={{ height: `${(1 - crop.y - crop.height) * 100}%` }} />
            <div className="absolute bg-black/55" style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` }} />
            <div className="absolute bg-black/55" style={{ right: 0, top: `${crop.y * 100}%`, width: `${(1 - crop.x - crop.width) * 100}%`, height: `${crop.height * 100}%` }} />
        </>
    );
}

function cropStyle(crop: CanvasImageCropRect) {
    return { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` };
}

function handleStyle(handle: ResizeHandle) {
    const top = handle.includes("n") ? "-6px" : handle.includes("s") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    const left = handle.includes("w") ? "-6px" : handle.includes("e") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    return { top, left, cursor: `${handle}-resize` };
}

function formatRatio(width: number, height: number) {
    const divisor = gcd(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function gcd(a: number, b: number): number {
    return b ? gcd(b, a % b) : Math.max(1, a);
}
