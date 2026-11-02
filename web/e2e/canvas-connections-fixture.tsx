import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { CanvasConnectionLayer } from "../src/components/canvas/canvas-connection-layer";
import { ConnectionPath } from "../src/components/canvas/canvas-connections";
import { canvasThemes } from "../src/lib/canvas-theme";
import { useThemeStore } from "../src/stores/use-theme-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";
import "../src/styles/globals.css";

const kinds = [undefined, "config-target", "generation-output", "config-sequence", "sequence-input", "generation-output"] as const;
const labels = ["参考输入", "公共配置", "生成结果", "步骤顺序", "序列输入", "反向生成结果"];
const nodes: CanvasNodeData[] = kinds.flatMap((_, index) => [
    { id: `from-${index}`, title: labels[index], type: CanvasNodeType.Text, position: { x: index === 5 ? 490 : 80, y: index === 5 ? 600 : 50 + index * 100 }, width: 120, height: 60 },
    { id: `to-${index}`, title: "目标", type: CanvasNodeType.Text, position: { x: index === 5 ? 80 : 490, y: index === 5 ? 600 : 50 + index * 100 }, width: 120, height: 60 },
]);
const connections: CanvasConnection[] = kinds.map((kind, index) => ({ id: `edge-${index}`, kind, fromNodeId: `from-${index}`, toNodeId: `to-${index}` }));
const byId = new Map(nodes.map(node => [node.id, node]));
const resolveNode = (id: string) => byId.get(id);

function Fixture() {
    const [scale, setScale] = useState(1);
    const [selected, setSelected] = useState("");
    const themeName = useThemeStore(state => state.theme);
    const theme = canvasThemes[themeName];
    return <main style={{ background: theme.canvas.background, color: theme.node.text, minHeight: "100vh", padding: 20 }}>
        <div style={{ display: "flex", gap: 20, marginBottom: 12 }}>
            <button onClick={() => useThemeStore.getState().setTheme(themeName === "light" ? "dark" : "light")}>切换主题</button>
            {[0.25, 0.5, 1, 2].map(value => <button key={value} onClick={() => setScale(value)}>{value * 100}%</button>)}
            <output data-testid="selection">{selected}</output><output data-testid="theme">{themeName}</output>
        </div>
        <div style={{ display: "flex", gap: 20 }}>
            {(["Canvas", "SVG"] as const).map(renderer => <section key={renderer}><h1>{renderer}</h1><div data-testid={renderer} style={{ position: "relative", width: 700, height: 740, overflow: "hidden", background: theme.canvas.background, border: `1px solid ${theme.node.stroke}` }}>
                {renderer === "Canvas" ? <CanvasConnectionLayer connections={connections} resolveNode={resolveNode} viewport={{ x: 0, y: 0, k: scale }} activeConnectionIds={new Set(selected ? [selected] : [])} affectedConnectionIds={new Set()} isDraggingNodes={false} onDrawFailure={() => { throw new Error("Unexpected draw failure"); }} /> : null}
                <div style={{ position: "absolute", inset: 0, transform: `scale(${scale})`, transformOrigin: "0 0", "--canvas-node-ui-scale": 1 / scale } as CSSProperties}>
                    {renderer === "SVG" ? <svg style={{ position: "absolute", overflow: "visible", width: 1, height: 1 }}>{connections.map(edge => <ConnectionPath key={edge.id} connection={edge} from={byId.get(edge.fromNodeId)!} to={byId.get(edge.toNodeId)!} active={selected === edge.id} onSelect={() => setSelected(edge.id)} />)}</svg> : null}
                    {nodes.map(node => <div key={node.id} style={{ position: "absolute", left: node.position.x, top: node.position.y, width: node.width, height: node.height, display: "grid", placeItems: "center", background: theme.node.panel, border: `1px solid ${theme.node.stroke}`, borderRadius: 8 }}>{node.title}</div>)}
                </div>
            </div></section>)}
        </div>
    </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
