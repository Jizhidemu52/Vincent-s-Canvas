import { Modal, Segmented } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { SceneImage } from "./use-scene-workspace";

/** Repeat the actual returned tile so seams remain visible instead of being painted over. */
export function RepeatPreviewDialog({ image, arrangement = "straight", onClose }: { image: SceneImage; arrangement?: string; onClose: () => void }) {
    const [mode, setMode] = useState(arrangement);
    const ratio = image.width / image.height;
    return <Modal open title="检查真实拼接效果" onCancel={onClose} footer={null} width={800}>
        <div className="space-y-4"><Segmented value={mode} onChange={value => setMode(String(value))} options={[{ label: "直排", value: "straight" }, { label: "半落", value: "half-drop" }, { label: "半砖", value: "half-brick" }]} />
            <div className="relative overflow-hidden border border-[var(--border)]" style={{ aspectRatio: String(ratio), maxHeight: "65vh" }} aria-label="三乘三花型循环预览">
                {Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, col) => <img key={`${row}:${col}`} src={image.dataUrl} alt="" draggable={false} className="absolute" style={{ width: "33.3334%", height: "33.3334%", maxWidth: "none", left: `${(col - 1 + (mode === "half-brick" && row % 2 ? .5 : 0)) * 100 / 3}%`, top: `${(row - 1 + (mode === "half-drop" && col % 2 ? .5 : 0)) * 100 / 3}%` }} />))}
            </div>
            <p className="cs-help">这里直接重复模型返回的图像，不掩盖边缘。请检查左右、上下接缝与四角；明显接缝需要继续修整。原图下载保留单个花回。</p>
            <Link className="cs-tool-entry" to="/creative/pattern-repeat">进入花型循环工作台设置尺寸与排布 →</Link>
        </div>
    </Modal>;
}
