import { staticUiText } from "@/lib/static-ui-copy";
import { useUiText } from "@/lib/i18n";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Select, Slider } from "antd";
import { Brush, Eraser, RotateCcw, WandSparkles, X } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import type { AiConfig } from "@/stores/use-config-store";
import { useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { imageQualityLabel } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { imageModelSettingsError, normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import { imageOptionFields, readImageOptions } from "@/lib/image-advanced-settings";
import { buildCanvasEditMask, canvasMaskBrushPixels, canvasMaskPoint, canvasMaskPreviewSize, clearMaskCanvas, drawMaskStroke, renderMaskPreview } from "@/lib/canvas/canvas-mask-paint";
import { canvasMaskAdaptationPlan } from "@/lib/canvas/canvas-mask-adaptation";

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
    const viewportRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const spaceRef = useRef(false);
    const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const historyRef = useRef<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const historyIndexRef = useRef(-1);
    const editorEpochRef = useRef(0);
    const restoringRef = useRef(false);
    const [restoring, setRestoring] = useState(false);
    const previewSize = image ? canvasMaskPreviewSize(image) : null;
    let settingsError = "";
    let lockedSettings: ReturnType<typeof canvasMaskEditImageSettings> | undefined;
    let adaptation: ReturnType<typeof canvasMaskAdaptationPlan> | undefined;
    try { if (image) { adaptation = canvasMaskAdaptationPlan(image, profile); lockedSettings = canvasMaskEditImageSettings(effectiveConfig, adaptation, profile); } }
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
        setZoom(1); setPan({ x: 0, y: 0 });
        historyRef.current = []; historyIndexRef.current = -1; setHistoryIndex(-1);
        editorEpochRef.current++; restoringRef.current = false; setRestoring(false);
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

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!open || !viewport) return;
        const wheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); event.stopPropagation(); setZoom(current => Math.max(.25, Math.min(8, current * Math.exp(-event.deltaY * .002)))); };
        viewport.addEventListener("wheel", wheel, { passive: false });
        return () => viewport.removeEventListener("wheel", wheel);
    }, [open, image]);

    const saveStroke = () => {
        const canvas = maskCanvasRef.current;
        if (!canvas) return;
        const frames = historyRef.current.slice(0, historyIndexRef.current + 1);
        frames.push(canvas.toDataURL("image/png"));
        historyRef.current = frames.slice(-30);
        historyIndexRef.current = historyRef.current.length - 1; setHistoryIndex(historyIndexRef.current);
    };
    const restoreStroke = async (direction: number) => {
        const index = historyIndexRef.current + direction, canvas = maskCanvasRef.current;
        if (!canvas || restoringRef.current || index < 0 || index >= historyRef.current.length) return;
        const epoch = editorEpochRef.current;
        restoringRef.current = true;
        setRestoring(true);
        try {
            const frame = new Image(); frame.src = historyRef.current[index]!; await frame.decode();
            if (epoch !== editorEpochRef.current || canvas !== maskCanvasRef.current) return;
            clearMaskCanvas(canvas); canvas.getContext("2d")?.drawImage(frame, 0, 0); historyIndexRef.current = index; setHistoryIndex(index); refreshPreview(true);
        } catch { if (epoch === editorEpochRef.current) setError("笔画恢复失败，当前蒙版已保留，请重试。"); }
        finally { if (epoch === editorEpochRef.current) { restoringRef.current = false; setRestoring(false); } }
    };

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
        if (spaceRef.current) { panRef.current = { x: event.clientX, y: event.clientY, left: pan.x, top: pan.y }; return; }
        if (restoringRef.current) return;
        if (!historyRef.current.length) saveStroke();
        drawingRef.current = { active: true, last: null };
        draw(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setCursor({ x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom });
        if (panRef.current) { const start = panRef.current; setPan({ x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y }); return; }
        if (!drawingRef.current.active) return;
        event.preventDefault();
        draw(event);
    };

    const stopDraw = () => {
        if (drawingRef.current.active) saveStroke();
        panRef.current = null;
        drawingRef.current = { active: false, last: null };
        refreshPreview(true);
    };

    const resetMask = () => {
        if (restoringRef.current) return;
        if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
        clearMaskCanvas(maskCanvasRef.current);
        clearMaskCanvas(previewCanvasRef.current);
        saveStroke();
        paintedRef.current = false;
        setError("");
    };

    const requestClose = () => {
        if (paintedRef.current || prompt.trim()) setConfirmDiscard(true);
        else onClose();
    };

    const submit = () => {
        if (!toolEnabled || !profile.supportsMask || restoringRef.current || confirmDiscard) return;
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

    useEffect(() => {
        if (!open) return;
        const keydown = (event: KeyboardEvent) => {
            if (event.isComposing || confirmDiscard) return;
            const input = event.target instanceof HTMLElement && Boolean(event.target.closest("input,textarea,[contenteditable=true]"));
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); return; }
            if (input) return;
            if (event.code === "Space") { event.preventDefault(); spaceRef.current = true; }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); void restoreStroke(event.shiftKey ? 1 : -1); }
            if (event.key === "[") setBrushSize(value => Math.max(8, value - 4));
            if (event.key === "]") setBrushSize(value => Math.min(160, value + 4));
            if (event.key.toLowerCase() === "b") setMode("paint");
            if (event.key.toLowerCase() === "e") setMode("erase");
        };
        const keyup = (event: KeyboardEvent) => { if (event.code === "Space") spaceRef.current = false; };
        const blur = () => { spaceRef.current = false; stopDraw(); };
        window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
        return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur); };
    });

    return (
        <>
        <Modal title={t("局部遮罩编辑")} open={open && Boolean(dataUrl)} onCancel={requestClose} footer={null} width={980} centered destroyOnHidden styles={{ body: { maxHeight: "calc(100dvh - 128px)", overflowY: "auto" } }}>
            <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div ref={viewportRef} className="relative flex min-w-0 items-center justify-center overflow-hidden rounded-xl border bg-transparent p-0" style={{ borderColor: theme.node.stroke }}>
                    <div className="relative inline-block max-w-full rounded-lg bg-transparent select-none" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
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
                                    onPointerLeave={() => setCursor(null)}
                                />
                                {cursor ? <span aria-hidden className="pointer-events-none absolute rounded-full border" style={{ left: cursor.x, top: cursor.y, width: brushSize / zoom, height: brushSize / zoom, transform: "translate(-50%,-50%)", borderColor: theme.canvas.selectionStroke, boxShadow: `0 0 0 1px ${theme.node.fill}` }} /> : null}
                            </>
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[360px] flex-col gap-5">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="small" onClick={() => setZoom(value => Math.max(.25, value / 1.25))}>−</Button><span>{Math.round(zoom * 100)}%</span><Button size="small" onClick={() => setZoom(value => Math.min(8, value * 1.25))}>+</Button>
                        <Button size="small" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{staticUiText("适应窗口")}</Button>
                        <Button size="small" disabled={restoring || historyIndex < 1} onClick={() => void restoreStroke(-1)}>{staticUiText("撤销笔画")}</Button><Button size="small" disabled={restoring || historyIndex >= historyRef.current.length - 1} onClick={() => void restoreStroke(1)}>{staticUiText("重做")}</Button>
                        <span className="text-xs" style={{ color: theme.node.muted }}>{staticUiText("空格拖动 · Ctrl + 滚轮缩放 · [ ] 调笔刷 · B / E 切换")}</span>
                    </div>
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
                        </div>
                        <ModelPicker toolKey="canvas-mask-edit" config={effectiveConfig} value={effectiveConfig.model} onChange={onModelChange} capability="image" fullWidth placeholder={t("选择局部编辑模型")} />
                        {!profile.supportsMask ? <p role="alert" className="text-xs text-destructive">{t("当前模型不支持蒙版，请切换支持蒙版的出图模型。")}</p> : null}
                    </div>

                    <div className="space-y-3">
                        <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{adaptation && image && (adaptation.width !== image.width || adaptation.height !== image.height) ? staticUiText("自动适配至 {p0} × {p1}px：原图与蒙版等比缩放并补边，结果还原原尺寸，未涂抹区域保留原图像素。", { p0: `${adaptation.width}`, p1: `${adaptation.height}` }) : staticUiText("按原图像素编辑；未涂抹区域保留原图像素。")}</p>
                        {profile.kind === "standard" || profile.kind === "quality-resolution" ? <label className="flex flex-col gap-1 text-xs">
                            <span>{t("图片质量")}</span>
                            <Select aria-label={t("图片质量")} value={lockedSettings?.quality || effectiveConfig.quality} onChange={value => setImageSettings(current => ({ ...current, quality: value }))} options={profile.qualities.map(value => ({ value, label: imageQualityLabel(value) }))} />
                        </label> : null}
                        {outputFields.map(field => <label key={field.key} className="flex flex-col gap-1 text-xs">
                            <span>{field.label}</span>
                            {field.options ? <Select aria-label={field.label} value={outputOptions[field.key] || ""} onChange={value => setOutputOption(field.key, value)} options={[{ value: "", label: t("默认") }, ...field.options.map(value => ({ value, label: value }))]} /> : <input aria-label={field.label} type="number" min={field.min} max={field.max} step={field.step} value={outputOptions[field.key] || ""} placeholder={t("默认")} disabled={field.key === "output_compression" && !["jpeg", "webp"].includes(outputOptions.output_format || "png")} className="rounded border px-2 py-2 disabled:opacity-40" style={{ background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke }} onChange={event => setOutputOption(field.key, event.target.value)} />}
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
