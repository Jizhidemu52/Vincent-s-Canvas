import { useUiText } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Segmented, Tooltip } from "antd";
import { ImagePlus } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { MAX_UPSCALE_LONG_EDGE, resolveUpscaleSize, type ImageUpscaleAlgorithm, type ImageUpscaleParams } from "@/lib/canvas/canvas-image-data";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasImageUpscaleParams = ImageUpscaleParams;

const algorithms: Array<{ value: ImageUpscaleAlgorithm; title: string; description: string }> = [
    { value: "high", title: "高清插值", description: "适合照片和细节图" },
    { value: "bilinear", title: "双线性", description: "平滑、速度快" },
    { value: "nearest", title: "最近邻", description: "适合像素风格" },
];

const targetOptions = [
    { label: "1K", value: 1024 },
    { label: "2K", value: 2048 },
    { label: "4K", value: MAX_UPSCALE_LONG_EDGE },
];

const defaultParams: CanvasImageUpscaleParams = {
    targetLongEdge: 2048,
    algorithm: "high",
};

export function CanvasNodeUpscaleDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (params: CanvasImageUpscaleParams) => void }) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [params, setParams] = useState<CanvasImageUpscaleParams>(defaultParams);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [imageError, setImageError] = useState("");
    const [previewOpen, setPreviewOpen] = useState(false);
    const [preview, setPreview] = useState("");
    const [previewBusy, setPreviewBusy] = useState(false);
    const sourceLongEdge = image ? Math.max(image.width, image.height) : 0;
    const outputSize = useMemo(() => (image ? resolveUpscaleSize(image.width, image.height, params.targetLongEdge) : null), [image, params.targetLongEdge]);
    const canUpscale = Boolean(image && sourceLongEdge < params.targetLongEdge && params.targetLongEdge <= MAX_UPSCALE_LONG_EDGE);
    const reachedMax = Boolean(image && sourceLongEdge >= MAX_UPSCALE_LONG_EDGE);
    const disabledReason = imageError || (!image ? t("读取中") : reachedMax ? t("图片已达到 4K，无需放大") : !canUpscale ? t("图片已达到当前目标像素，无需放大") : "");

    useEffect(() => {
        if (!open) return;
        setParams(defaultParams);
        setImage(null);
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        let active = true;
        setImageError("");
        void readImageMeta(dataUrl).then(
            (meta) => { if (active) setImage(meta); },
            (error) => { if (active) setImageError(error instanceof Error ? error.message : "图片读取失败"); },
        );
        return () => { active = false; };
    }, [dataUrl, open]);

    useEffect(() => {
        if (!image) return;
        const nextTarget = targetOptions.find((option) => sourceLongEdge < option.value)?.value || MAX_UPSCALE_LONG_EDGE;
        setParams((current) => ({ ...current, targetLongEdge: nextTarget }));
    }, [image, sourceLongEdge]);
    useEffect(() => {
        if (!open || !previewOpen || !canUpscale) return;
        const controller = new AbortController();
        let url = "";
        setPreviewBusy(true); setPreview("");
        const timer = setTimeout(() => {
            void import("@/lib/canvas/canvas-image-data").then(module => module.upscaleImageBlob(dataUrl, params, { signal: controller.signal })).then(blob => {
                if (controller.signal.aborted) return;
                url = URL.createObjectURL(blob); setPreview(url);
            }).catch(error => { if (!controller.signal.aborted) setImageError(error instanceof Error ? error.message : "预览失败"); }).finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
        }, 150);
        return () => { clearTimeout(timer); controller.abort(); if (url) URL.revokeObjectURL(url); };
    }, [dataUrl, open, previewOpen, canUpscale, params]);

    return (
        <Modal title={t("插值放大（非 AI）")} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={800} centered destroyOnHidden>
            <div className="space-y-5">
                {imageError ? <div role="alert" className="text-sm">{imageError}</div> : null}
                <div>
                    <p className="text-sm opacity-70">{t("仅用浏览器插值增加像素尺寸，不会生成真实新细节，不调用 AI。")}</p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(260px,1fr)_360px]">
                    <div className="rounded-xl border p-4">
                        <div className="grid min-h-[280px] place-items-center rounded-lg" style={{ background: theme.node.fill }}>
                            <img src={dataUrl} alt="" className="max-h-[320px] max-w-full rounded-lg object-contain" draggable={false} />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">{t("源图")}</span>
                            <span className="font-semibold">{image ? `${image.width} x ${image.height} px` : imageError ? t("读取失败") : t("读取中")}</span>
                        </div>
                        <Tooltip title={disabledReason || undefined}><Button className="mt-3" size="small" disabled={!canUpscale} onClick={() => setPreviewOpen(value => !value)}>{t(previewOpen ? "收起 100% 预览" : "查看 100% 局部预览")}</Button></Tooltip>
                        {previewOpen ? <div className="mt-2 h-52 overflow-auto rounded border" aria-label={t("100% 插值效果预览")}>
                            {previewBusy ? <p className="p-3 text-sm">{t("正在生成同算法预览…")}</p> : preview && outputSize ? <img src={preview} alt={t("放大结果 100% 局部")} draggable={false} className="max-w-none" style={{ width: outputSize.width, height: outputSize.height }} onLoad={event => { const box = event.currentTarget.parentElement; if (box) { box.scrollLeft = (outputSize.width - box.clientWidth) / 2; box.scrollTop = (outputSize.height - box.clientHeight) / 2; } }} /> : null}
                        </div> : null}
                    </div>
                    <div className="space-y-6 py-2">
                        <div className="space-y-2">
                            <div className="font-medium opacity-75">{t("目标像素")}</div>
                            <Segmented
                                block
                                value={params.targetLongEdge}
                                options={targetOptions.map((option) => ({ label: `${option.label} · ${option.value}px`, value: option.value, disabled: Boolean(image && sourceLongEdge >= option.value) }))}
                                onChange={(value) => setParams((current) => ({ ...current, targetLongEdge: Number(value) }))}
                            />
                            {image && !canUpscale ? <div className="text-[13px] font-medium" style={{ color: theme.node.danger }}>{disabledReason}</div> : null}
                        </div>
                        <div className="space-y-2">
                            <div className="font-medium opacity-75">{t("放大算法")}</div>
                            <Segmented
                                block
                                value={params.algorithm}
                                options={algorithms.map((item) => ({
                                    value: item.value,
                                    label: (
                                        <span className="flex min-h-12 flex-col justify-center text-left leading-5">
                                            <span className="font-medium">{t(item.title)}</span>
                                            <span className="text-xs opacity-55">{t(item.description)}</span>
                                        </span>
                                    ),
                                }))}
                                onChange={(value) => setParams((current) => ({ ...current, algorithm: value as ImageUpscaleAlgorithm }))}
                            />
                        </div>
                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("输出尺寸")}</span>
                                <span className="font-semibold">{outputSize ? `${outputSize.width} x ${outputSize.height} px` : t("未知")}</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Tooltip title={disabledReason || undefined}><Button type="primary" size="large" icon={<ImagePlus className="size-4" />} disabled={!canUpscale} onClick={() => onConfirm(params)}>
                        {t("生成放大图")}</Button></Tooltip>
                </div>
            </div>
        </Modal>
    );
}
