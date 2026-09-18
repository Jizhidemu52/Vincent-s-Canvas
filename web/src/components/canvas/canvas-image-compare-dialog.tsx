import { useEffect, useRef, useState } from "react";
import { App, Button, Modal, Segmented, Select, Slider, Spin } from "antd";
import { saveAs } from "file-saver";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasCompareImages, chooseCanvasComparePair, drawCanvasCompare, loadCanvasCompareImage, type CanvasCompareMode } from "@/lib/canvas/canvas-image-compare";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasImageCompareDialog({ nodes, initialIds, onClose }: { nodes: CanvasNodeData[]; initialIds: string[]; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { message } = App.useApp();
    const [pair, setPair] = useState<readonly [string, string]>(() => chooseCanvasComparePair(nodes, initialIds));
    const [mode, setMode] = useState<CanvasCompareMode>("slider");
    const [value, setValue] = useState(50);
    const [loaded, setLoaded] = useState<{ before: HTMLImageElement; after: HTMLImageElement } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const canvas = useRef<HTMLCanvasElement>(null);
    const images = canvasCompareImages(nodes);
    const before = images.find(node => node.id === pair[0]), after = images.find(node => node.id === pair[1]);
    useEffect(() => {
        let cancelled = false;
        setLoaded(null); setError(""); setLoading(false);
        if (!before || !after || before.id === after.id) return;
        setLoading(true);
        Promise.all([loadCanvasCompareImage(before), loadCanvasCompareImage(after)]).then(([beforeImage, afterImage]) => { if (!cancelled) setLoaded({ before: beforeImage, after: afterImage }); }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "图片加载失败"); }).finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [before, after]);
    useEffect(() => {
        if (!loaded || !canvas.current) return;
        try { drawCanvasCompare(canvas.current, loaded.before, loaded.after, mode, value, theme.node.fill, theme.node.text); } catch (error) { setError(error instanceof Error ? error.message : "合成失败"); }
    }, [loaded, mode, value, theme]);
    const exportImage = () => {
        if (!canvas.current || !loaded) return;
        try { canvas.current.toBlob(blob => { if (blob) saveAs(blob, `改款前后对比-${mode}.png`); else message.error("导出失败，请重试"); }, "image/png"); } catch { message.error("该图片来源不允许本地合成，请下载原图并重新上传后再试"); }
    };
    return <Modal open title="改款前后对比" width={1000} onCancel={onClose} footer={<Button onClick={exportImage} disabled={!loaded || Boolean(error)}>导出当前对比 PNG</Button>}>
        <p className="mb-3 text-sm opacity-70">得到：滑块、并排或叠加对比及 PNG 展示图（滑块/叠加 1000×1048，并排 1600×1048）。不改原图、不调用 AI，也不是自动质检。图片按原比例居中，不做配准；同名不同版本仅作默认候选，请确认前后图。</p>
        <div className="mb-3 flex flex-wrap items-center gap-3">
            {([0, 1] as const).map(index => <label key={index} className="flex min-w-0 flex-1 items-center gap-2"><span className="shrink-0">{index === 0 ? "改款前" : "改款后"}</span><Select aria-label={index === 0 ? "选择改款前图片" : "选择改款后图片"} className="min-w-40 flex-1" showSearch optionFilterProp="label" placeholder="从当前画布选择图片" value={pair[index] || undefined} options={images.filter(node => node.id !== pair[1 - index]).map(node => ({ value: node.id, label: `${node.metadata?.imageName || node.title} · V${node.metadata?.imageVersion || 1} · ${node.id.slice(-4)}` }))} onChange={id => setPair(current => index === 0 ? [id, current[1]] : [current[0], id])} /></label>)}
            <Button onClick={() => setPair(([a, b]) => [b, a])}>交换前后</Button>
        </div>
        <Segmented value={mode} onChange={value => setMode(value as CanvasCompareMode)} options={[{ label: "滑块", value: "slider" }, { label: "并排", value: "side" }, { label: "叠加", value: "overlay" }]} />
        {mode !== "side" ? <div className="mt-2 flex items-center gap-3"><span className="text-xs">{mode === "slider" ? "分割位置" : "改款后透明度"}</span><Slider className="flex-1" value={value} onChange={setValue} tooltip={{ formatter: value => `${value}%` }} aria-label={mode === "slider" ? "分割位置" : "改款后透明度"} /></div> : null}
        <div className="mt-3 flex min-h-48 items-center justify-center overflow-hidden rounded-lg" style={{ background: theme.node.fill, color: theme.node.text }}>
            {loading ? <Spin /> : error ? <p role="alert">{error}</p> : !loaded ? <p className="p-6 text-sm opacity-70">请选择两张不同的图片；没有同源版本时，可从画布手动选择第二张。</p> : null}
            <canvas ref={canvas} aria-label="改款前后对比预览" style={{ display: loaded && !error ? "block" : "none", maxWidth: "100%", maxHeight: "52vh", objectFit: "contain" }} />
        </div>
    </Modal>;
}
