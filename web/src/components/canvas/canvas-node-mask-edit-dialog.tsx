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

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
    model: string;
    imageSettings?: Pick<AiConfig, "quality" | "imageOptions">;
};

type DrawMode = "paint" | "erase";

const defaultBrushSize = 100;
const maskFillColor = "rgba(37, 99, 235, .38)";
const maskBorderColor = "rgba(255, 255, 255, .72)";

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
    const [imageSettings, setImageSettings] = useState<Partial<AiConfig>>({});
    const effectiveConfig = useToolConfig({ ...config, ...imageSettings, count: "1", model }, "canvas-mask-edit");
    const profile = useImageModelProfile(effectiveConfig.model);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const toolEnabled = useToolEnabled("canvas-mask-edit");
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; last: { x: number; y: number } | null }>({ active: false, last: null });
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [error, setError] = useState("");
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
        let active = true;
        void readCanvasMaskImageSize(dataUrl).then(size => { if (active) setImage(size); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "原图读取失败"); });
        return () => { active = false; };
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    }, [image]);

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const maskCanvas = maskCanvasRef.current;
        const context = maskCanvas?.getContext("2d");
        if (!maskCanvas || !context) return;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = brushSize;
        context.globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out";
        context.strokeStyle = "#000";
        context.fillStyle = "#000";
        if (!drawingRef.current.last) {
            drawMaskStroke(context, point, point, brushSize);
        } else {
            drawMaskStroke(context, drawingRef.current.last, point, brushSize);
        }
        renderMaskPreview(maskCanvas, previewCanvasRef.current);
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
        if (maskCanvasRef.current) renderMaskPreview(maskCanvasRef.current, previewCanvasRef.current);
        draw(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active) return;
        event.preventDefault();
        draw(event);
    };

    const stopDraw = () => {
        drawingRef.current = { active: false, last: null };
        const maskCanvas = maskCanvasRef.current;
        if (maskCanvas) renderMaskPreview(maskCanvas, previewCanvasRef.current, canvasHasPaint(maskCanvas));
    };

    const resetMask = () => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        setError("");
    };

    const submit = () => {
        if (!toolEnabled || !profile.supportsMask) return;
        const nextPrompt = prompt.trim();
        const canvas = maskCanvasRef.current;
        if (!nextPrompt) return setError("请输入修改要求");
        if (!canvas) return;
        if (!canvasHasPaint(canvas)) return setError("请先涂抹局部区域");
        if (!effectiveConfig.model) return setError("请选择用于局部编辑的模型");
        if (!image || !lockedSettings) return setError(settingsError || "尚未确认原图像素尺寸，请稍后重试");
        onConfirm({ prompt: nextPrompt, maskDataUrl: buildEditMask(canvas), model: effectiveConfig.model, imageSettings: { quality: lockedSettings.quality, imageOptions: lockedSettings.imageOptions } });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_320px]">
                <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 dark:border-white/10">
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[68vh] max-w-full bg-transparent" draggable={false} />
                        {image ? (
                            <>
                                <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                <canvas
                                    ref={previewCanvasRef}
                                    width={image.width}
                                    height={image.height}
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
                        <h2 className="text-xl font-semibold">局部遮罩编辑</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `输出尺寸锁定为原图 ${image.width} × ${image.height}px` : "读取真实像素尺寸中"}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={mode === "paint" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                            画笔
                        </Button>
                        <Button type={mode === "erase" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                            擦除
                        </Button>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">笔刷大小</span>
                            <span className="font-semibold">{brushSize}px</span>
                        </div>
                        <Slider min={8} max={160} step={2} value={brushSize} onChange={setBrushSize} />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3 text-sm">
                            <span className="font-medium opacity-75">编辑模型</span>
                            {deploymentFeatures.creditsEnabled && typeof estimatedCredits === "number" ? <span className="shrink-0 text-xs font-medium text-orange-600">预计 {estimatedCredits} 积分</span> : null}
                        </div>
                        <ModelPicker toolKey="canvas-mask-edit" config={effectiveConfig} value={effectiveConfig.model} onChange={onModelChange} capability="image" fullWidth placeholder="选择局部编辑模型" />
                        {!profile.supportsMask ? <p role="alert" className="text-xs text-destructive">当前模型不支持蒙版，请切换支持蒙版的出图模型。</p> : null}
                    </div>

                    <div className="space-y-3">
                        <p className="text-xs leading-5" style={{ color: theme.node.muted }}>蒙版坐标与原图像素一一对应，不调整比例、尺寸或分辨率，也不会自动拉伸原图或蒙版。</p>
                        {profile.kind === "standard" || profile.kind === "quality-resolution" ? <label className="flex flex-col gap-1 text-xs">
                            <span>图片质量</span>
                            <select aria-label="图片质量" className="rounded border px-2 py-1.5" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} value={lockedSettings?.quality || effectiveConfig.quality} onChange={event => setImageSettings(current => ({ ...current, quality: event.target.value }))}>
                                {profile.qualities.map(value => <option key={value} value={value}>{imageQualityLabel(value)}</option>)}
                            </select>
                        </label> : null}
                        {outputFields.map(field => <label key={field.key} className="flex flex-col gap-1 text-xs">
                            <span>{field.label}</span>
                            {field.options ? <select aria-label={field.label} value={outputOptions[field.key] || ""} className="rounded border px-2 py-1.5" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => setOutputOption(field.key, event.target.value)}>
                                <option value="">渠道默认</option>
                                {field.options.map(value => <option key={value} value={value}>{value}</option>)}
                            </select> : <input aria-label={field.label} type="number" min={field.min} max={field.max} step={field.step} value={outputOptions[field.key] || ""} placeholder="渠道默认" disabled={field.key === "output_compression" && !["jpeg", "webp"].includes(outputOptions.output_format || "png")} className="rounded border px-2 py-1.5 disabled:opacity-40" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => setOutputOption(field.key, event.target.value)} />}
                            {field.tip ? <span className="leading-5" style={{ color: theme.node.muted }}>{field.tip}</span> : null}
                        </label>)}
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">修改要求</div>
                        <Input.TextArea
                            rows={6}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder="例如：把选中区域改成金属材质，保持原图光影"
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error || settingsError ? <div role="alert" className="text-xs font-medium text-destructive">{error || settingsError}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetMask}>
                            重置
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" disabled={!toolEnabled || !effectiveConfig.model || !profile.supportsMask || !lockedSettings} icon={<WandSparkles className="size-4" />} onClick={submit}>
                                AI 修改
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true;
    }
    return false;
}

function renderMaskPreview(maskCanvas: HTMLCanvasElement, previewCanvas: HTMLCanvasElement | null, withBorder = false) {
    const context = previewCanvas?.getContext("2d");
    if (!previewCanvas || !context) return;
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.fillStyle = maskFillColor;
    context.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(maskCanvas, 0, 0);
    context.globalCompositeOperation = "source-over";
    if (withBorder) drawDashedMaskBorder(context, maskCanvas);
}

function drawDashedMaskBorder(context: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement) {
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) return;
    const { width, height } = maskCanvas;
    const data = maskContext.getImageData(0, 0, width, height).data;
    const step = Math.max(1, Math.round(Math.max(width, height) / 1200));
    const dash = step * 8;
    const gap = step * 5;
    const period = dash + gap;

    context.save();
    context.fillStyle = maskBorderColor;
    context.shadowColor = "rgba(0, 0, 0, .24)";
    context.shadowBlur = step * 1.5;
    for (let y = step; y < height - step; y += step) {
        for (let x = step; x < width - step; x += step) {
            const offset = (y * width + x) * 4 + 3;
            if (data[offset] === 0 || !isMaskEdge(data, width, x, y, step)) continue;
            if ((x + y) % period > dash) continue;
            context.fillRect(x - step / 2, y - step / 2, Math.max(1.5, step), Math.max(1.5, step));
        }
    }
    context.restore();
}

function isMaskEdge(data: Uint8ClampedArray, width: number, x: number, y: number, step: number) {
    return data[((y - step) * width + x) * 4 + 3] === 0 || data[((y + step) * width + x) * 4 + 3] === 0 || data[(y * width + x - step) * 4 + 3] === 0 || data[(y * width + x + step) * 4 + 3] === 0;
}

function buildEditMask(selectionCanvas: HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = selectionCanvas.width;
    canvas.height = selectionCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) return selectionCanvas.toDataURL("image/png");
    const selectionContext = selectionCanvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!selectionContext) return canvas.toDataURL("image/png");
    const selection = selectionContext.getImageData(0, 0, canvas.width, canvas.height);
    const mask = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < mask.data.length; index += 4) {
        if (selection.data[index] > 0) mask.data[index] = 0;
    }
    context.putImageData(mask, 0, 0);
    return canvas.toDataURL("image/png");
}
