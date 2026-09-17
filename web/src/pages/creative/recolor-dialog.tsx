import { Alert, Button, Modal, Slider } from "antd";
import { useEffect, useRef, useState } from "react";
import { editorPngBlob } from "@/lib/canvas/image-editor-document";
import { canvasPixels, loadProcessingImage, pixelsCanvas } from "./image-processing-browser";
import { recolorPixels, rgbHex, suggestPalette, type PixelImage, type RecolorRule } from "./image-processing";
import type { SceneImage } from "./use-scene-workspace";

export function RecolorDialog({ source, onClose, onSave }: {
    source: SceneImage; onClose: () => void; onSave: (blob: Blob, description: string) => Promise<void>;
}) {
    const original = useRef<PixelImage | null>(null);
    const preview = useRef<HTMLCanvasElement>(null);
    const [small, setSmall] = useState<PixelImage | null>(null);
    const [palette, setPalette] = useState<string[]>([]);
    const [rules, setRules] = useState<RecolorRule[]>([]);
    const [active, setActive] = useState(0);
    const [tolerance, setTolerance] = useState(8);
    const [changed, setChanged] = useState(0);
    const [matched, setMatched] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let cancelled = false;
        void loadProcessingImage(source.dataUrl).then(canvas => {
            if (cancelled) return;
            const pixels = canvasPixels(canvas); original.current = pixels;
            const swatches = suggestPalette(pixels); setPalette(swatches);
            setRules([{ from: swatches[0] || "#000000", to: swatches[0] || "#000000" }]);
            const ratio = Math.min(1, 900 / Math.max(canvas.width, canvas.height));
            const reduced = document.createElement("canvas"); reduced.width = Math.max(1, Math.round(canvas.width * ratio)); reduced.height = Math.max(1, Math.round(canvas.height * ratio));
            const context = reduced.getContext("2d")!; context.imageSmoothingEnabled = false; context.drawImage(canvas, 0, 0, reduced.width, reduced.height);
            setSmall(canvasPixels(reduced));
        }).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : "图片读取失败"); });
        return () => { cancelled = true; original.current = null; };
    }, [source.dataUrl]);
    useEffect(() => {
        if (!small || !rules.length || !preview.current) return;
        try {
            const result = recolorPixels(small, rules, tolerance);
            preview.current.width = result.width; preview.current.height = result.height;
            preview.current.getContext("2d")!.drawImage(pixelsCanvas(result), 0, 0);
            setChanged(result.changedPixels); setMatched(result.matchedPixels); setError("");
        } catch (caught) { setChanged(0); setMatched(0); setError(caught instanceof Error ? caught.message : "颜色参数无效"); }
    }, [small, rules, tolerance]);
    const changeRule = (index: number, key: keyof RecolorRule, value: string) => setRules(current => current.map((rule, at) => at === index ? { ...rule, [key]: value.toUpperCase() } : rule));
    const save = async () => {
        if (!original.current || busy) return;
        setBusy(true); setError("");
        try {
            const result = recolorPixels(original.current, rules, tolerance);
            if (!result.changedPixels) throw new Error("没有发生颜色变化，请调整原色、目标色或容差");
            const description = `本地精确换色；${rules.map(rule => `${rule.from} → ${rule.to}`).join("，")}；RGB 容差 ${tolerance}%；改变 ${result.changedPixels} 个像素；保持尺寸与透明度。`;
            await onSave(await editorPngBlob(pixelsCanvas(result)), description); onClose();
        } catch (caught) { setError(caught instanceof Error ? caught.message : "换色保存失败"); }
        finally { setBusy(false); }
    };
    return <Modal open title="精确换色 · 本地处理" width={940} onCancel={onClose} closable={!busy} mask={{ closable: !busy }} keyboard={!busy}
        footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button type="primary" loading={busy} disabled={!small} onClick={() => void save()}>保存换色结果</Button></>}>
        <div className="cs-tool-dialog">
            <p className="cs-help">不调用 AI、不消耗生成积分。按 RGB 颜色替换，保留图案位置、原始尺寸与透明度。适合平面花型；相近颜色和抗锯齿边缘通过容差纳入，照片光影不会自动保留。</p>
            <fieldset disabled={busy || !small} className="cs-tool-fieldset">
                <div className="cs-recolor-rules">{rules.map((rule, index) => <div className="cs-recolor-rule" key={index}>
                    <button className="cs-choice" aria-pressed={active === index} onClick={() => setActive(index)}>取色 {index + 1}</button>
                    <label>原色<input aria-label={`原色 ${index + 1}`} type="color" value={/^#[\da-f]{6}$/i.test(rule.from) ? rule.from : "#000000"} onChange={event => changeRule(index, "from", event.target.value)} /><input className="cs-hex-input cs-input" aria-label={`原色 HEX ${index + 1}`} value={rule.from} maxLength={7} onChange={event => changeRule(index, "from", event.target.value)} /></label><span>→</span>
                    <label>目标色<input aria-label={`目标色 ${index + 1}`} type="color" value={/^#[\da-f]{6}$/i.test(rule.to) ? rule.to : "#000000"} onChange={event => changeRule(index, "to", event.target.value)} /><input className="cs-hex-input cs-input" aria-label={`目标色 HEX ${index + 1}`} value={rule.to} maxLength={7} onChange={event => changeRule(index, "to", event.target.value)} /></label>
                    <button aria-label={`删除颜色映射 ${index + 1}`} disabled={rules.length === 1} onClick={() => { setRules(current => current.filter((_, at) => at !== index)); setActive(0); }}>删除</button>
                </div>)}</div>
                <div className="cs-tool-controls"><Button disabled={rules.length >= 6 || busy || !small} onClick={() => { setActive(rules.length); setRules(current => [...current, { from: palette[current.length] || "#FFFFFF", to: "#224E42" }]); }}>添加映射</Button>
                    <span className="cs-help">参考色板：</span>{palette.map(color => <button key={color} aria-label={`选用原色 ${color}`} title={color} className="cs-swatch" style={{ background: color }} onClick={() => changeRule(active, "from", color)} />)}</div>
                <label className="cs-label">颜色容差 {tolerance}%<Slider min={0} max={100} value={tolerance} onChange={setTolerance} disabled={busy} /></label>
            </fieldset>
            {error && <Alert type="error" title={error} showIcon />}
            <div className="cs-tool-preview-grid"><figure><figcaption>原图 · 点击为第 {active + 1} 组取色</figcaption><img src={source.dataUrl} alt="换色原图（点击取色）" className="cs-sample-image" onClick={event => {
                if (!original.current || busy) return;
                const rect = event.currentTarget.getBoundingClientRect(), pixels = original.current;
                const x = Math.min(pixels.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) * pixels.width / rect.width)));
                const y = Math.min(pixels.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) * pixels.height / rect.height)));
                const offset = (y * pixels.width + x) * 4;
                if (!pixels.data[offset + 3]) { setError("当前点是完全透明像素，请选择有颜色的区域"); return; }
                changeRule(active, "from", rgbHex(Array.from(pixels.data.slice(offset, offset + 3)))); setError("");
            }} /></figure><figure><figcaption>换色预览</figcaption><canvas ref={preview} aria-label="换色预览" /></figure></div>
            <p className="cs-help">{small ? `缩略预览：匹配 ${matched.toLocaleString()} 个像素，改变 ${changed.toLocaleString()} 个像素。保存时在 ${source.width} × ${source.height} 原图上处理。` : "正在读取原图…"}</p>
        </div>
    </Modal>;
}
