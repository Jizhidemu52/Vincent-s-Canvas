import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Modal, type InputRef } from "antd";
import { canvasActionShortcut, filterCanvasCommands, type CanvasActionId } from "@/lib/canvas/canvas-actions";
import { canvasCommandCatalog } from "@/lib/canvas/canvas-command-catalog";
import { canvasActionModules } from "@/lib/canvas/tool-availability";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canUserAccessAsset, useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { InsertAssetPayload } from "./asset-picker-modal";

export type CanvasCommandBindings = Partial<Record<CanvasActionId, { run: () => void; enabled?: boolean }>>;
export function CanvasCommandPalette({ nodes, bindings, onLocate, onAsset, onClose }: {
    nodes: CanvasNodeData[]; bindings: CanvasCommandBindings; onLocate: (ids: string[]) => void;
    onAsset: (asset: InsertAssetPayload) => void; onClose: () => void;
}) {
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const input = useRef<InputRef>(null);
    const assets = useAssetStore(state => state.assets);
    const user = useUserStore(state => state.user);
    const flags = useModuleStore(state => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const matches = useMemo(() => {
        const actions = canvasCommandCatalog.flatMap(action => {
            const binding = bindings[action.id];
            const module = canvasActionModules[action.id] || (action.id === "group" ? "canvas-local-tools" : undefined);
            if (!binding || module && !isModuleAvailable(flags, tools, module)) return [];
            return [{ ...action, enabled: binding.enabled, category: "命令", shortcut: canvasActionShortcut(action.id), run: binding.run }];
        });
        const typeLabels: Record<string, string> = { text: "文本", image: "图片", video: "视频", audio: "音频", config: "生成配置" };
        const nodeItems = nodes.map(node => ({ id: `node:${node.id}`, label: node.title || "未命名节点", keywords: `${node.type} ${typeLabels[node.type] || ""} ${node.metadata?.imageName || ""} ${node.type === "text" ? (node.metadata?.content || "").slice(0, 500) : ""}`, category: "画布节点", shortcut: "定位", run: () => onLocate([node.id]) }));
        const assetItems = assets.filter(asset => canUserAccessAsset(asset, user)).map(asset => ({ id: `asset:${asset.id}`, label: asset.title, keywords: asset.tags.join(" "), category: "本地素材", shortcut: "插入", run: () => {
            const current = useAssetStore.getState().assets.find(item => item.id === asset.id);
            if (!current || !canUserAccessAsset(current, useUserStore.getState().user)) return;
            onAsset(current.kind === "text" ? { kind: "text", title: current.title, content: current.data.content } : current.kind === "image" ? { kind: "image", title: current.title, ...current.data } : { kind: "video", title: current.title, ...current.data });
        } }));
        return filterCanvasCommands([...actions, ...nodeItems, ...assetItems], query).slice(0, 80);
    }, [query, bindings, flags, tools, nodes, assets, user, onLocate, onAsset]);
    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => { document.getElementById(`canvas-command-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active]);
    const execute = (index: number) => { const item = matches[index]; if (item) { onClose(); item.run(); } };
    return <Modal open title="命令与搜索" footer={null} centered width={620} onCancel={onClose} afterOpenChange={open => { if (open) input.current?.focus(); }}>
        <Input ref={input} value={query} placeholder="搜索命令、画布节点或本地素材…" aria-label="搜索命令、节点和素材" role="combobox" aria-expanded="true" aria-controls="canvas-command-results" aria-activedescendant={matches[active] ? `canvas-command-${active}` : undefined}
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setActive(value => matches.length ? (value + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0); }
                if (event.key === "Enter") { event.preventDefault(); execute(Math.min(active, matches.length - 1)); }
            }} />
        <div id="canvas-command-results" role="listbox" aria-label="搜索结果" className="cw-command-results">{matches.map((item, index) => <button id={`canvas-command-${index}`} key={item.id} type="button" role="option" aria-selected={active === index} onMouseEnter={() => setActive(index)} onClick={() => execute(index)}>
            <span><small>{item.category}</small>{item.label}</span><kbd>{item.shortcut}</kbd>
        </button>)}{!matches.length && <p role="status">没有匹配的可用操作或素材</p>}</div>
        <p className="cw-command-help">↑ ↓ 选择 · Enter 执行 · Esc 关闭 · 云端素材请打开“我的素材”</p>
    </Modal>;
}
