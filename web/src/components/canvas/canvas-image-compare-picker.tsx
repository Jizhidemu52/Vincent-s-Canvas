import { useState, type KeyboardEvent } from "react";
import { Input } from "antd";
import { Check, Search, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";
import { useCanvasImageThumbnail } from "./use-canvas-image-thumbnail";

export function canvasCompareImageLabel(node: CanvasNodeData) {
    return node.metadata?.imageName || node.metadata?.originalFileName || node.title || "未命名图片";
}

export function CanvasCompareThumbnail({ node }: { node: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const preview = useCanvasImageThumbnail(node, 256);
    const [failedUrl, setFailedUrl] = useState("");
    return <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-md" style={{ background: theme.node.fill, color: theme.node.muted }}>
        {preview.url && preview.url !== failedUrl ? <img src={preview.url} alt={canvasCompareImageLabel(node)} loading="lazy" draggable={false} className="h-full w-full object-contain" onError={() => setFailedUrl(preview.url)} /> : <span className="px-2 text-center text-xs">{failedUrl ? "缩略图不可用" : "暂无缩略图"}</span>}
    </span>;
}

function moveCandidateFocus(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-compare-candidate]"));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowLeft") next--;
    else if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const row = buttons.filter(button => direction * (button.offsetTop - buttons[index].offsetTop) > 0);
        const closest = row.sort((a, b) => Math.abs(a.offsetTop - buttons[index].offsetTop) - Math.abs(b.offsetTop - buttons[index].offsetTop) || Math.abs(a.offsetLeft - buttons[index].offsetLeft) - Math.abs(b.offsetLeft - buttons[index].offsetLeft))[0];
        if (closest) next = buttons.indexOf(closest);
    } else return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
}

/** Shared by the inline popover and full comparison dialog; all sizes are screen CSS pixels. */
export function CanvasImageComparePicker({ images, sourceIds = [], preferredId, selectedId, title = "选择对比原图", onChoose, onClose }: {
    images: CanvasNodeData[]; sourceIds?: string[]; preferredId?: string; selectedId?: string; title?: string;
    onChoose: (node: CanvasNodeData) => void; onClose: () => void;
}) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [query, setQuery] = useState("");
    const search = query.trim().toLocaleLowerCase();
    const matches = images.filter(node => [canvasCompareImageLabel(node), node.title, node.metadata?.originalFileName, node.metadata?.imageVersion ? `V${node.metadata.imageVersion}` : ""].some(text => text?.toLocaleLowerCase().includes(search)));
    const groups = [
        { title: preferredId ? "本次修改前 · 直接上版" : "本次输入来源 · 请确认", images: matches.filter(node => sourceIds.includes(node.id)) },
        { title: "其他画布图片", images: matches.filter(node => !sourceIds.includes(node.id)) },
    ];
    return <section data-canvas-no-zoom role="dialog" aria-label={title} className="text-sm" style={{ color: theme.node.text }}
        onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
        onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
        <div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-medium">{title}</h3><button type="button" aria-label="关闭图片选择" onClick={onClose} className="rounded p-1.5 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ outlineColor: theme.canvas.selectionStroke }}><X size={18} /></button></div>
        <Input autoFocus allowClear size="large" prefix={<Search size={17} />} aria-label="搜索对比图片" placeholder="搜索图片名称或版本" value={query} onChange={event => setQuery(event.target.value)} />
        <p className="my-2 text-xs" style={{ color: theme.node.muted }}>点击缩略图选择；也可用 Tab、方向键浏览，Enter / 空格确认。</p>
        <div className="max-h-[min(52dvh,460px)] overflow-y-auto overscroll-contain pr-1" onKeyDown={moveCandidateFocus}>
            {groups.map(group => group.images.length ? <div key={group.title} className="mb-4 last:mb-0">
                <h4 className="mb-2 text-xs font-medium" style={{ color: theme.node.muted }}>{group.title}</h4>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {group.images.map(node => {
                        const selected = node.id === selectedId, preferred = node.id === preferredId;
                        const label = canvasCompareImageLabel(node);
                        return <button key={node.id} type="button" data-compare-candidate={node.id} aria-label={`选择 ${label}${node.metadata?.imageVersion ? ` · V${node.metadata.imageVersion}` : ""}`} aria-pressed={selected} title={label} onClick={() => onChoose(node)}
                            className="min-w-0 rounded-lg border p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: selected ? theme.canvas.selectionStroke : theme.node.stroke, background: selected ? theme.canvas.selectionFill : theme.node.panel, outlineColor: theme.canvas.selectionStroke }}>
                            <span className="block h-32"><CanvasCompareThumbnail node={node} /></span>
                            <span className="mt-2 block line-clamp-2 min-h-10 break-all text-sm leading-5">{label}</span>
                            <span className="mt-1 flex min-h-5 flex-wrap items-center gap-x-2 text-xs" style={{ color: selected ? theme.node.text : theme.node.muted }}>
                                {selected ? <span className="inline-flex items-center gap-1"><Check size={13} />已选中</span> : preferred ? "默认上版" : node.metadata?.imageVersion ? `V${node.metadata.imageVersion}` : "图片"}
                                {node.metadata?.naturalWidth && node.metadata?.naturalHeight ? <span>{node.metadata.naturalWidth}×{node.metadata.naturalHeight}</span> : null}
                            </span>
                        </button>;
                    })}
                </div>
            </div> : null)}
            {!matches.length ? <p role="status" className="py-10 text-center" style={{ color: theme.node.muted }}>{images.length ? "没有匹配的图片，试试其他名称。" : "没有其他可比较的图片。"}</p> : null}
        </div>
    </section>;
}
