import { useUiText } from "@/lib/i18n";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Slider } from "antd";
import { Brush, Eraser, RotateCcw, WandSparkles, X } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import type { AiConfig } from "@/stores/use-config-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { imageQualityLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { imageModelSettingsError, normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import { imageOptionFields, readImageOptions } from "@/lib/image-advanced-settings";
import { buildCanvasEditMask, canvasMaskBrushPixels, canvasMaskPoint, canvasMaskPreviewSize, clearMaskCanvas, drawMaskStroke, renderMaskPreview } from "@/lib/canvas/canvas-mask-paint";

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
    model: string;
    imageSettings?: Pick<AiConfig, "quality" | "imageOptions">;
};

type DrawMode = "paint" | "erase";

const defaultBrushSize = 40;

/** A strict mask must use decoded source pixels, never the shared reader's fallback dimensions. */
export async function readCanvasMaskImageSize(dataUrl: string) {
    const image = new Image();
    image.src = dataUrl;
    try { await image.decode(); }
    catch { throw new Error("无法读取原图或蒙版的真实像素尺寸；尚未提交生成，请重新打开图片后重试。"); }
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw new Error("原图或蒙版的真实像素尺寸无效；尚未提交生成。");
    return { width, height };
}
/** Lock the mask coordinate system before either UI confirmation or the actual task submission. */
export function canvasMaskEditImageSettings(config: Pick<AiConfig, "size" | "quality" | "imageOptions">, image: { width: number; height: number }, profile: ReturnType<typeof useImageModelProfile>) {
    const { width, height } = image;
    const size = `${width}x${height}`;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw new Error("无法确认原图像素尺寸；尚未提交生成。");
    if (!profile.verified || !profile.supportsMask || (!profile.customSize && !profile.sizes.includes(size)))
        throw new Error(`当前模型不能按原图 ${width} × ${height}px 进行严格蒙版编辑，请选择支持该像素尺寸的模型；尚未提交生成。`);
    const sizeError = imageModelSettingsError(size, profile);
    if (sizeError) throw new Error(`原图 ${width} × ${height}px 不符合当前模型的尺寸要求：${sizeError} 尚未提交，不会自动缩放原图或蒙版。`);
    const options = readImageOptions(config.imageOptions);
    const safeKeys = new Set(["background", "output_format", "output_compression", "moderation"]);
    const safeOptions = Object.fromEntries(imageOptionFields(profile).filter(field => safeKeys.has(field.key) && options[field.key] !== undefined).map(field => [field.key, options[field.key]]));
    // Mark's documented contract ignores resolution when size is exact pixels. Do not inherit its global selector.
    const quality = normalizeImageModelSettings({ size, quality: config.quality, count: "1" }, profile).quality;
    return { size, quality, imageOptions: JSON.stringify(safeOptions) };
}

export function CanvasNodeMaskEditDialog({
    dataUrl,
    open,
    config,
    model,
    estimatedCredits,
    onModelChange,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    config: AiConfig;
    model: string;
    estimatedCredits?: number;
    onModelChange: (model: string) => void;
    onClose: () => void;
    onConfirm: (payload: CanvasImageMaskEditPayload) => void;
}) {
    const t = useUiText();
    const [imageSettings, setImageSettings] = useState<Partial<AiConfig>>({});
    const effectiveConfig = useToolConfig({ ...config, ...imageSettings, count: "1", model }, "canvas-mask-edit");
    const profile = useImageModelProfile(effectiveConfig.model);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const toolEnabled = useToolEnabled("canvas-mask-edit");
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewFrameRef = useRef<number | null>(null);
    const paintedRef = useRef(false);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [error, setError] = useState("");
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const previewSize = image ? canvasMaskPreviewSize(image) : null;
    let settingsError = "";
    let lockedSettings: ReturnType<typeof canvasMaskEditImageSettings> | undefined;
    try { if (image) lockedSettings = canvasMaskEditImageSettings(effectiveConfig, image, profile); }
    catch (reason) { settingsError = reason instanceof Error ? reason.message : "原图尺寸不可用于当前模型的严格蒙版编辑"; }
    const outputOptions = readImageOptions(lockedSettings?.imageOptions);
    const outputFields = imageOptionFields(profile).filter(field => ["background", "output_format", "output_compression", "moderation"].includes(field.key));
    const setOutputOption = (key: string, value: string) => {
        const next = { ...outputOptions, [key]: value };
        if (!value) delete next[key];
        if (key === "background" && value === "transparent" && next.output_format === "jpeg") next.output_format = "png";
        if (key === "output_format" && value === "jpeg" && next.background === "transparent") next.background = "opaque";
        setImageSettings(current => ({ ...current, imageOptions: JSON.stringify(next) }));
    };

    useEffect(() => {
        if (!open) return;
        setPrompt("");
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setError("");
        setImageSettings({});
        setImage(null);
        setConfirmDiscard(false);
        paintedRef.current = false;
        let active = true;
        void readCanvasMaskImageSize(dataUrl).then(size => { if (active) setImage(size); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "原图读取失败"); });
        return () => { active = false; };
    }, [dataUrl, open]);

    useEffect(() => {
        clearMaskCanvas(maskCanvasRef.current);
        clearMaskCanvas(previewCanvasRef.current);
        drawingRef.current = { active: false, last: null };
        return () => {
            if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
            previewFrameRef.current = null;
        };
    }, [image, open]);

    const refreshPreview = (withBorder = false) => {
        if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = requestAnimationFrame(() => {
            previewFrameRef.current = null;
            if (maskCanvasRef.current) renderMaskPreview(maskCanvasRef.current, previewCanvasRef.current, withBorder);
        });
    };

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const maskCanvas = maskCanvasRef.current;
        const context = maskCanvas?.getContext("2d");
        if (!maskCanvas || !context) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const point = canvasMaskPoint(maskCanvas, rect, event.clientX, event.clientY);
        const sourceBrushSize = canvasMaskBrushPixels(brushSize, maskCanvas, rect);
        context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out";
        drawMaskStroke(context, drawingRef.current.last || point, point, sourceBrushSize);
        paintedRef.current = true;
        refreshPreview();
        drawingRef.current.last = point;
        if (mode === "paint") {
            setError("");
        }
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null };
        draw(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active) return;
        event.preventDefault();
        draw(event);
    };

    const stopDraw = () => {
        drawingRef.current = { active: false, last: null };
        refreshPreview(true);
    };

    const resetMask = () => {
        if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
        clearMaskCanvas(maskCanvasRef.current);
        clearMaskCanvas(previewCanvasRef.current);
        paintedRef.current = false;
        setError("");
    };

    const requestClose = () => {
        if (paintedRef.current || prompt.trim()) setConfirmDiscard(true);
        else onClose();
    };

    const submit = () => {
        if (!toolEnabled || !profile.supportsMask) return;
        const nextPrompt = prompt.trim();
        const canvas = maskCanvasRef.current;
        if (!nextPrompt) return setError("请输入修改要求");
        if (!canvas) return;
        if (!effectiveConfig.model) return setError("请选择用于局部编辑的模型");
        if (!image || !lockedSettings) return setError(settingsError || "尚未确认原图像素尺寸，请稍后重试");
        let maskDataUrl: string;
        try { maskDataUrl = buildCanvasEditMask(canvas); }
        catch (reason) { return setError(reason instanceof Error ? reason.message : "蒙版读取失败"); }
        onConfirm({ prompt: nextPrompt, maskDataUrl, model: effectiveConfig.model, imageSettings: { quality: lockedSettings.quality, imageOptions: lockedSettings.imageOptions } });
    };

    return (
        <>
        <Modal title={t("局部遮罩编辑")} open={open && Boolean(dataUrl)} onCancel={requestClose} footer={null} width={980} centered destroyOnHidden styles={{ body: { maxHeight: "calc(100dvh - 128px)", overflowY: "auto" } }}>
            <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="flex min-w-0 items-center justify-center overflow-hidden rounded-xl border bg-transparent p-0" style={{ borderColor: theme.node.stroke }}>
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[68vh] max-w-full bg-transparent" draggable={false} />
                        {image && previewSize ? (
                            <>
                                <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                <canvas
                                    ref={previewCanvasRef}
                                    width={previewSize.width}
                                    height={previewSize.height}
                                    aria-label={t("蒙版绘制区")}
                                    className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                    onPointerDown={startDraw}
                                    onPointerMove={moveDraw}
                                    onPointerUp={stopDraw}
                                    onPointerCancel={stopDraw}
                                />
                            </>
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[360px] flex-col gap-5">
                    <div>
                        <div className="mt-2 text-sm opacity-60">{image ? t("输出尺寸锁定为原图 {value1} × {value2}px", { value1: image.width, value2: image.height }) : t("读取真实像素尺寸中")}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={mode === "paint" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                            {t("画笔")}</Button>
                        <Button type={mode === "erase" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                            {t("擦除")}</Button>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">{t("笔刷直径")}</span>
                            <span className="font-semibold">{brushSize} {t(" 显示像素")}</span>
                        </div>
                        <Slider min={8} max={160} step={2} value={brushSize} onChange={setBrushSize} />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="font-medium opacity-75">{t("编辑模型")}</span>
                            {deploymentFeatures.creditsEnabled && typeof estimatedCredits === "number" ? <span className="shrink-0 text-xs font-medium text-orange-600">{t("预计")}{estimatedCredits} {t(" 积分")}</span> : null}
                        </div>
                        <ModelPicker toolKey="canvas-mask-edit" config={effectiveConfig} value={effectiveConfig.model} onChange={onModelChange} capability="image" fullWidth placeholder={t("选择局部编辑模型")} />
                        {!profile.supportsMask ? <p role="alert" className="text-xs text-destructive">{t("当前模型不支持蒙版，请切换支持蒙版的出图模型。")}</p> : null}
                    </div>

                    <div className="space-y-3">
                        <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("蒙版坐标与原图像素一一对应，不调整比例、尺寸或分辨率，也不会自动拉伸原图或蒙版。")}</p>
                        {profile.kind === "standard" || profile.kind === "quality-resolution" ? <label className="flex flex-col gap-1 text-xs">
                            <span>{t("图片质量")}</span>
                            <select aria-label={t("图片质量")} className="rounded border px-2 py-1.5" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} value={lockedSettings?.quality || effectiveConfig.quality} onChange={event => setImageSettings(current => ({ ...current, quality: event.target.value }))}>
                                {profile.qualities.map(value => <option key={value} value={value}>{imageQualityLabel(value)}</option>)}
                            </select>
                        </label> : null}
                        {outputFields.map(field => <label key={field.key} className="flex flex-col gap-1 text-xs">
                            <span>{field.label}</span>
                            {field.options ? <select aria-label={field.label} value={outputOptions[field.key] || ""} className="rounded border px-2 py-1.5" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => setOutputOption(field.key, event.target.value)}>
                                <option value="">{t("渠道默认")}</option>
                                {field.options.map(value => <option key={value} value={value}>{value}</option>)}
                            </select> : <input aria-label={field.label} type="number" min={field.min} max={field.max} step={field.step} value={outputOptions[field.key] || ""} placeholder={t("渠道默认")} disabled={field.key === "output_compression" && !["jpeg", "webp"].includes(outputOptions.output_format || "png")} className="rounded border px-2 py-1.5 disabled:opacity-40" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => setOutputOption(field.key, event.target.value)} />}
                            {field.tip ? <span className="leading-5" style={{ color: theme.node.muted }}>{field.tip}</span> : null}
                        </label>)}
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">{t("修改要求")}</div>
                        <Input.TextArea
                            rows={6}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder={t("例如：把选中区域改成金属材质，保持原图光影")}
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error || settingsError ? <div role="alert" className="text-xs font-medium text-destructive">{error || settingsError}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetMask}>
                            {t("重置")}</Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={requestClose}>
                                {t("取消")}</Button>
                            <Button type="primary" disabled={!toolEnabled || !effectiveConfig.model || !profile.supportsMask || !lockedSettings} icon={<WandSparkles className="size-4" />} onClick={submit}>
                                {t("AI 修改")}</Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
        <Modal title={t("放弃本次蒙版编辑？")} open={open && confirmDiscard} onCancel={() => setConfirmDiscard(false)} onOk={() => { setConfirmDiscard(false); onClose(); }} okText={t("放弃编辑")} cancelText={t("继续编辑")} mask={{ closable: false }} centered>
            {t("涂抹区域和修改要求尚未提交，关闭后将丢失。")}</Modal>
        </>
    );
}
