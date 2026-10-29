import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Input, Modal, type InputRef } from "antd";
import { canvasActionShortcut, type CanvasActionId } from "@/lib/canvas/canvas-actions";
import { canvasCommandCatalog, filterCanvasCommands } from "@/lib/canvas/canvas-command-catalog";
import { useNavigate, useParams } from "react-router-dom";
import { canvasActionModules } from "@/lib/canvas/tool-availability";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { canUserAccessAsset, useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { InsertAssetPayload } from "./asset-picker-modal";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasShortcutsDialog } from "./canvas-shortcuts-dialog";

export type CanvasCommandBindings = Partial<Record<CanvasActionId, { run: () => void; enabled?: boolean }>>;
export function CanvasCommandPalette({ nodes, bindings, onLocate, onAsset, onClose }: {
    nodes: CanvasNodeData[]; bindings: CanvasCommandBindings; onLocate: (ids: string[]) => void;
    onAsset: (asset: InsertAssetPayload) => void; onClose: () => void;
}) {
    const [query, setQuery] = useState("");
    const queryRef = useRef("");
    const deferredQuery = useDeferredValue(query);
    const [active, setActive] = useState(0);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const input = useRef<InputRef>(null);
    const assets = useAssetStore(state => state.assets);
    const user = useUserStore(state => state.user);
    const flags = useModuleStore(state => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const navigate = useNavigate(), { id } = useParams<{ id: string }>();
    const items = useMemo(() => {
        const actions = canvasCommandCatalog.flatMap(action => {
            const routes = { home: "/", projects: "/canvas", referenceImport: `/reference-import${id ? `?returnTo=${encodeURIComponent(`/canvas/${id}`)}` : ""}` };
            const binding = action.id in routes ? { run: () => navigate(routes[action.id as keyof typeof routes]) }
                : action.id === "theme" ? { run: () => { const state = useThemeStore.getState(); state.setTheme(state.theme === "light" ? "dark" : "light"); } }
                : action.id === "shortcuts" ? { run: () => setShortcutsOpen(true) } : bindings[action.id];
            const module = canvasActionModules[action.id];
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
        return [...actions, ...nodeItems, ...assetItems];
    }, [bindings, flags, tools, nodes, assets, user, onLocate, onAsset, id, navigate]);
    const matches = useMemo(() => filterCanvasCommands(items, deferredQuery).slice(0, 80), [items, deferredQuery]);
    useEffect(() => { document.getElementById(`canvas-command-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active]);
    // Rendering may lag, execution must not. Recheck even pointer selections
    // against the current query so an old visible row cannot run a wrong action.
    const currentMatches = () => queryRef.current === deferredQuery ? matches : filterCanvasCommands(items, queryRef.current).slice(0, 80);
    const execute = (index: number, clickedId?: string) => {
        const current = currentMatches();
        const item = clickedId ? current.find(item => item.id === clickedId) : current[Math.min(index, current.length - 1)];
        if (item) { if (item.id !== "shortcuts") onClose(); item.run(); }
    };
    if (shortcutsOpen) return <CanvasShortcutsDialog open onClose={onClose} />;
    return <Modal open title="命令与搜索" footer={null} centered width={620} onCancel={onClose} afterOpenChange={open => { if (open) input.current?.focus(); }}>
        <Input ref={input} value={query} placeholder="搜索命令、画布节点或本地素材…" aria-label="搜索命令、节点和素材" role="combobox" aria-expanded="true" aria-controls="canvas-command-results" aria-activedescendant={matches[active] ? `canvas-command-${active}` : undefined}
            onChange={event => { queryRef.current = event.target.value; setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const length = currentMatches().length; setActive(value => length ? (value + (event.key === "ArrowDown" ? 1 : -1) + length) % length : 0); }
                if (event.key === "Enter") { event.preventDefault(); execute(active); }
            }} />
        <div id="canvas-command-results" role="listbox" aria-label="搜索结果" aria-busy={query !== deferredQuery} className="cw-command-results">{matches.map((item, index) => <button id={`canvas-command-${index}`} key={item.id} type="button" role="option" aria-selected={active === index} onMouseEnter={() => setActive(index)} onClick={() => execute(index, item.id)}>
            <span><small>{item.category}</small>{item.label}</span><kbd>{item.shortcut}</kbd>
        </button>)}{!matches.length && <p role="status">没有匹配的可用操作或素材</p>}</div>
        <p className="cw-command-help">↑ ↓ 选择 · Enter 执行 · Esc 关闭 · 云端素材请打开“我的素材”</p>
    </Modal>;
}
