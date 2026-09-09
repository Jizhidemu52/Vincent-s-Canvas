import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Empty, Input, Modal, Progress, Radio, theme } from "antd";
import { ArrowDown, ArrowUp, FileDown } from "lucide-react";

import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { canvasImageExportStem } from "@/lib/canvas/canvas-image-filename";
import { CANVAS_IMAGE_PDF_LIMITS, canvasImageExportSelection, createCanvasImagePdfExport, type CanvasImagePdfMode, type CanvasImagePdfProgress } from "@/lib/canvas/canvas-image-pdf";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasImagePdfDialogProps = { nodes: CanvasNodeData[]; defaultSelectedIds?: string[]; defaultName?: string; defaultMode?: CanvasImagePdfMode; onClose: () => void };

export function CanvasImagePdfDialog({ nodes, defaultSelectedIds = [], defaultName = "图片集", defaultMode = "merged", onClose }: CanvasImagePdfDialogProps) {
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const available = useMemo(() => canvasImageExportSelection(nodes), [nodes]);
    const byId = useMemo(() => new Map(available.map((node) => [node.id, node])), [available]);
    const initialIds = canvasImageExportSelection(nodes, defaultSelectedIds).map((node) => node.id);
    const [selectedIds, setSelectedIds] = useState<string[]>(() => initialIds.length ? initialIds : available.map((node) => node.id));
    const [setName, setSetName] = useState(defaultName);
    const [mode, setMode] = useState<CanvasImagePdfMode>(defaultMode);
    const [busy, setBusy] = useState(false);
    const exporting = useRef(false);
    const active = useRef(true);
    const [error, setError] = useState("");
    const [progress, setProgress] = useState<CanvasImagePdfProgress | null>(null);
    const chosenIds = selectedIds.filter((id) => byId.has(id));
    const chosen = new Set(chosenIds);
    const ordered = [...chosenIds.map((id) => byId.get(id)!), ...available.filter((node) => !chosen.has(node.id))];
    const overLimit = chosenIds.length > CANVAS_IMAGE_PDF_LIMITS.images;

    useEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, []);

    const toggle = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    const move = (id: string, delta: number) => setSelectedIds((current) => {
        const next = current.filter((value) => byId.has(value));
        const from = next.indexOf(id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= next.length) return next;
        [next[from], next[to]] = [next[to], next[from]];
        return next;
    });
    const exportPdf = async () => {
        if (exporting.current) return;
        exporting.current = true;
        setBusy(true);
        setError("");
        try {
            const { saveAs } = await import("file-saver");
            const result = await createCanvasImagePdfExport({ nodes: chosenIds.map((id) => byId.get(id)!), setName, mode, onProgress: (value) => { if (active.current) setProgress(value); } });
            if (!active.current) return;
            saveAs(result.blob, result.fileName);
            void message.success(`已导出 ${result.imageCount} 张图片：${result.fileName}`);
            onClose();
        } catch (cause) {
            if (active.current) setError(cause instanceof Error ? cause.message : "图片集导出失败，请重试");
        } finally {
            exporting.current = false;
            if (active.current) {
                setBusy(false);
                setProgress(null);
            }
        }
    };

    return (
        <Modal title="导出图片集" open onCancel={onClose} closable={!busy} keyboard={!busy} mask={{ closable: !busy }} width={720} centered destroyOnHidden footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
                <span style={{ color: token.colorTextSecondary }} className="text-sm">{chosenIds.length} 张图片 · {mode === "merged" ? "1 个多页 PDF" : mode === "separate" ? `${chosenIds.length} 个单页 PDF（ZIP）` : "原图 ZIP"}</span>
                <div className="flex gap-2"><Button onClick={onClose} disabled={busy}>取消</Button><Button type="primary" icon={<FileDown size={16} />} loading={busy} disabled={!chosenIds.length || !setName.trim() || overLimit} onClick={() => void exportPdf()}>导出并下载</Button></div>
            </div>
        }>
            <div className="space-y-4 py-2">
                <label className="block space-y-2"><span className="text-sm font-medium">图片集名称</span><Input aria-label="图片集名称" value={setName} maxLength={100} disabled={busy} onChange={(event) => setSetName(event.target.value)} placeholder="例如：秋冬印花方案" /></label>
                <Radio.Group aria-label="图片集导出方式" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value)} className="flex flex-wrap gap-2" options={[{ value: "merged", label: "合并多页 PDF" }, { value: "separate", label: "每张一个 PDF（ZIP）" }, { value: "images", label: "原图（ZIP）" }]} />
                <p className="text-xs leading-5" style={{ color: token.colorTextSecondary }}>按下方编号导出，勾选后可上移或下移。{mode === "images" ? "保留原始图片格式与文件内容，按图片名称和版本命名，不压缩画质。" : "每张图独占一页，保持原图比例、不裁切；按 96 px = 72 pt 设置页面（超长图等比缩放）。PNG/JPEG 直接嵌入，其他格式转为静态 PNG。"}</p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">图片与导出顺序</span>
                    <div className="flex flex-wrap gap-1"><Button size="small" type="text" disabled={busy || !available.length} onClick={() => setSelectedIds([...chosenIds, ...available.filter((node) => !chosen.has(node.id)).map((node) => node.id)])}>全选</Button><Button size="small" type="text" disabled={busy || !initialIds.length} onClick={() => setSelectedIds(initialIds)}>仅画布已选</Button><Button size="small" type="text" disabled={busy || !chosenIds.length} onClick={() => setSelectedIds([])}>清空</Button></div>
                </div>
                {available.length ? <div className="max-h-[38vh] space-y-1 overflow-y-auto pr-1" role="list" aria-label="图片导出顺序">
                    {ordered.map((node) => {
                        const index = chosenIds.indexOf(node.id);
                        const name = canvasImageExportStem(node);
                        return <div key={node.id} role="listitem" className="flex items-center gap-3 rounded-lg px-2 py-2" style={{ background: chosen.has(node.id) ? token.controlItemBgActive : token.colorFillQuaternary }}>
                            <Checkbox aria-label={`选择 ${name}`} checked={chosen.has(node.id)} disabled={busy} onChange={() => toggle(node.id)} />
                            <span className="w-5 shrink-0 text-center text-xs tabular-nums" style={{ color: token.colorTextSecondary }}>{index >= 0 ? index + 1 : "—"}</span>
                            <CanvasPersistedMediaPreview kind="image" url={node.metadata?.content} storageKey={node.metadata?.storageKey} alt={name} className="size-12 shrink-0 rounded object-contain" />
                            <span className="min-w-0 flex-1 truncate text-sm" title={name}>{name}</span>
                            <div className="flex shrink-0"><Button size="small" type="text" title="上移" aria-label={`上移 ${name}`} icon={<ArrowUp size={15} />} disabled={busy || index <= 0} onClick={() => move(node.id, -1)} /><Button size="small" type="text" title="下移" aria-label={`下移 ${name}`} icon={<ArrowDown size={15} />} disabled={busy || index < 0 || index === chosenIds.length - 1} onClick={() => move(node.id, 1)} /></div>
                        </div>;
                    })}
                </div> : <Empty description="画布中暂无可导出的图片" />}
                <p className="text-xs" style={{ color: token.colorTextSecondary }}>每批最多 200 张、原图总大小 256 MB{mode !== "images" && "，单张最多 2000 万像素"}。逐张处理，导出不修改画布原图。</p>
                {overLimit && <Alert type="warning" showIcon title="每批最多导出 200 张图片，请减少选择" />}
                {error && <Alert type="error" showIcon title="未完成导出" description={error} />}
                {progress && <div aria-live="polite"><Progress percent={Math.round(progress.completed / progress.total * 100)} status="active" /><p className="truncate text-xs" title={progress.label}>{progress.label}</p></div>}
            </div>
        </Modal>
    );
}
