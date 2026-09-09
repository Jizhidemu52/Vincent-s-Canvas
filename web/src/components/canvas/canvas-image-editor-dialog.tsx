import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Alert, App, Button, Input, InputNumber, Modal, Select, Slider, Spin, Tooltip } from "antd";
import { ArrowUpRight, Brush, Check, Crop, Grid2x2, Redo2, RotateCw, Scan, Square, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAsyncAction } from "@/hooks/use-async-action";
import { resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { EDITOR_MAX_DIMENSION, editorDocumentSize, editorPngBlob, editorPoint, editorRect, editorSizeError, paintEditorMark, renderEditorDocument, type EditorPoint, type EditorRect, type EditorResizeMode, type ImageEditorMark, type ImageEditorOperation } from "@/lib/canvas/image-editor-document";
import type { CanvasNodeData } from "@/types/canvas";
import { editorRectangles, editorRectangleMove } from "@/lib/canvas/image-editor-document";

type Tool = "select" | "brush" | "rectangle" | "arrow" | "text" | "mosaic";
type Gesture = { pointerId: number; tool: Tool; start: EditorPoint; end: EditorPoint; points: EditorPoint[]; movingIndex?: number };
const tools = [
    { id: "select", label: "框选", icon: Scan }, { id: "brush", label: "画笔", icon: Brush },
    { id: "rectangle", label: "矩形", icon: Square }, { id: "arrow", label: "箭头", icon: ArrowUpRight },
    { id: "text", label: "文字", icon: Type }, { id: "mosaic", label: "马赛克", icon: Grid2x2 },
] as const;
const hints: Record<Tool, string> = {
    select: "拖动框选区域，再点“应用裁剪”；切换画笔后仅在选区内涂画。",
    brush: "按住并拖动涂画；每一笔都可以撤销。", rectangle: "拖动已有矩形的框内或边框即可移动；空白处画新框，按住 Shift 可在旧框内新建。", arrow: "从起点拖到终点画箭头。",
    text: "先输入文字，再点击图片放置；可以撤销后重新放置。", mosaic: "拖动框选要打码的区域。马赛克用于视觉遮挡，敏感信息请用不透明涂画完全覆盖。",
};

export function CanvasImageEditorDialog({ node, onClose, onConfirm, saveHint = "保存回当前节点 · 原图可通过画布撤销恢复 · 不调用 AI", successMessage = "编辑结果已保存到画布，可继续进行 AI 编辑", cancelDescription = "画布上的图片不会改变，面板内未保存的修改将丢弃。" }: { node: CanvasNodeData; onClose: () => void; onConfirm: (image: UploadedImage) => Promise<void>; saveHint?: string; successMessage?: string; cancelDescription?: string }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { message, modal } = App.useApp();
    const { pending: saving, run } = useAsyncAction(`canvas-image-edit:${node.id}`);
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [loadError, setLoadError] = useState("");
    const [reload, setReload] = useState(0);
    const [tool, setTool] = useState<Tool>("select");
    const [color, setColor] = useState("#ef4444");
    const [lineWidth, setLineWidth] = useState(12);
    const [fontSize, setFontSize] = useState(36);
    const [text, setText] = useState("");
    const [resizeDraft, setResizeDraft] = useState<{ width: number | null; height: number | null } | null>(null);
    const [resizeMode, setResizeMode] = useState<EditorResizeMode>("contain");
    const [history, setHistory] = useState<{ operations: ImageEditorOperation[]; cursor: number }>({ operations: [], cursor: 0 });
    const [selection, setSelection] = useState<EditorRect | null>(null);
    const [selectedRectangle, setSelectedRectangle] = useState<number | null>(null);
    const [movingPreview, setMovingPreview] = useState<ImageEditorOperation | null>(null);
    const [overRectangle, setOverRectangle] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [stageSize, setStageSize] = useState({ width: 900, height: 480 });
    const stageRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const gestureRef = useRef<Gesture | null>(null);
    const previewFrameRef = useRef<number | null>(null);
    const uploadedRef = useRef<UploadedImage | null>(null);
    const committedOperations = useMemo(() => history.operations.slice(0, history.cursor), [history]);
    const operations = useMemo(() => movingPreview ? [...committedOperations, movingPreview] : committedOperations, [committedOperations, movingPreview]);
    const rectangles = useMemo(() => editorRectangles(operations, { width: image?.naturalWidth || 1, height: image?.naturalHeight || 1 }), [operations, image]);
    const selectedBounds = tool === "rectangle" ? rectangles.find(rect => rect.index === selectedRectangle) : undefined;
    const size = useMemo(() => editorDocumentSize({ width: image?.naturalWidth || 1, height: image?.naturalHeight || 1 }, operations), [image, operations]);
    const resizeWidth = resizeDraft ? resizeDraft.width : size.width;
    const resizeHeight = resizeDraft ? resizeDraft.height : size.height;
    const resizeError = editorSizeError({ width: resizeWidth ?? 0, height: resizeHeight ?? 0 });
    const canResize = Boolean(image) && !saving && !resizeError && (resizeWidth !== size.width || resizeHeight !== size.height);
    const scale = Math.max(.01, Math.min((stageSize.width - 32) / size.width, (stageSize.height - 32) / size.height, 1)) * zoom;
    const dirty = history.cursor > 0;

    useEffect(() => {
        let active = true;
        const source = new Image();
        source.crossOrigin = "anonymous";
        setLoadError("");
        void resolveImageUrl(node.metadata?.storageKey, node.metadata?.content || "").then(url => {
            if (!active) return;
            if (!url) throw new Error("原图片不存在，请重新添加图片");
            source.onload = () => {
                if (!active) return;
                const sizeError = editorSizeError({ width: source.naturalWidth, height: source.naturalHeight });
                if (sizeError) {
                    setLoadError(`${sizeError}；请先缩小图片。`); return;
                }
                setImage(source);
            };
            source.onerror = () => { if (active) setLoadError("图片读取失败，可能已失效或不允许跨域读取。请重试，或下载后重新上传。"); };
            source.src = url;
        }).catch(error => { if (active) setLoadError(error instanceof Error ? error.message : "图片读取失败"); });
        return () => { active = false; source.onload = null; source.onerror = null; };
    }, [node, reload]);

    const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
        canvasRef.current = canvas;
        if (!image || !canvas) return;
        try { renderEditorDocument(canvas, image, operations); }
        catch (error) { setLoadError(error instanceof Error ? error.message : "图片渲染失败"); }
    }, [image, operations]);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const observer = new ResizeObserver(() => setStageSize({ width: stage.clientWidth, height: stage.clientHeight }));
        observer.observe(stage);
        return () => observer.disconnect();
    }, [image]);

    useEffect(() => () => { if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current); }, []);

    const clearPreview = () => {
        if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
        const canvas = overlayRef.current;
        canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        gestureRef.current = null;
        setMovingPreview(null);
    };
    const commit = (operation: ImageEditorOperation) => {
        uploadedRef.current = null;
        setHistory(current => ({ operations: [...current.operations.slice(0, current.cursor), operation], cursor: current.cursor + 1 }));
        clearPreview();
    };
    const travel = (direction: number) => {
        if (saving) return;
        clearPreview(); setSelection(null); setSelectedRectangle(null); setResizeDraft(null); uploadedRef.current = null;
        setHistory(current => ({ ...current, cursor: Math.max(0, Math.min(current.operations.length, current.cursor + direction)) }));
    };
    const applyResize = () => {
        if (!canResize || resizeWidth === null || resizeHeight === null) return;
        commit({ kind: "resize", width: resizeWidth, height: resizeHeight, mode: resizeMode });
        setResizeDraft(null); setSelection(null); setSelectedRectangle(null); setZoom(1);
    };
    const markFor = (gesture: Gesture): ImageEditorMark => {
        const style = { color, width: lineWidth, ...(selection ? { clip: selection } : {}) };
        if (gesture.tool === "brush") return { kind: "brush", points: gesture.points, ...style };
        return { kind: gesture.tool === "arrow" ? "arrow" : "rectangle", start: gesture.start, end: gesture.end, ...style };
    };
    const position = (event: PointerEvent<HTMLCanvasElement>) => editorPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), size);
    const hitRectangle = (point: EditorPoint) => rectangles.findLast(rect => point.x >= rect.x - 6 / scale && point.x <= rect.x + rect.width + 6 / scale && point.y >= rect.y - 6 / scale && point.y <= rect.y + rect.height + 6 / scale);
    const movingOperation = (gesture: Gesture) => editorRectangleMove(committedOperations, gesture.movingIndex!, { x: gesture.end.x - gesture.start.x, y: gesture.end.y - gesture.start.y }, { width: image!.naturalWidth, height: image!.naturalHeight });
    const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
        if (saving || !image || gestureRef.current || event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus();
        const point = position(event);
        if (tool === "rectangle" && !event.shiftKey) {
            const hit = hitRectangle(point);
            if (hit) {
                setSelectedRectangle(hit.index);
                gestureRef.current = { pointerId: event.pointerId, tool, start: point, end: point, points: [], movingIndex: hit.index };
                event.currentTarget.setPointerCapture(event.pointerId);
                return;
            }
        }
        setSelectedRectangle(null);
        if (tool === "text") {
            if (!text.trim()) { message.info("请先输入要添加的文字"); return; }
            commit({ kind: "text", at: point, text: text.trim(), fontSize, color, width: lineWidth, ...(selection ? { clip: selection } : {}) }); return;
        }
        if (tool === "select") setSelection(null);
        gestureRef.current = { pointerId: event.pointerId, tool, start: point, end: point, points: [point] };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
        const gesture = gestureRef.current;
        if (!gesture) { if (tool === "rectangle") setOverRectangle(Boolean(hitRectangle(position(event)))); return; }
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gesture.end = position(event);
        if (gesture.tool === "brush") gesture.points.push(gesture.end);
        if (previewFrameRef.current !== null) return;
        previewFrameRef.current = requestAnimationFrame(() => {
            previewFrameRef.current = null;
            const canvas = overlayRef.current, current = gestureRef.current;
            const context = canvas?.getContext("2d");
            if (!canvas || !context || !current) return;
            context.clearRect(0, 0, canvas.width, canvas.height);
            if (current.movingIndex !== undefined) { setMovingPreview(movingOperation(current)); return; }
            if (current.tool === "select" || current.tool === "mosaic") {
                const rect = editorRect(current.start, current.end, size);
                context.fillStyle = theme.canvas.selectionFill;
                context.strokeStyle = theme.canvas.selectionStroke;
                context.lineWidth = 1.5 / scale;
                context.setLineDash([6 / scale, 4 / scale]);
                context.fillRect(rect.x, rect.y, rect.width, rect.height);
                context.strokeRect(rect.x, rect.y, rect.width, rect.height);
                context.setLineDash([]);
            } else paintEditorMark(context, markFor(current));
        });
    };
    const pointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gesture.end = position(event);
        if (gesture.movingIndex !== undefined) {
            if (Math.hypot(gesture.end.x - gesture.start.x, gesture.end.y - gesture.start.y) > 1 / scale) commit(movingOperation(gesture));
        } else if (gesture.tool === "select" || gesture.tool === "mosaic") {
            if (Math.hypot(gesture.end.x - gesture.start.x, gesture.end.y - gesture.start.y) > 2 / scale) {
                const rect = editorRect(gesture.start, gesture.end, size);
                if (gesture.tool === "select") setSelection(rect);
                else commit({ kind: "mosaic", rect, blockSize: Math.max(4, lineWidth) });
            }
        } else {
            if (gesture.tool === "brush") gesture.points.push(gesture.end);
            commit(markFor(gesture));
            if (gesture.tool === "rectangle") setSelectedRectangle(history.cursor);
        }
        clearPreview();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };
    const cancel = () => {
        if (saving) return;
        if (!dirty) { onClose(); return; }
        modal.confirm({ title: "放弃这次图片编辑？", content: cancelDescription, okText: "放弃修改", cancelText: "继续编辑", onOk: onClose });
    };
    const save = () => run(async () => {
        if (!canvasRef.current || !dirty || gestureRef.current) return;
        if (!uploadedRef.current) uploadedRef.current = await uploadImage(await editorPngBlob(canvasRef.current));
        await onConfirm(uploadedRef.current);
        onClose();
        message.success(successMessage);
    });

    return <Modal title="编辑图片" open centered width="min(1280px, calc(100vw - 24px))" onCancel={cancel} closable={!saving} keyboard={!saving} maskClosable={false} destroyOnHidden
        styles={{ body: { maxHeight: "calc(100dvh - 160px)", overflow: "auto" } }}
        footer={<div className="flex flex-wrap items-center justify-between gap-3"><span style={{ color: theme.node.muted }} className="text-xs">{saveHint}</span><div className="flex gap-2"><Button disabled={saving} onClick={cancel}>取消</Button><Button type="primary" icon={<Check className="size-4" />} loading={saving} disabled={!image || !dirty || Boolean(loadError)} onClick={() => void save()}>确定并保存</Button></div></div>}>
        <div onKeyDown={event => {
            if ((event.target as Element).closest("input,textarea,[contenteditable=true]")) return;
            if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
                event.preventDefault(); event.stopPropagation(); travel(event.key.toLowerCase() === "y" || event.shiftKey ? 1 : -1);
            }
        }} style={{ color: theme.node.text }}>
            {loadError ? <Alert type="error" showIcon message={loadError} action={<Button size="small" onClick={() => setReload(value => value + 1)}>重试</Button>} /> : null}
            <div role="toolbar" aria-label="手动图片编辑工具" className="mb-3 flex flex-wrap items-center gap-2 border-b pb-3" style={{ borderColor: theme.node.stroke }}>
                {tools.map(item => <Button key={item.id} disabled={!image || saving} type={tool === item.id ? "primary" : "text"} aria-pressed={tool === item.id} icon={<item.icon className="size-4" />} onClick={() => { clearPreview(); setTool(item.id); }}>{item.label}</Button>)}
                <span className="mx-1 h-5 border-l" style={{ borderColor: theme.node.stroke }} />
                <Tooltip title="顺时针旋转 90°"><Button disabled={!image || saving} type="text" aria-label="顺时针旋转90度" icon={<RotateCw className="size-4" />} onClick={() => { commit({ kind: "rotate" }); setResizeDraft(null); setSelection(null); setZoom(1); }} /></Tooltip>
                <Tooltip title="撤销 Ctrl+Z"><Button disabled={!dirty || saving} type="text" aria-label="撤销图片编辑" icon={<Undo2 className="size-4" />} onClick={() => travel(-1)} /></Tooltip>
                <Tooltip title="重做 Ctrl+Shift+Z"><Button disabled={history.cursor >= history.operations.length || saving} type="text" aria-label="重做图片编辑" icon={<Redo2 className="size-4" />} onClick={() => travel(1)} /></Tooltip>
            </div>
            <div className="mb-3 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                {tool !== "select" && tool !== "mosaic" ? <label className="flex items-center gap-2">颜色<input type="color" aria-label="绘制颜色" value={color} disabled={saving} onChange={event => setColor(event.target.value)} className="h-7 w-9 cursor-pointer border-0 bg-transparent" /></label> : null}
                {tool !== "select" && tool !== "text" ? <label className="flex items-center gap-2">{tool === "mosaic" ? "色块" : "笔宽"}<Slider disabled={saving} className="!m-0 w-28" min={1} max={80} value={lineWidth} onChange={setLineWidth} /><span className="w-10 tabular-nums">{lineWidth}px</span></label> : null}
                {tool === "text" ? <><Input.TextArea aria-label="标注文字" autoSize={{ minRows: 1, maxRows: 3 }} maxLength={500} value={text} disabled={saving} onChange={event => setText(event.target.value)} placeholder="输入文字，再点击图片放置" className="!w-64 max-w-full" /><label className="flex items-center gap-2">字号<InputNumber aria-label="标注字号" disabled={saving} min={8} max={240} value={fontSize} onChange={value => setFontSize(value || 36)} /></label></> : null}
                {selection ? <><span>选区 {selection.width} × {selection.height}px</span><Button size="small" disabled={saving} icon={<Crop className="size-3.5" />} onClick={() => { commit({ kind: "crop", rect: selection }); setResizeDraft(null); setSelection(null); setZoom(1); }}>应用裁剪</Button><Button size="small" type="text" disabled={saving} onClick={() => setSelection(null)}>取消选区</Button></> : null}
                <span className="ml-auto" style={{ color: theme.node.muted }}>{image ? `${size.width} × ${size.height}px` : "读取图片中"}</span>
            </div>
            <div role="group" aria-label="自定义图片尺寸" className="mb-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                    <span>自定义尺寸</span>
                    <label className="flex items-center gap-2">宽度<InputNumber<number> aria-label="图片宽度（像素）" disabled={!image || saving} min={1} max={EDITOR_MAX_DIMENSION} step={1} changeOnBlur={false} value={resizeWidth} status={resizeError ? "error" : undefined} className="!w-24" onChange={value => setResizeDraft(current => ({ width: value, height: current ? current.height : size.height }))} onPressEnter={applyResize} /></label>
                    <span aria-hidden>×</span>
                    <label className="flex items-center gap-2">高度<InputNumber<number> aria-label="图片高度（像素）" disabled={!image || saving} min={1} max={EDITOR_MAX_DIMENSION} step={1} changeOnBlur={false} value={resizeHeight} status={resizeError ? "error" : undefined} className="!w-24" onChange={value => setResizeDraft(current => ({ width: current ? current.width : size.width, height: value }))} onPressEnter={applyResize} /></label>
                    <span>px</span>
                    <Select<EditorResizeMode> aria-label="尺寸适配方式" disabled={!image || saving} value={resizeMode} onChange={setResizeMode} className="!w-40" options={[{ value: "contain", label: "完整保留 · 透明留边" }, { value: "cover", label: "填满画面 · 居中裁剪" }, { value: "stretch", label: "拉伸变形" }]} />
                    <Button disabled={!canResize} onClick={applyResize}>应用尺寸</Button>
                </div>
                <div className="mt-1.5" style={{ color: theme.node.muted }}>{resizeMode === "contain" ? "保持比例，完整保留图片，空白处透明。" : resizeMode === "cover" ? "保持比例填满目标画面，居中裁去超出部分。" : "分别缩放宽高，图片和标记可能变形。"}最长边 8192px，总像素不超过 2500 万；仅本地编辑，不改变 AI 模型的生成尺寸限制。</div>
                {resizeError ? <Alert className="mt-2" type="error" showIcon message={resizeError} /> : null}
            </div>
            <div ref={stageRef} className="relative h-[min(56dvh,640px)] min-h-52 overflow-auto rounded-lg border" style={{ background: theme.canvas.background, borderColor: theme.node.stroke }}>
                {!image ? <div className="grid h-full place-items-center">{!loadError ? <Spin tip="读取原图" /> : <span style={{ color: theme.node.muted }}>暂时无法编辑此图片</span>}</div> : <div className="grid place-items-center" style={{ minWidth: "100%", minHeight: "100%", width: size.width * scale + 32, height: size.height * scale + 32 }}>
                    <div className="relative shrink-0" style={{ width: size.width * scale, height: size.height * scale, background: `repeating-conic-gradient(${theme.node.panel} 0% 25%, ${theme.node.stroke} 0% 50%) 0 / 16px 16px` }}>
                        <canvas ref={attachCanvas} aria-label="编辑图片预览" className="block size-full" />
                        <canvas ref={overlayRef} width={size.width} height={size.height} aria-label="图片编辑画布" tabIndex={0} className="absolute inset-0 size-full touch-none outline-none" style={{ cursor: tool === "text" ? "text" : tool === "rectangle" && overRectangle ? "move" : "crosshair", pointerEvents: saving ? "none" : "auto" }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={clearPreview} onLostPointerCapture={clearPreview} />
                        {selectedBounds ? <div aria-label="选中的矩形标注" className="pointer-events-none absolute border border-dashed" style={{ left: selectedBounds.x / size.width * 100 + "%", top: selectedBounds.y / size.height * 100 + "%", width: selectedBounds.width / size.width * 100 + "%", height: selectedBounds.height / size.height * 100 + "%", borderColor: theme.canvas.selectionStroke }} /> : null}
                        {selection ? <div className="pointer-events-none absolute border-2 border-dashed" style={{ left: selection.x / size.width * 100 + "%", top: selection.y / size.height * 100 + "%", width: selection.width / size.width * 100 + "%", height: selection.height / size.height * 100 + "%", borderColor: theme.canvas.selectionStroke }} /> : null}
                    </div>
                </div>}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: theme.node.muted }}><span className="max-w-3xl">{hints[tool]}</span><div className="flex shrink-0 items-center gap-1"><Button size="small" type="text" aria-label="缩小编辑预览" icon={<ZoomOut className="size-4" />} onClick={() => setZoom(value => Math.max(.25, value / 1.25))} /><span className="w-12 text-center tabular-nums">{Math.round(scale * 100)}%</span><Button size="small" type="text" aria-label="放大编辑预览" icon={<ZoomIn className="size-4" />} onClick={() => setZoom(value => Math.min(8, value * 1.25))} /><Button size="small" type="text" onClick={() => setZoom(1)}>适应画面</Button></div></div>
        </div>
    </Modal>;
}
