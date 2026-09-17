import { Alert, Button, Modal, Segmented, Slider } from "antd";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { editorPngBlob } from "@/lib/canvas/image-editor-document";
import { canvasPixels, loadProcessingImage } from "./image-processing-browser";
import { selectionHasPixels } from "./image-processing";
import type { SceneImage } from "./use-scene-workspace";

export function RegionSelectionDialog({ source, initialMask, onClose, onSave }: {
    source: SceneImage; initialMask?: string; onClose: () => void; onSave: (mask: Blob) => Promise<void>;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const last = useRef<{ x: number; y: number } | null>(null);
    const [size, setSize] = useState({ width: source.width, height: source.height });
    const [ready, setReady] = useState(false);
    const [brush, setBrush] = useState(6);
    const [mode, setMode] = useState<string | number>("涂选");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const original = await loadProcessingImage(source.dataUrl);
                const mask = initialMask ? await loadProcessingImage(initialMask) : null;
                if (cancelled || !canvas.current) return;
                canvas.current.width = original.width; canvas.current.height = original.height;
                setSize({ width: original.width, height: original.height });
                if (mask) {
                    if (mask.width !== original.width || mask.height !== original.height) throw new Error("已有选区尺寸不匹配，请关闭后清除选区");
                    canvas.current.getContext("2d")!.drawImage(mask, 0, 0);
                }
                setReady(true);
            } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : "原图读取失败"); }
        })();
        return () => { cancelled = true; };
    }, [source.dataUrl, initialMask]);
    const point = (event: PointerEvent<HTMLCanvasElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return { x: (event.clientX - rect.left) * size.width / rect.width, y: (event.clientY - rect.top) * size.height / rect.height };
    };
    const stroke = (next: { x: number; y: number }) => {
        const context = canvas.current?.getContext("2d");
        if (!context || !last.current) return;
        context.globalCompositeOperation = mode === "擦除" ? "destination-out" : "source-over";
        context.strokeStyle = "#2A77F6"; context.fillStyle = "#2A77F6";
        context.lineWidth = Math.min(size.width, size.height) * brush / 100;
        context.lineCap = "round"; context.lineJoin = "round";
        context.beginPath(); context.moveTo(last.current.x, last.current.y); context.lineTo(next.x, next.y); context.stroke();
        context.beginPath(); context.arc(next.x, next.y, context.lineWidth / 2, 0, Math.PI * 2); context.fill();
        last.current = next;
    };
    const save = async () => {
        if (!canvas.current || !ready || saving) return;
        setError(""); setSaving(true);
        try {
            if (!selectionHasPixels(canvasPixels(canvas.current))) throw new Error("请先涂选需要修改的区域");
            await onSave(await editorPngBlob(canvas.current)); onClose();
        } catch (caught) { setError(caught instanceof Error ? caught.message : "选区保存失败"); }
        finally { setSaving(false); }
    };
    return <Modal open title="涂选修改区域" onCancel={onClose} width={820} closable={!saving} mask={{ closable: !saving }} keyboard={!saving}
        footer={<><Button onClick={onClose} disabled={saving}>取消</Button><Button type="primary" onClick={() => void save()} loading={saving} disabled={!ready}>保存选区</Button></>}>
        <div className="cs-tool-dialog">
            <p className="cs-help">蓝色区域交给 AI 修改，选区外在最终合成时保留原图像素。请覆盖完整待改部位并留出衔接空间；它不是模型原生蒙版，选区内的结构与接缝仍需检查。</p>
            <div className="cs-tool-controls"><Segmented options={["涂选", "擦除"]} value={mode} onChange={setMode} disabled={saving} />
                <label className="cs-brush-control">笔刷 {brush}%<Slider min={1} max={25} value={brush} onChange={setBrush} disabled={saving} /></label>
                <Button disabled={!ready || saving} onClick={() => canvas.current?.getContext("2d")?.clearRect(0, 0, size.width, size.height)}>清空</Button></div>
            {error && <Alert type="error" title={error} showIcon />}
            <div className="cs-selection-stage" style={{ aspectRatio: `${size.width}/${size.height}`, maxWidth: Math.min(720, 460 * size.width / size.height) }}>
                <img src={source.dataUrl} alt="待修改原图" draggable={false} />
                <canvas ref={canvas} aria-label="修改区域画布" style={{ opacity: .55, pointerEvents: ready && !saving ? "auto" : "none" }}
                    onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); last.current = point(event); stroke(last.current); }}
                    onPointerMove={event => { if (last.current) stroke(point(event)); }}
                    onPointerUp={() => { last.current = null; }} onPointerCancel={() => { last.current = null; }} onLostPointerCapture={() => { last.current = null; }} />
            </div>
            {!ready && !error && <p className="cs-help">正在读取原图…</p>}
        </div>
    </Modal>;
}
