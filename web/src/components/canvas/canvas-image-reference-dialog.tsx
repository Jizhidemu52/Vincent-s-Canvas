import { useUiText } from "@/lib/i18n";
import { Button, Checkbox, Empty, Modal, theme } from "antd";
import { useEffect, useMemo, useState } from "react";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useCanvasImageThumbnail } from "./use-canvas-image-thumbnail";

type Props = { open: boolean; nodes: CanvasNodeData[]; selectedReferenceKeys: string[]; onConfirm: (nodeIds: string[]) => void; onClose: () => void };

export function CanvasImageReferenceDialog({ open, nodes, selectedReferenceKeys, onConfirm, onClose }: Props) {
    const t = useUiText();
    const { token } = theme.useToken();
    const available = useMemo(() => nodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content)), [nodes]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const existingIds = useMemo(() => new Set(selectedReferenceKeys.map(key => key.replace(/^(?:node|canvas|connection|source):/, ""))), [selectedReferenceKeys]);
    const availableIds = useMemo(() => new Set(available.map(node => node.id)), [available]);
    const pendingIds = selectedIds.filter(id => availableIds.has(id) && !existingIds.has(id));
    const selected = new Set([...existingIds, ...pendingIds]);
    useEffect(() => { setSelectedIds([]); }, [open]);
    useEffect(() => {
        setSelectedIds(current => {
            const next = current.filter(id => availableIds.has(id) && !existingIds.has(id));
            return next.length === current.length ? current : next;
        });
    }, [availableIds, existingIds]);
    const close = () => { setSelectedIds([]); onClose(); };
    const toggle = (id: string) => {
        if (existingIds.has(id) || !availableIds.has(id)) return;
        setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    };
    return <Modal title={t("从画布选择参考图")} open={open} onCancel={close} destroyOnHidden footer={<div className="flex justify-end gap-2"><Button onClick={close}>{t("取消")}</Button><Button type="primary" disabled={!pendingIds.length} onClick={() => { onConfirm(pendingIds); setSelectedIds([]); }}>{t("加入参考图")}</Button></div>}>
        {available.length ? <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto p-0.5 sm:grid-cols-3">
            {available.map(node => {
                const title = node.title || "未命名图片";
                const added = existingIds.has(node.id);
                return <div key={node.id} className="relative overflow-hidden rounded-lg border" style={{ borderColor: selected.has(node.id) ? token.colorPrimary : token.colorBorder, background: token.colorBgContainer, boxShadow: selected.has(node.id) ? `0 0 0 2px ${token.colorPrimaryBorder}` : undefined }}>
                    <button type="button" className="block w-full text-left disabled:cursor-default" disabled={added} aria-label={`${added ? t("已添加") : t("选择参考图")} ${title}`} aria-pressed={selected.has(node.id)} onClick={() => toggle(node.id)}>
                        <CanvasReferenceThumbnail node={node} title={title} />
                        <span className="block truncate p-2 text-xs">{title}{added ? t(" · 已添加") : ""}</span>
                    </button>
                    <Checkbox aria-label={t("选择参考图 {value1}", { value1: title })} checked={selected.has(node.id)} disabled={added} className="absolute right-2 top-2" onChange={() => toggle(node.id)} />
                </div>;
            })}
        </div> : <Empty description={t("画布中暂无可用图片节点")} className="py-10" />}
    </Modal>;
}

function CanvasReferenceThumbnail({ node, title }: { node: CanvasNodeData; title: string }) {
    const t = useUiText();
    const preview = useCanvasImageThumbnail(node, 256);
    return preview.failed ? <span className="flex aspect-square items-center justify-center text-xs">{t("图片加载失败")}</span>
        : preview.url ? <img key={preview.key} src={preview.url} alt={title} loading="lazy" decoding="async" onError={preview.onError} className="aspect-square w-full object-cover" />
            : <span className="block aspect-square animate-pulse" aria-label={t("正在加载缩略图")} />;
}
