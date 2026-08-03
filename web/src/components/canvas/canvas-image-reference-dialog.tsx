import { Button, Checkbox, Empty, Modal } from "antd";
import { useMemo, useState } from "react";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Props = { open: boolean; nodes: CanvasNodeData[]; selectedReferenceKeys: string[]; onConfirm: (nodeIds: string[]) => void; onClose: () => void };

export function CanvasImageReferenceDialog({ open, nodes, selectedReferenceKeys, onConfirm, onClose }: Props) {
    const available = useMemo(() => nodes.filter((node) => node.type === CanvasNodeType.Image && Boolean(node.metadata?.content)), [nodes]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const selected = new Set([...selectedReferenceKeys.map((key) => key.replace(/^node:/, "")), ...selectedIds]);
    const toggle = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    return <Modal title="从画布选择参考图" open={open} onCancel={onClose} footer={<div className="flex justify-end gap-2"><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!selectedIds.length} onClick={() => { onConfirm(selectedIds); setSelectedIds([]); }}>加入参考图</Button></div>}>
        {available.length ? <div className="grid max-h-[55vh] grid-cols-3 gap-3 overflow-y-auto">
            {available.map((node) => <button key={node.id} type="button" className={`relative overflow-hidden rounded-lg border text-left ${selected.has(node.id) ? "border-blue-500 ring-2 ring-blue-200" : "border-stone-200"}`} onClick={() => toggle(node.id)}>
                <img src={node.metadata!.content} alt={node.title} className="aspect-square w-full object-cover" />
                <span className="block truncate p-2 text-xs">{node.title || "未命名图片"}</span>
                <Checkbox checked={selected.has(node.id)} className="absolute right-2 top-2" onClick={(event) => event.stopPropagation()} onChange={() => toggle(node.id)} />
            </button>)}
        </div> : <Empty description="画布中暂无可用图片节点" className="py-10" />}
    </Modal>;
}
