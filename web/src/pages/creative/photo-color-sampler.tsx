import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { loadProcessingImage } from "./image-processing-browser";
import { rgbHex } from "./image-processing";
import "./photo-color-sampler.css";

type SamplePoint = { x: number; y: number };
type SampleSize = { width: number; height: number };

/** The image itself has no padding, border or object-fit letterboxing. */
export function photoSamplePoint(client: SamplePoint, bounds: SampleSize & { left: number; top: number }, size: SampleSize): SamplePoint | null {
    if (bounds.width <= 0 || bounds.height <= 0 || size.width < 1 || size.height < 1) return null;
    return {
        x: Math.max(0, Math.min(size.width - 1, Math.floor((client.x - bounds.left) * size.width / bounds.width))),
        y: Math.max(0, Math.min(size.height - 1, Math.floor((client.y - bounds.top) * size.height / bounds.height))),
    };
}

export function movePhotoSamplePoint(point: SamplePoint, size: SampleSize, key: string, precise = false): SamplePoint {
    const dx = precise ? 1 : Math.max(1, Math.round(size.width / 100));
    const dy = precise ? 1 : Math.max(1, Math.round(size.height / 100));
    return {
        x: Math.max(0, Math.min(size.width - 1, point.x + (key === "ArrowLeft" ? -dx : key === "ArrowRight" ? dx : 0))),
        y: Math.max(0, Math.min(size.height - 1, point.y + (key === "ArrowUp" ? -dy : key === "ArrowDown" ? dy : 0))),
    };
}

export function photoPixelHex(rgba: Uint8ClampedArray): string | null {
    return rgba.length >= 4 && rgba[3] > 0 ? rgbHex(Array.from(rgba.subarray(0, 3))) : null;
}

export function PhotoColorSampler({ src, onPick, disabled = false }: {
    src: string; onPick: (hex: string) => void; disabled?: boolean;
}) {
    const image = useRef<HTMLImageElement>(null);
    const helpId = useId();
    const [loaded, setLoaded] = useState<{ src: string; canvas: HTMLCanvasElement } | null>(null);
    const [failure, setFailure] = useState<{ src: string; message: string } | null>(null);
    const [point, setPoint] = useState<SamplePoint>({ x: 0, y: 0 });
    const [message, setMessage] = useState("");
    const canvas = loaded?.src === src ? loaded.canvas : null;
    const error = failure?.src === src ? failure.message : "";
    const ready = Boolean(canvas && !error);

    useEffect(() => {
        let cancelled = false;
        setLoaded(null); setFailure(null); setMessage("");
        void loadProcessingImage(src, 2048).then(value => {
            if (cancelled) return;
            setPoint({ x: Math.floor(value.width / 2), y: Math.floor(value.height / 2) });
            setLoaded({ src, canvas: value });
        }).catch(caught => {
            if (!cancelled) setFailure({ src, message: caught instanceof Error ? caught.message : "照片读取失败，请重新上传" });
        });
        return () => { cancelled = true; };
    }, [src]);

    const pick = (at: SamplePoint) => {
        if (disabled || !canvas || error) return;
        let hex: string | null;
        try {
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("当前浏览器无法读取照片颜色");
            hex = photoPixelHex(context.getImageData(at.x, at.y, 1, 1).data);
        } catch {
            setFailure({ src, message: "无法读取照片颜色，请重新上传本地图片" });
            return;
        }
        setPoint(at);
        if (!hex) { setMessage("此处为透明像素，请选择衣服上的其他位置"); return; }
        setMessage(`已取色 ${hex}，已用于查找相近色`);
        onPick(hex);
    };
    const click = (event: MouseEvent<HTMLButtonElement>) => {
        if (!canvas || !image.current) return;
        const at = event.detail === 0 ? point : photoSamplePoint({ x: event.clientX, y: event.clientY }, image.current.getBoundingClientRect(), canvas);
        if (at) pick(at);
    };
    const move = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!canvas || disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        setPoint(current => movePhotoSamplePoint(current, canvas, event.key, event.shiftKey));
        setMessage("");
    };

    return <div data-usage-board="photo-color-picker" className="cs-photo-sampler" aria-busy={!ready && !error}>
        <div className="cs-photo-sampler-heading">从衣服照片取色</div>
        {ready && canvas && <button type="button" className="cs-photo-sampler-image" disabled={disabled}
            aria-label="衣服照片取色" aria-describedby={helpId} onClick={click} onKeyDown={move}>
            <img ref={image} src={src} alt="已上传的衣服照片" draggable={false} />
            <span className="cs-photo-sampler-point" aria-hidden="true" style={{ left: `${(point.x + .5) / canvas.width * 100}%`, top: `${(point.y + .5) / canvas.height * 100}%` }} />
        </button>}
        <p id={helpId} className="cs-photo-sampler-help">点击衣服取色；方向键移动，Shift 精调，Enter 或空格取色。预览取色会受缩放和光照影响。</p>
        <p className="cs-photo-sampler-status" role={error ? "alert" : "status"}>
            {error || (!ready ? "正在读取照片…" : message || `取色位置：横向 ${point.x + 1}，纵向 ${point.y + 1}`)}
        </p>
    </div>;
}
